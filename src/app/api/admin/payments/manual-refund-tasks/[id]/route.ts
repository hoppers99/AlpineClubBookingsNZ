import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import {
  ManualBookingPaymentError,
  MANUAL_PAYMENT_NOTE_MAX,
  resolveManualRefundTask,
} from "@/lib/manual-booking-payment";

const bodySchema = z
  .object({
    resolution: z.enum(["completed", "dismissed"]),
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX).optional().nullable(),
    // Explicit confirmation so closing a money task is never a single-click
    // accident, matching the mark-paid route.
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/payments/manual-refund-tasks/[id]
 *
 * B5 (#2262). Close a hand-back task raised when a cash-settled booking was
 * cancelled: "completed" means the money genuinely went back to the member (so
 * the local refund allocation and a REFUNDED booking event are written),
 * "dismissed" means it was declined or settled another way and requires a note.
 * Gated finance:edit; audited either way; never calls Stripe or Xero.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid refund task request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await resolveManualRefundTask({
      taskId: id,
      resolution: parsed.data.resolution,
      note: parsed.data.note ?? null,
      actingMemberId: guard.session.user.id,
    });
    revalidatePath("/admin/payments");
    revalidatePath("/admin/bookings/[id]", "page");
    return NextResponse.json({
      success: true,
      task: result,
      message:
        parsed.data.resolution === "completed"
          ? "Refund recorded as paid back by hand."
          : "Refund task dismissed.",
    });
  } catch (error) {
    if (error instanceof ManualBookingPaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, taskId: id }, "Manual refund task resolution failed");
    return NextResponse.json(
      { error: "Could not close the refund task." },
      { status: 500 },
    );
  }
}
