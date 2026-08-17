import { prisma } from "./prisma";
import { eachDayOfInterval, addDays } from "date-fns";
import { calculateOverlapDays } from "./hut-leader-overlap";
import { formatDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "./lodges";
import { acquireLodgeCapacityLock } from "./lodge-capacity-lock";
import { loadHutLeaderLookaheadDays } from "./lodge-settings";
import { loadEffectiveModuleFlags } from "./module-settings";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import logger from "./logger";

/** One adult member's stay on the day being considered. */
type AdultStay = {
  id: string;
  checkIn: Date;
  checkOut: Date;
  lodgeId: string | null;
};

/**
 * Auto-assign hut leaders when only 1 adult member is booked for a date, PER
 * LODGE (#2887): each lodge is decided on its own roll and behind its own key.
 * Uses the configured lookahead, finds lodge-nights without an assignment, and
 * auto-assigns if exactly 1 distinct adult member is staying AT THAT LODGE.
 * No-op when the Hut leaders module is disabled.
 */
export async function autoAssignHutLeaders(): Promise<{
  assignedCount: number;
  assignedDates: string[];
}> {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.hutLeaders) {
    return { assignedCount: 0, assignedDates: [] };
  }

  const lookAheadDays = await loadHutLeaderLookaheadDays();
  const today = getTodayDateOnly();
  const endDate = addDays(today, lookAheadDays);
  const days = eachDayOfInterval({ start: today, end: endDate });

  const assignedDates: string[] = [];
  // Resolved at most once, and only if some booking is missing a lodge id
  // (expand-release tolerance); never used to WIDEN a scope, only to name one.
  let defaultLodgeId: string | null = null;

  for (const day of days) {
    /*
      #2887: there is no club-wide gate left in this job.

      A `hutLeaderAssignment.findFirst` with no lodge filter used to sit here
      and `continue` before anything else ran, so ANY lodge having a leader on
      12 Aug suppressed 12 Aug at EVERY lodge — and it short-circuited ahead of
      the locked block below, which made that block's lodge scoping unreachable
      in exactly the case it was added for. The already-assigned check is now
      per lodge, and it is asked twice: cheaply here to skip most days without
      paying for a lock, and authoritatively again under the key.
    */
    // Find distinct adult members with PAID bookings for this date
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);

    const bookingsForDate = await prisma.booking.findMany({
      where: {
        status: "PAID",
        checkIn: { lte: day },
        checkOut: { gt: day },
        guests: {
          some: {
            ageTier: "ADULT",
            isMember: true,
            memberId: { not: null },
            stayStart: { lte: day },
            stayEnd: { gt: day },
            ...OPERATIONALLY_PRESENT_GUEST_WHERE,
          },
        },
      },
      select: {
        lodgeId: true,
        guests: {
          where: {
            ageTier: "ADULT",
            isMember: true,
            memberId: { not: null },
            stayStart: { lte: day },
            stayEnd: { gt: day },
            // Owner decision D-12 (#2307): a member whose own consent to being
            // added as a guest has not been given is not operationally present,
            // and must never be auto-made hut leader off the back of that row.
            // BOTH sites matter: the `some` decides whether the booking is
            // considered at all, and this `where` decides who is counted — and
            // this job only assigns when there is EXACTLY ONE adult member, so
            // an unconsented row left in either place would silently change the
            // outcome for the consented member standing next to them.
            ...OPERATIONALLY_PRESENT_GUEST_WHERE,
          },
          select: {
            memberId: true,
            stayStart: true,
            stayEnd: true,
            // Names are no longer selected: they were read only to be logged
            // (INV-PRIV-011, #2683), and not fetching them is the strongest
            // form of not leaking them.
            member: { select: { id: true, active: true } },
          },
        },
      },
    });

    // Collect distinct active adult members.
    //
    // INV-PRIV-011 (#2683): the member's composed name is deliberately NOT
    // carried here. It existed only to be logged, and this job runs nightly
    // across every lodge night, so it wrote a stream of members' full names into
    // the application log on a completely ordinary success path. The member id
    // identifies the assignment for anyone reading the log.
    const adultMembers = new Map<string, AdultStay>();

    for (const booking of bookingsForDate) {
      for (const guest of booking.guests) {
        if (guest.memberId && guest.member && guest.member.active && !adultMembers.has(guest.memberId)) {
          adultMembers.set(guest.memberId, {
            id: guest.memberId,
            checkIn: guest.stayStart,
            checkOut: guest.stayEnd,
            lodgeId: booking.lodgeId,
          });
        }
      }
    }

    /*
      #2887: "exactly one adult member" is a PER-LODGE question.

      Counting across the whole club meant one adult at Lodge A and one at
      Lodge B read as two, and neither lodge got a leader — the job was
      lodge-scoped in one place out of four. Each lodge is now decided on its
      own roll.
    */
    const byLodge = new Map<string, AdultStay[]>();
    for (const member of adultMembers.values()) {
      const lodgeId = member.lodgeId ?? defaultLodgeId ?? (defaultLodgeId = await getDefaultLodgeId(prisma));
      const bucket = byLodge.get(lodgeId);
      if (bucket) bucket.push(member);
      else byLodge.set(lodgeId, [member]);
    }

    for (const [lodgeId, lodgeAdults] of byLodge) {
      if (lodgeAdults.length !== 1) continue;
      const member = lodgeAdults[0];

      // The cheap ask: is this lodge already covered on this day? Re-asked
      // under the key below, which is the answer that counts.
      const alreadyAssigned = await prisma.hutLeaderAssignment.findFirst({
        where: {
          startDate: { lte: day },
          endDate: { gte: day },
          ...lodgeNullTolerantScope(lodgeId),
        },
        select: { id: true },
      });
      if (alreadyAssigned) continue;

    /*
      #2887: the overlap read and the insert are ONE serialized decision, under
      the same per-lodge key the interactive POST and PUT take.

      Both were wrong here before. The read ran on `prisma` outside any
      transaction and the create followed it unlocked, so this cron could race
      an admin (or a second cron container) and both insert — leaving one lodge
      two hut leaders for a night, with no unique constraint behind it. And the
      read was not lodge-scoped at all, so an assignment at a DIFFERENT lodge
      suppressed an auto-assignment that should have gone ahead.
    */
      try {
        const created = await prisma.$transaction(async (tx) => {
        await acquireLodgeCapacityLock(tx, lodgeId);

        // Authoritative re-ask of the cheap check above: another container or
        // an admin may have covered this lodge-night since.
        const lockedAssigned = await tx.hutLeaderAssignment.findFirst({
          where: {
            startDate: { lte: day },
            endDate: { gte: day },
            ...lodgeNullTolerantScope(lodgeId),
          },
          select: { id: true },
        });
        if (lockedAssigned) return false;

        const potentialOverlaps = await tx.hutLeaderAssignment.findMany({
          where: {
            startDate: { lte: member.checkOut },
            endDate: { gte: member.checkIn },
            ...lodgeNullTolerantScope(lodgeId),
          },
        });
        for (const existing of potentialOverlaps) {
          const overlapDays = calculateOverlapDays(
            member.checkIn,
            member.checkOut,
            existing.startDate,
            existing.endDate
          );
          if (overlapDays > 1) return false;
        }

        await tx.hutLeaderAssignment.create({
          data: {
            memberId: member.id,
            startDate: member.checkIn,
            endDate: member.checkOut,
            lodgeId,
          },
        });
        return true;
      });

      if (!created) continue;

      const dateStr = formatDateOnly(day);
      assignedDates.push(dateStr);
      logger.info(
        { memberId: member.id, lodgeId, date: dateStr },
        "Auto-assigned hut leader"
      );
      } catch (err) {
        logger.error({ err, memberId: member.id, lodgeId }, "Failed to auto-assign hut leader");
      }
    }
  }

  return { assignedCount: assignedDates.length, assignedDates };
}
