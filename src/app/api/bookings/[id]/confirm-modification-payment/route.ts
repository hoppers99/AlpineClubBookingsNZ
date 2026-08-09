import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPaymentIntent } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import {
  findPaymentTransactionByIntentId,
  markPaymentIntentTransactionSucceeded,
} from "@/lib/payment-transactions";
import {
  kickQueuedXeroOutboxOperationsIfConnected,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
} from "@/lib/xero-operation-outbox";
import { hasAdminAccess } from "@/lib/access-roles";
import { raiseDeletedBookingModificationRefundTask } from "@/lib/deleted-booking-modification-payment";

const schema = z.object({
  paymentIntentId: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const isAdmin = hasAdminAccess(session.user);

  const { id: bookingId } = await params;

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { paymentIntentId } = parsed.data;
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  try {
    const payment = await prisma.payment.findUnique({
      where: { bookingId },
      // #2700: `deletedAt` beside the authority field. Nothing on this path read
      // `status` or `deletedAt` before, which is how `INV-ADDPAY-032` came to
      // list this handler as a write still reachable on a deleted booking.
      include: { booking: { select: { memberId: true, deletedAt: true } } },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (
      payment.booking.memberId !== session.user.id &&
      !isAdmin
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (payment.additionalPaymentIntentId !== paymentIntentId) {
      return NextResponse.json(
        { error: "PaymentIntent does not match booking" },
        { status: 400 }
      );
    }

    const paymentTransaction = await findPaymentTransactionByIntentId({
      paymentIntentId,
    });
    if (!paymentTransaction) {
      return NextResponse.json({ error: "Payment transaction not found" }, { status: 404 });
    }

    if (
      paymentTransaction.status === "SUCCEEDED" ||
      paymentTransaction.status === "PARTIALLY_REFUNDED" ||
      paymentTransaction.status === "REFUNDED"
    ) {
      const released = await releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
        paymentIntentId
      );
      if (released.released > 0) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: released.released });
      }
      return NextResponse.json({ success: true });
    }

    const pi = await getPaymentIntent(paymentIntentId);
    if (pi.status !== "succeeded") {
      return NextResponse.json(
        { error: `Payment has not succeeded (status: ${pi.status})` },
        { status: 400 }
      );
    }

    if (pi.amount !== paymentTransaction.amountCents) {
      return NextResponse.json(
        { error: "Payment amount does not match booking modification" },
        { status: 400 }
      );
    }

    await markPaymentIntentTransactionSucceeded({
      paymentIntentId: pi.id,
      amountCents: pi.amount,
      paymentMethodId:
        typeof pi.payment_method === "string"
          ? pi.payment_method
        : pi.payment_method?.id ?? null,
    });

    // #2700 — the booking was deleted while this payment was in flight.
    //
    // THIS IS NOT A REFUSAL, and that is the decision. Stripe has already
    // captured the money by the time this endpoint is called; a 404 here would
    // leave a captured payment with no ledger row, which is worse than a ledger
    // row against a deleted booking. So the payment is recorded exactly as it
    // would be on a live booking — and then a human is told, because a ledger
    // row nobody looks at is not "accounted for".
    //
    // The task is raised AFTER the record above and before the audit entry, so
    // the audit trail already carries the payment when the queue row appears.
    // Raising it is best-effort in the sense that a failure must not turn a
    // recorded capture into a 500 the member sees — the money IS recorded, and
    // re-confirming would take the already-captured early return above and never
    // reach here again. A failure is logged loudly instead.
    //
    // Why no automatic refund, and why the webhook may still close this task:
    // `deleted-booking-modification-payment.ts`.
    if (payment.booking.deletedAt) {
      try {
        const task = await raiseDeletedBookingModificationRefundTask({
          bookingId,
          paymentId: payment.id,
          paymentIntentId: pi.id,
          amountCents: paymentTransaction.amountCents,
        });
        logger.warn(
          {
            bookingId,
            paymentIntentId: pi.id,
            additionalAmountCents: paymentTransaction.amountCents,
            manualRefundTaskId: task.taskId,
            taskCreated: task.created,
          },
          "Modification payment captured against a deleted booking - recorded and raised for manual decision"
        );
      } catch (err) {
        logger.error(
          { err, bookingId, paymentIntentId: pi.id },
          "Recorded a modification payment on a deleted booking but FAILED to raise the manual refund task"
        );
      }
    }

    const released = await releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
      pi.id
    );
    if (released.released > 0) {
      void kickQueuedXeroOutboxOperationsIfConnected({ limit: released.released });
    }

    logAudit({
      action: "booking.modification.payment.confirmed",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: payment.booking.memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "payment",
      outcome: "success",
      summary: "Booking modification payment confirmed",
      details: JSON.stringify({
        paymentIntentId,
        additionalAmountCents: paymentTransaction.amountCents,
      }),
      metadata: {
        paymentIntentId,
        paymentTransactionId: paymentTransaction.id,
        additionalAmountCents: paymentTransaction.amountCents,
      },
      ipAddress,
    });

    logger.info(
      { bookingId, paymentIntentId, additionalAmountCents: paymentTransaction.amountCents },
      "Modification additional payment confirmed"
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    // #1888 — never echo an unexpected error's message to the client; the raw
    // error stays in the log only.
    logger.error({ err, bookingId }, "Failed to confirm modification payment");
    return NextResponse.json(
      { error: "Failed to confirm payment" },
      { status: 500 }
    );
  }
}
