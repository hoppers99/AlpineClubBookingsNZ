import { prisma } from "./prisma";
import { eachDayOfInterval, addDays } from "date-fns";
import { calculateOverlapDays } from "./hut-leader-overlap";
import { formatDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { lodgeNullTolerantScope } from "./lodges";
import { loadHutLeaderLookaheadDays } from "./lodge-settings";
import { loadEffectiveModuleFlags } from "./module-settings";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import logger from "./logger";

/**
 * Auto-assign hut leaders when only 1 adult member is booked for a date.
 * Uses the configured lookahead, finds dates without an assignment, and
 * auto-assigns if exactly 1 distinct adult member is staying. No-op when the
 * Hut leaders module is disabled.
 *
 * Runs per (lodge, night), never club-wide (#2915). Each lodge has its own hut
 * leader — the same rule the admin route states — so every decision here is
 * taken within one lodge: whether the night is already covered, who is present
 * to be chosen, whether "exactly one adult member" holds, and whether an
 * existing assignment overlaps. Pooling any of them across lodges silently
 * under-assigns: one lodge's leader used to silence every other lodge for that
 * night, and two lodges each with exactly one eligible adult summed to two, so
 * neither of them got a leader.
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

  // Active lodges only — an archived lodge is out of service and should not be
  // rostered. Same read shape as cron-capacity-warnings.
  const activeLodges = await prisma.lodge.findMany({
    where: { active: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  for (const lodge of activeLodges) {
    for (const day of days) {
      // Check if there's already an assignment for this date AT THIS LODGE.
      const existingAssignment = await prisma.hutLeaderAssignment.findFirst({
        where: {
          startDate: { lte: day },
          endDate: { gte: day },
          ...lodgeNullTolerantScope(lodge.id),
        },
      });

      if (existingAssignment) continue;

      // Find distinct adult members with PAID bookings for this date at this
      // lodge. Scoped, so the "exactly one adult member" test below counts the
      // people actually at THIS lodge rather than pooling every lodge's guests.
      const nextDay = new Date(day);
      nextDay.setDate(nextDay.getDate() + 1);

      const bookingsForDate = await prisma.booking.findMany({
        where: {
          status: "PAID",
          checkIn: { lte: day },
          checkOut: { gt: day },
          ...lodgeNullTolerantScope(lodge.id),
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
      const adultMembers = new Map<string, {
        id: string;
        checkIn: Date;
        checkOut: Date;
      }>();

      for (const booking of bookingsForDate) {
        for (const guest of booking.guests) {
          if (guest.memberId && guest.member && guest.member.active && !adultMembers.has(guest.memberId)) {
            adultMembers.set(guest.memberId, {
              id: guest.memberId,
              checkIn: guest.stayStart,
              checkOut: guest.stayEnd,
            });
          }
        }
      }

      // Only auto-assign if exactly 1 adult member is at THIS lodge that night.
      if (adultMembers.size !== 1) continue;

      const [, member] = [...adultMembers.entries()][0];

      // Overlap validation, per lodge for the same reason the admin route is:
      // an assignment at another lodge is not a conflict here.
      const potentialOverlaps = await prisma.hutLeaderAssignment.findMany({
        where: {
          startDate: { lte: member.checkOut },
          endDate: { gte: member.checkIn },
          ...lodgeNullTolerantScope(lodge.id),
        },
      });

      let hasInvalidOverlap = false;
      for (const existing of potentialOverlaps) {
        const overlapDays = calculateOverlapDays(
          member.checkIn,
          member.checkOut,
          existing.startDate,
          existing.endDate
        );
        if (overlapDays > 1) {
          hasInvalidOverlap = true;
          break;
        }
      }

      if (hasInvalidOverlap) continue;

      // Create the assignment against the lodge this iteration decided for. The
      // booking read above is scoped to it, so `member.lodgeId` is this lodge —
      // using `lodge.id` states that directly instead of re-deriving it, and
      // removes the default-lodge fallback that a club-wide loop needed.
      try {
        await prisma.hutLeaderAssignment.create({
          data: {
            memberId: member.id,
            startDate: member.checkIn,
            endDate: member.checkOut,
            lodgeId: lodge.id,
          },
        });

        const dateStr = formatDateOnly(day);
        assignedDates.push(dateStr);
        logger.info(
          { memberId: member.id, date: dateStr, lodgeId: lodge.id },
          "Auto-assigned hut leader"
        );
      } catch (err) {
        logger.error({ err, memberId: member.id }, "Failed to auto-assign hut leader");
      }
    }
    }

  return { assignedCount: assignedDates.length, assignedDates };
}
