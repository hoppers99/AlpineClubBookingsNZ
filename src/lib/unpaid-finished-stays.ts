import type { Prisma } from "@prisma/client";

/**
 * Unpaid finished stays (#1709): bookings still PAYMENT_PENDING whose
 * check-out is on or before NZ today — the stay is over but payment is still
 * owing. Retroactive card creates (#1704) match from the moment of creation;
 * organic bookings that cross check-out unpaid surface here too.
 *
 * Single source of truth for the predicate and deep link shared by the admin
 * dashboard attention card and the sidebar Needs Attention badge (#1731);
 * keep every surface on these helpers so the queues can never drift.
 *
 * This module stays free of runtime Prisma/server imports so the client-side
 * admin sidebar can consume the href builder directly.
 */
export function buildUnpaidFinishedStaysWhere(
  today: Date,
): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    status: "PAYMENT_PENDING",
    checkOut: { lte: today },
  };
}

/**
 * Deep link to the bookings list pre-filtered to the same queue via the
 * Check Out range filter. `todayKey` is the NZ date-only key (YYYY-MM-DD).
 */
export function buildUnpaidFinishedStaysHref(todayKey: string): string {
  return `/admin/bookings?status=PAYMENT_PENDING&checkOutTo=${todayKey}`;
}

/**
 * Settled-lifecycle statuses that can carry an unsettled upward modification
 * delta without being PAYMENT_PENDING (which the primary predicate above
 * already counts — keeping the sets disjoint means the two queue counts can
 * be summed without double-counting a booking). COMPLETED matters most: the
 * completion cron advances PAID bookings once their check-out day has passed
 * (#2029), so a finished paid stay has usually already left PAID by the time
 * its delta lingers.
 */
const ADDITIONAL_OWED_BOOKING_STATUSES = [
  "CONFIRMED",
  "PAID",
  "COMPLETED",
] as const;

/**
 * Booking-level fragment for "an upward modification delta is still owed on
 * the card additional-payment flow" (#1723 path 2). Mirrors the member-facing
 * owed predicate (member-dashboard / booking detail / additional-payment-secret):
 * the payment summary columns track the LATEST ADDITIONAL transaction, and any
 * state other than SUCCEEDED — PENDING, FAILED (abandoned/auto-cancelled), or
 * a null status on legacy rows — means the recorded price increase was never
 * collected. Composed with AND by the bookings-list `additionalOwed` filter so
 * it cannot clobber explicit admin filter choices.
 */
export function buildAdditionalOwedWhere(): Prisma.BookingWhereInput {
  return {
    status: { in: [...ADDITIONAL_OWED_BOOKING_STATUSES] },
    payment: {
      is: {
        additionalAmountCents: { gt: 0 },
        OR: [
          { additionalPaymentStatus: null },
          { additionalPaymentStatus: { not: "SUCCEEDED" } },
        ],
      },
    },
  };
}

/**
 * Unsettled finished-stay additions (#1723 path 2): a settled (usually PAID or
 * COMPLETED) booking whose stay has ended but whose upward modification delta
 * was never collected. The booking is not PAYMENT_PENDING, so the primary
 * unpaid-finished-stays predicate never counts it — without this second
 * predicate it is the one silently lingering card obligation.
 *
 * Shared by the admin dashboard attention card, the sidebar Needs Attention
 * badge, and the bookings-list deep link, same drift rule as above.
 */
export function buildUnsettledAdditionalFinishedStaysWhere(
  today: Date,
): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    checkOut: { lte: today },
    ...buildAdditionalOwedWhere(),
  };
}

/**
 * Deep link to the bookings list pre-filtered to the same queue via the
 * `additionalOwed` filter plus the Check Out range filter.
 */
export function buildUnsettledAdditionalFinishedStaysHref(
  todayKey: string,
): string {
  return `/admin/bookings?additionalOwed=owed&checkOutTo=${todayKey}`;
}

/**
 * Unsettled additions on a stay that has NOT finished yet (#2350): the same
 * uncollected upward modification delta, but on a booking whose check-out is
 * still ahead. Counting only finished stays meant the club found out about the
 * money after the guests had gone home; this is the half that can still be
 * chased while the member is paying attention (the reminder cron emails them,
 * src/lib/cron-additional-payment-reminders.ts).
 *
 * Deliberately DISJOINT from the finished predicate above (`checkOut > today`
 * against its `checkOut <= today`), so the two counts can be shown side by side,
 * or summed for one badge, without double-counting a booking.
 */
export function buildUnsettledAdditionalUpcomingStaysWhere(
  today: Date,
): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    checkOut: { gt: today },
    ...buildAdditionalOwedWhere(),
  };
}

/**
 * Deep link covering BOTH halves of the unsettled-additions queue — every
 * booking with an uncollected addition, whenever it stays. Used by the sidebar
 * badge and the dashboard card, whose split label ("N upcoming, M finished")
 * names the two halves while the one link shows all of them; the bookings list
 * has no "upcoming only" filter to deep-link to, and inventing one to express a
 * split the list already sorts by check-out would be the worse trade.
 */
export function buildUnsettledAdditionalStaysHref(): string {
  return "/admin/bookings?additionalOwed=owed";
}
