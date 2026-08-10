import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS,
  automaticallyRefundedManualRefundTaskFilter,
} from "@/lib/deleted-booking-modification-payment";

/**
 * GET /api/admin/payments/manual-refund-tasks
 *
 * B5 (#2262): the open hand-back queue for cancelled cash-settled bookings.
 * Read-only, so finance:view is enough; closing a task is the finance:edit
 * sibling route.
 *
 * TWO LISTS SINCE #2750, and the second one has nothing to do. `tasks` is the
 * work: OPEN rows an operator has to settle by hand. `autoRefunded` is the
 * record: rows the Stripe webhook already closed itself because it had refunded
 * the capture, which the operator can only read. They are returned together
 * rather than from two endpoints because they render as two cards on one screen
 * from one load, and a second round trip would buy nothing.
 *
 * Both are `take`-bounded and neither paginates, matching the pre-existing
 * behaviour of this route: it is a queue card, not a dataset surface.
 *
 * THE SECOND LIST CANNOT TAKE THE FIRST DOWN WITH IT (#2750 review). One
 * `Promise.all` rejection rejects the whole batch, the client blanks both lists
 * on a non-OK answer, and the OPEN list is money the club still owes members by
 * hand — so a failure of the informational query would have removed the
 * actionable queue from the screen. The failure mode is specific to the new
 * query rather than hypothetical: `note: { startsWith }` is an unindexed
 * `LIKE 'prefix%'` scan over the DISMISSED slice, so it is the one of the two
 * that can time out as the table grows. It is therefore caught on its own,
 * answered as an empty list with `autoRefundedUnavailable: true`, and logged.
 * The flag matters as much as the fallback: an empty list means "no automatic
 * refunds", and a degraded read must not be allowed to say that.
 */
/**
 * An informational list that degrades to "unavailable" rather than rejecting the
 * batch carrying the actionable queue beside it (#2750 review).
 *
 * Generic over the row so the empty fallback keeps the query's own type — a bare
 * `[]` in a `.catch` widens to `never[]` and makes the result unmappable — and
 * returning the flag beside the rows is what stops the caller forgetting it: an
 * empty list and a failed read look identical on screen, and on a refund notice
 * that difference is the entire point of the card.
 */
function readOrDegrade<T>(
  query: Promise<T[]>,
  what: string,
): Promise<{ rows: T[]; unavailable: boolean }> {
  return query.then(
    (rows) => ({ rows, unavailable: false }),
    (err: unknown) => {
      logger.error(
        { err },
        `Failed to read the ${what} for the finance queue; the hand-back queue is answered without them`,
      );
      return { rows: [], unavailable: true };
    },
  );
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const bookingSummary = {
    checkIn: true,
    checkOut: true,
    member: { select: { firstName: true, lastName: true } },
  } as const;

  /*
    An INSTANT window, not a calendar day, which is why it reads the raw clock
    rather than the club's calendar. `INV-DATE-019` governs deriving "today" as a
    `yyyy-MM-dd` day — the mistake it forbids is turning an instant into a UTC
    day string, which lands on the previous NZ day all morning. Nothing here is
    turned into a day: `completedAt` is a `DateTime` and this compares it against
    a `DateTime` thirty times twenty-four hours ago. Sending it through
    `getTodayDateOnly()` would make the window's edge depend on the time of day
    the page was opened, which is worse rather than better.
  */
  const noticesSince = new Date(
    Date.now() - AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  const [tasks, autoRefundedRead] = await Promise.all([
    prisma.manualRefundTask.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: {
        id: true,
        bookingId: true,
        amountCents: true,
        reason: true,
        createdAt: true,
        booking: { select: bookingSummary },
      },
    }),
    /*
      #2750. Newest first, and oldest-first would be wrong here for the same
      reason it is right above: the OPEN queue is worked from the top, whereas
      this is "what happened lately" and the most recent automatic refund is the
      one an operator can still act on if the deletion was the mistake.
    */
    readOrDegrade(
      prisma.manualRefundTask.findMany({
        where: {
          ...automaticallyRefundedManualRefundTaskFilter,
          completedAt: { gte: noticesSince },
        },
        orderBy: { completedAt: "desc" },
        /*
          The same 100 as the queue above, on purpose. The card prints its own
          length as a count, so a tighter `take` would silently make that count a
          lie about a money movement the moment a club had more of them than the
          limit — and the honest bound here is the thirty-day window, not a row
          cap. A club with 100 of these inside a month has a problem it needs to
          see in full.
        */
        take: 100,
        select: {
          id: true,
          bookingId: true,
          amountCents: true,
          reason: true,
          note: true,
          completedAt: true,
          booking: { select: bookingSummary },
        },
      }),
      "automatically refunded late-capture notices",
    ),
  ]);

  return NextResponse.json({
    tasks: tasks.map((task) => ({
      id: task.id,
      bookingId: task.bookingId,
      amountCents: task.amountCents,
      reason: task.reason,
      createdAt: task.createdAt.toISOString(),
      memberName: `${task.booking.member.firstName} ${task.booking.member.lastName}`,
      checkIn: task.booking.checkIn.toISOString(),
      checkOut: task.booking.checkOut.toISOString(),
    })),
    // True only when the notices read itself failed. The surface says so in a
    // line of its own rather than showing an empty card, because "no automatic
    // refunds in the last 30 days" is a claim about money and a failed query is
    // not entitled to make it.
    autoRefundedUnavailable: autoRefundedRead.unavailable,
    autoRefunded: autoRefundedRead.rows.map((task) => ({
      id: task.id,
      bookingId: task.bookingId,
      amountCents: task.amountCents,
      reason: task.reason,
      note: task.note,
      // `completedAt` is nullable in the schema but never null on a row this
      // filter matched — the close writes it in the same update as the status.
      // Answered as null rather than coerced, so the surface renders a row whose
      // date it cannot state instead of inventing one.
      refundedAt: task.completedAt ? task.completedAt.toISOString() : null,
      memberName: `${task.booking.member.firstName} ${task.booking.member.lastName}`,
      checkIn: task.booking.checkIn.toISOString(),
      checkOut: task.booking.checkOut.toISOString(),
    })),
  });
}
