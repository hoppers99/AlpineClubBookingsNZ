import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
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
 */
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

  const noticesSince = new Date(
    Date.now() - AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  const [tasks, autoRefunded] = await Promise.all([
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
    prisma.manualRefundTask.findMany({
      where: {
        ...automaticallyRefundedManualRefundTaskFilter,
        completedAt: { gte: noticesSince },
      },
      orderBy: { completedAt: "desc" },
      take: 20,
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
    autoRefunded: autoRefunded.map((task) => ({
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
