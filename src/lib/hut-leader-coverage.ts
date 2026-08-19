import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { countActiveGuestsForNight } from "@/lib/booking-guest-stay-ranges";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import {
  loadHutLeaderLookaheadDays,
  normalizeHutLeaderLookaheadDays,
  type LodgeSettingsReader,
} from "@/lib/lodge-settings";
import { prisma } from "@/lib/prisma";

/**
 * ONE UNCOVERED LODGE-NIGHT, never a bare calendar night (#2917).
 *
 * Each lodge runs its own hut leader, so "this night needs a leader" is only ever
 * true *of a lodge*. A night on which two lodges are both uncovered is therefore
 * two rows — same `date`, different `lodgeId` — and `bookingCount`/`guestCount`
 * describe that lodge alone. Merging them, as this result did before, told an
 * officer a number without telling them where to send anyone, and the auto-assign
 * cron had already been made per (lodge, night) by #2915/#2916; this is the read
 * side agreeing with the writer side.
 *
 * A single-lodge club sees exactly what it saw before: one row per uncovered
 * night, with the same counts.
 */
export interface UnassignedHutLeaderDate {
  date: string;
  /**
   * The lodge that is uncovered. Null only if a booking row carries no lodge,
   * which the schema's non-null `Booking.lodgeId` should make unreachable — it is
   * tolerated rather than assumed so a legacy row cannot throw a dashboard.
   */
  lodgeId: string | null;
  /** For display; callers must not use it as an identity (see the Presentation Rule). */
  lodgeName: string | null;
  bookingCount: number;
  guestCount: number;
}

type HutLeaderBooking = {
  lodgeId: string | null;
  lodge?: { name: string } | null;
  checkIn: Date;
  checkOut: Date;
  guests?: Array<{
    stayStart?: Date | null;
    stayEnd?: Date | null;
    nights?: Array<{ stayDate: Date }> | null;
  }> | null;
  _count?: {
    guests?: number;
  };
};

type HutLeaderCoverageDb = LodgeSettingsReader & {
  booking: {
    findMany(args: unknown): Promise<HutLeaderBooking[]>;
  };
  hutLeaderAssignment: {
    findMany(args: unknown): Promise<
      Array<{ lodgeId: string | null; startDate: Date; endDate: Date }>
    >;
  };
};

