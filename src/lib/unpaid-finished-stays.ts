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
 * The MONEY half of the owed test, in memory: the `Payment` clause inside
 * `buildAdditionalOwedWhere` above, and nothing else. An upward modification
 * delta was recorded and the money has not arrived — PENDING, FAILED
 * (abandoned / declined) and a null status on a legacy row all mean uncollected;
 * only SUCCEEDED means it was collected.
 *
 * It is deliberately only HALF the owed test. Every queue and every chase must
 * ALSO test the booking's lifecycle status, because a cancelled booking keeps
 * its delta columns unchanged and would otherwise read as still owing. This
 * half is split out for the ONE caller where the status half is constant by
 * construction: the manual cash / off-Xero mark-paid (#2397,
 * `prepareManualSettlement` in src/lib/payment-reconciliation.ts) always lands
 * the booking on PAID, which is in `ADDITIONAL_OWED_BOOKING_STATUSES`, so the
 * settle only has to ask whether the money arrived.
 *
 * MERGE POINT with #2386 (issue #2350): that PR introduces
 * `isAdditionalPaymentOwed({ bookingStatus, payment })` in
 * `src/lib/additional-payment-chase.ts`, which is this predicate conjoined with
 * the booking-status half. When the two land together it MUST be implemented as
 * `isAdditionalOwedBookingStatus(bookingStatus) &&
 * isAdditionalAmountUncollected(payment)` rather than restating the columns, so
 * the codebase keeps exactly one money-half and this call site cannot drift from
 * the chase it is meant to silence.
 */
export function isAdditionalAmountUncollected<
  T extends {
    additionalAmountCents: number;
    additionalPaymentStatus: string | null;
  },
>(payment: T | null | undefined): payment is T {
  if (!payment) return false;
  return (
    payment.additionalAmountCents > 0 &&
    payment.additionalPaymentStatus !== "SUCCEEDED"
  );
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
