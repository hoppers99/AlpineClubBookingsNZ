import { ManualRefundTaskStatus } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * What happens when a booking modification payment lands on a booking the club
 * has already deleted (#2700, owner decision 10 Aug 2026).
 *
 * THE RACE. An admin deletes a cancelled booking while its owner is still on
 * the Stripe payment page for a modification. Stripe captures. The money is
 * real and the booking is gone.
 *
 * BOTH OF THE ORIGINAL OPTIONS WERE REJECTED. "Record it anyway" leaves a
 * ledger row against a ghost booking with nobody told. "Refuse and let Stripe
 * reconciliation surface it" leaves the club holding a member's money with no
 * record of it at all. The decision is to do both halves of the right thing:
 * record the payment, so the money is accounted for, AND raise an OPEN
 * `ManualRefundTask`, so a human is told and decides.
 *
 * NO AUTOMATIC REFUND FROM THIS PATH. It is a money movement triggered by a
 * race, and if the DELETION was itself the mistake, refunding automatically
 * compounds it rather than surfacing it. `ManualRefundTask` already exists for
 * exactly this shape (`bookingId`, `paymentId`, `amountCents`, `reason`,
 * `status: OPEN`) and is the club's established "a human owes somebody money by
 * hand" queue, so this uses that machinery rather than inventing one.
 *
 * THE COUNTERPART WRITER, AND WHY THE CLOSE BELOW EXISTS. The browser confirm
 * is not the only thing that hears about the capture: Stripe also sends
 * `payment_intent.succeeded`, and since #1350 the webhook routes an additional
 * payment on a CANCELLED booking through
 * `handleCancelledBookingAdditionalPaymentSucceeded`, which refunds it
 * automatically. A soft-deleted booking is ALWAYS `CANCELLED`
 * (`INV-ADDPAY-030`), so that path covers deleted bookings too, and the two
 * orderings must not be allowed to pay the member twice:
 *
 * - **Webhook first.** It records and refunds; the confirm endpoint then finds
 *   the transaction already captured and returns early, so no task is raised.
 * - **Confirm endpoint first.** It records and raises the task; the webhook's
 *   refund then satisfies that task's whole question, so the webhook CLOSES it
 *   with a note rather than leaving an operator to complete a task for money
 *   Stripe has already returned — which would write a second refund allocation
 *   through `resolveManualRefundTask` and double-count the refund in the ledger.
 *
 * Closing a task because its subject is resolved is not itself money movement,
 * so it does not contradict the no-automatic-refund decision above; the refund
 * it records was already the webhook's established #1350 behaviour and is not
 * introduced here.
 */
export function deletedBookingModificationRefundReason(
  paymentIntentId: string,
): string {
  return `Booking modification payment ${paymentIntentId} was captured against a booking the club had already deleted (#2700). Decide by hand whether to refund it: nothing was owed on a deleted booking, but if the deletion was itself the mistake, put that right instead of refunding.`.slice(
    0,
    500,
  );
}

/**
 * Raise the OPEN task, exactly once per payment intent.
 *
 * IDEMPOTENT ON THE INTENT, NOT ON THE BOOKING. The match is
 * `bookingId + paymentId + this intent's reason`, across EVERY status — so a
 * retry after an operator has already completed or dismissed the task does not
 * raise a second one, and an unrelated `ManualRefundTask` on the same booking
 * (the cash/manual cancellation settlement `booking-cancel.ts` raises) is never
 * mistaken for this one and never closed by the webhook counterpart below.
 *
 * UNDER THE GLOBAL LOCK, because find-then-create is not atomic on its own and
 * two simultaneous confirms of the same intent would otherwise raise two OPEN
 * tasks for one capture — two operators, two refunds. `pg_advisory_xact_lock(1)`
 * is the canonical global booking/settlement-money key and is what
 * `booking-cancel.ts` already holds when IT creates a `ManualRefundTask`, so
 * this write joins the same cohort rather than minting a new keyspace. It takes
 * that key and nothing else, and holds it for two statements, so it introduces
 * no new lock ordering. Every Stripe call is made by the caller, outside this
 * transaction.
 */
export async function raiseDeletedBookingModificationRefundTask(params: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
}): Promise<{ taskId: string; created: boolean }> {
  const { bookingId, paymentId, paymentIntentId, amountCents } = params;
  const reason = deletedBookingModificationRefundReason(paymentIntentId);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const existing = await tx.manualRefundTask.findFirst({
      where: { bookingId, paymentId, reason },
      select: { id: true },
    });
    if (existing) {
      return { taskId: existing.id, created: false };
    }

    const task = await tx.manualRefundTask.create({
      // `status: OPEN` is written EXPLICITLY even though the schema defaults to
      // it. The owner's acceptance criterion is that this path produces an OPEN
      // task, and a default that lives only in the database cannot be asserted
      // without one — stating it here makes the property the code's, and lets a
      // test prove it rather than trust it.
      data: {
        bookingId,
        paymentId,
        amountCents,
        reason,
        status: ManualRefundTaskStatus.OPEN,
      },
      select: { id: true },
    });
    return { taskId: task.id, created: true };
  });
}

/**
 * Close the task raised above once Stripe has already returned the money.
 *
 * A status-fenced `updateMany` on `OPEN`, so it needs no lock of its own and is
 * safe to replay: a webhook retry, or an operator who closed the task first,
 * simply claims nothing. It never touches a task it did not raise — the reason
 * match pins it to this exact payment intent.
 *
 * DISMISSED, not COMPLETED, and the distinction is load-bearing. In
 * `manual-booking-payment.ts` COMPLETED means "an operator handed the money back
 * by hand" and is what writes the local refund allocation; DISMISSED means
 * "settled another way", moves no money and writes no allocation. Stripe
 * refunded this one and `refundPaymentTransactions` already wrote the
 * allocation, so COMPLETED here would be both untrue and a second allocation
 * for one refund. `completedByMemberId` stays null because no member did it.
 */
export async function closeDeletedBookingModificationRefundTaskAfterAutomaticRefund(params: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
}): Promise<number> {
  const { bookingId, paymentId, paymentIntentId } = params;
  const reason = deletedBookingModificationRefundReason(paymentIntentId);

  const closed = await prisma.manualRefundTask.updateMany({
    where: {
      bookingId,
      paymentId,
      reason,
      status: ManualRefundTaskStatus.OPEN,
    },
    data: {
      status: ManualRefundTaskStatus.DISMISSED,
      completedAt: new Date(),
      note: `Closed automatically: Stripe refunded this capture under the cancelled-booking late-capture path, so there is nothing left to pay back by hand (payment intent ${paymentIntentId}).`.slice(
        0,
        500,
      ),
    },
  });

  if (closed.count > 0) {
    logger.info(
      { bookingId, paymentId, paymentIntentId, closed: closed.count },
      "Closed the deleted-booking modification refund task after the automatic refund",
    );
  }

  return closed.count;
}