/** Ordinal string comparison. Never localeCompare: a locale must not be able to
 * reorder an API response, and an ICU build difference between two servers would
 * do exactly that. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type HutLeaderCoverageScope =
  | { kind: "lodge"; lodgeId: string }
  | { kind: "all" };

export async function getUnassignedHutLeaderDates(input: {
  db?: HutLeaderCoverageDb;
  lookAheadDays?: number;
  today?: Date;
  // Explicit date-only window. When BOTH are supplied they replace the
  // today→today+lookahead window (used to paint a calendar month, including
  // past nights for history). When absent, behaviour is exactly as before.
  from?: Date;
  to?: Date;
  // Interactive pages must name one lodge. Club dashboards opt into `all`
  // explicitly, so omission can never widen a lodge read by accident.
  scope: HutLeaderCoverageScope;
}): Promise<UnassignedHutLeaderDate[]> {
  const db = input.db ?? (prisma as unknown as HutLeaderCoverageDb);
  const today = input.today ?? getTodayDateOnly();

  const hasWindow = input.from != null && input.to != null;
  let windowStart: Date;
  let endDate: Date;
  if (hasWindow) {
    windowStart = input!.from!;
    endDate = input!.to!;
  } else {
    const lookAheadDays =
      input.lookAheadDays ?? (await loadHutLeaderLookaheadDays(db));
    windowStart = today;
    endDate = addDaysDateOnly(
      today,
      normalizeHutLeaderLookaheadDays(lookAheadDays),
    );
  }

  const [assignments, bookings] = await Promise.all([
    db.hutLeaderAssignment.findMany({
      where: {
        ...(input.scope.kind === "lodge"
          ? { lodgeId: input.scope.lodgeId }
          : {}),
        startDate: { lte: endDate },
        endDate: { gte: windowStart },
      },
      select: { lodgeId: true, startDate: true, endDate: true },
    }),
    db.booking.findMany({
      where: {
        ...(input.scope.kind === "lodge"
          ? { lodgeId: input.scope.lodgeId }
          : // A club-wide read reports only ACTIVE lodges (#2917). An archived
            // lodge can never be covered — the auto-assign cron iterates
            // `{ active: true }` (#2915/#2916) and the admin workspace can only
            // select an active lodge — so reporting it would leave a permanently
            // amber row no officer is able to action. The `lodge` scope needs no
            // such filter: its callers resolve the id through
            // resolveOptionalActiveLodgeId first.
            { lodge: { active: true } }),
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        deletedAt: null,
        checkIn: { lte: endDate },
        checkOut: { gt: windowStart },
      },
      select: {
        lodgeId: true,
        // Named on the row so a club-wide caller can say WHICH lodge without a
        // second query; every row is produced by a booking, so the relation is
        // always loaded where a row exists.
        lodge: { select: { name: true } },
        checkIn: true,
        checkOut: true,
        guests: {
          select: {
            stayStart: true,
            stayEnd: true,
            nights: { select: { stayDate: true } },
          },
        },
      },
    }),
  ]);

  function isDateCovered(date: Date, lodgeId: string | null): boolean {
    return assignments.some(
      (assignment) =>
        assignment.lodgeId === lodgeId &&
        assignment.startDate.getTime() <= date.getTime() &&
        assignment.endDate.getTime() >= date.getTime(),
    );
  }

  type LodgeNightStats = {
    lodgeId: string | null;
    lodgeName: string | null;
    bookingCount: number;
    guestCount: number;
  };

  /**
   * The uncovered lodges on one night, keyed by lodge.
   *
   * The trigger condition per lodge is UNCHANGED from the club-wide version: an
   * operational booking occupying that night, at a lodge with no assignment
   * covering it, carrying at least one operationally present guest. Only the
   * grouping changed — the counts are now banked per lodge instead of summed
   * across all of them.
   */
  function getBookingStatsByLodge(date: Date): Map<string, LodgeNightStats> {
    const byLodge = new Map<string, LodgeNightStats>();

    for (const booking of bookings) {
      if (isDateCovered(date, booking.lodgeId)) {
        continue;
      }
      if (
        booking.checkIn.getTime() > date.getTime() ||
        booking.checkOut.getTime() <= date.getTime()
      ) {
        continue;
      }

      const legacyGuestCount = booking._count?.guests ?? 0;
      const activeGuestCount = Array.isArray(booking.guests)
        ? countActiveGuestsForNight(booking.guests, date, booking)
        : legacyGuestCount;

      if (activeGuestCount <= 0) {
        continue;
      }

      // "" is the key for a lodge-less legacy row — distinct from every cuid,
      // and it keeps such rows grouped together rather than one row each.
      const key = booking.lodgeId ?? "";
      const stats = byLodge.get(key) ?? {
        lodgeId: booking.lodgeId ?? null,
        lodgeName: booking.lodge?.name ?? null,
        bookingCount: 0,
        guestCount: 0,
      };
      stats.bookingCount++;
      stats.guestCount += activeGuestCount;
      byLodge.set(key, stats);
    }

    return byLodge;
  }

  const unassignedDates: UnassignedHutLeaderDate[] = [];

  for (
    let day = windowStart;
    day.getTime() <= endDate.getTime();
    day = addDaysDateOnly(day, 1)
  ) {
    const date = formatDateOnly(day);
    // Deterministic order: date ascending (the loop), then lodge name, then
    // lodge id as the tie-break so two lodges sharing a name never swap places
    // between calls.
    const lodgeNights = [...getBookingStatsByLodge(day).values()].sort(
      (left, right) =>
        compare(left.lodgeName ?? "", right.lodgeName ?? "") ||
        compare(left.lodgeId ?? "", right.lodgeId ?? ""),
    );

    for (const lodgeNight of lodgeNights) {
      unassignedDates.push({ date, ...lodgeNight });
    }
  }

  return unassignedDates;
}

/**
 * True when a coverage result names more than one lodge.
 *
 * Club-wide surfaces use it to satisfy the multi-lodge Presentation Rule
 * (ADR-002): a single-lodge club is never shown a lodge name it cannot act on,
 * and a multi-lodge club is never shown a bare date it cannot place.
 */
export function coverageSpansMultipleLodges(
  rows: readonly UnassignedHutLeaderDate[],
): boolean {
  return new Set(rows.map((row) => row.lodgeId)).size > 1;
}
