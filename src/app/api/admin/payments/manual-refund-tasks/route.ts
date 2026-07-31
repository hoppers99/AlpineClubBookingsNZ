import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/admin/payments/manual-refund-tasks
 *
 * B5 (#2262): the open hand-back queue for cancelled cash-settled bookings.
 * Read-only, so finance:view is enough; closing a task is the finance:edit
 * sibling route.
 */
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const tasks = await prisma.manualRefundTask.findMany({
    where: { status: "OPEN" },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      id: true,
      bookingId: true,
      amountCents: true,
      reason: true,
      createdAt: true,
      booking: {
        select: {
          checkIn: true,
          checkOut: true,
          member: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

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
  });
}
