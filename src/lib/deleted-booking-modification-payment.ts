import { ManualRefundTaskStatus, PaymentStatus, Prisma } from "@prisma/client";
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
 * - **Interleaved.** The webhook completes entirely inside the confirm route's
 *   own Stripe round trip, so the route's early return never fires and the
 *   close ran before there was a task to close. Neither guard above catches
 *   that one; the raise's own refund fence does. See
 *   `raiseDeletedBookingModificationRefundTask` below.
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
 * that key and nothing else, and holds it across a duplicate-task check, a
 * refund-fence read and the create, so it introduces no new lock ordering. Every Stripe call is made by the caller,
 * outside this transaction.
 *
 * FENCED ON THE REFUND, NOT ONLY ON A SECOND RAISE, and that closes the
 * ordering in BOTH directions. The close counterpart below only catches a
 * webhook that arrives after the task exists. The reverse interleaving is real:
 * the confirm route reads the transaction's status once, then makes a Stripe
 * round trip, and a webhook completing inside that window refunds the capture,
 * flips the row to REFUNDED, and returns 200 — after which the route's
 * already-captured early return no longer fires,
 * `markPaymentIntentTransactionSucceeded` writes SUCCEEDED back over the
 * status, and a raise here would queue an operator to hand back money Stripe
 * has already returned. The close cannot save it: it ran before the task
 * existed and claimed nothing, and Stripe will not redeliver a 200. That task
 * is not merely noise — completing it throws out of
 * `applyLocalRefundAllocation` ("Refund amount exceeds captured payments"), so
 * it looks unresolvable in the operator queue.
 *
 * `refundedAmountCents` is the load-bearing field rather than `status`,
 * deliberately: `markPaymentIntentTransactionSucceeded` overwrites `status` but
 * never touches `refundedAmountCents`, so on this exact interleaving the status
 * is a lie by the time we look and the refunded total is not. The status check
 * is kept beside it for the ordinary case where nothing overwrote it. Read
 * INSIDE the same lock as the raise, so a refund committing concurrently is
 * serialised rather than missed.
 */
export async function raiseDeletedBookingModificationRefundTask(params: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
}): Promise<{
  taskId: string | null;
  created: boolean;
  alreadyRefunded: boolean;
}> {
  const { bookingId, paymentId, paymentIntentId, amountCents } = params;
  const reason = deletedBookingModificationRefundReason(paymentIntentId);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const existing = await tx.manualRefundTask.findFirst({
      where: { bookingId, paymentId, reason },
      select: { id: true },
    });
    if (existing) {
      return { taskId: existing.id, created: false, alreadyRefunded: false };
    }

    const settled = await tx.paymentTransaction.findUnique({
      where: { stripePaymentIntentId: paymentIntentId },
      select: { status: true, refundedAmountCents: true, amountCents: true },
    });
    if (
      settled &&
      (settled.refundedAmountCents >= (settled.amountCents || amountCents) ||
        settled.status === PaymentStatus.REFUNDED ||
        settled.status === PaymentStatus.PARTIALLY_REFUNDED)
    ) {
      logger.info(
        { bookingId, paymentId, paymentIntentId },
        "Skipped raising the deleted-booking modification refund task: Stripe had already refunded this capture",
      );
      return { taskId: null, created: false, alreadyRefunded: true };
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
    return { taskId: task.id, created: true, alreadyRefunded: false };
  });
}

/**
 * The opening words of the note the automatic close writes, and the phrase the
 * operator surface matches on (#2750).
 *
 * IT IS A SHARED CONSTANT, not two copies of one sentence, because the writer
 * below and the finance queue's reader
 * (`/api/admin/payments/manual-refund-tasks`) have to agree on it exactly. A
 * reworded note in one place and not the other does not fail a build, it
 * silently empties the list of automatically-refunded captures — the surface
 * whose entire purpose is that this money movement does not go unseen.
 *
 * Only the close below ever writes it, so it is the load-bearing half of the
 * filter. Kept short of the full sentence on purpose: the sentence ends with the
 * payment intent id, so a prefix is what a `startsWith` can match.
 */
export const AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX =
  "Closed automatically: Stripe refunded this capture under the cancelled-booking late-capture path";

/** The full note, per payment intent. Trimmed to the column's 500 chars. */
export function automaticCancelledBookingRefundNote(
  paymentIntentId: string,
): string {
  return `${AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX}, so there is nothing left to pay back by hand (payment intent ${paymentIntentId}).`.slice(
    0,
    500,
  );
}

/**
 * Which `ManualRefundTask` rows the finance queue shows as "refunded
 * automatically" (#2750, `INV-ADDPAY-037`).
 *
 * TWO CONDITIONS, AND NEITHER IS REDUNDANT.
 *
 * - **The note prefix** is what actually identifies this writer. Nothing else in
 *   the tree writes that sentence.
 * - **`completedByMemberId: null`** says no person did it, which is the claim the
 *   card makes on screen.
 *
 * The tempting simplification — drop the note and keep only "DISMISSED with no
 * acting member" — is wrong, and the schema is why. `ManualRefundTask.completedBy`
 * is `onDelete: SetNull`, so deleting the member who dismissed a task by hand
 * NULLs that column and turns their deliberate dismissal into a row this filter
 * would present as an automatic refund the club never made. Requiring the note
 * closes that. The reverse simplification — note only — would let a future writer
 * of the same sentence *with* an acting member in as well.
 *
 * Deliberately NOT matched on `reason`: the reason carries the payment intent id,
 * so matching it would mean a second per-intent string to keep in step for no
 * extra precision.
 */
export const automaticallyRefundedManualRefundTaskFilter: Prisma.ManualRefundTaskWhereInput =
  {
    status: ManualRefundTaskStatus.DISMISSED,
    completedByMemberId: null,
    note: { startsWith: AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX },
  };

/**
 * How far back the finance queue looks for automatic refunds (#2750).
 *
 * A window, not the whole history: the card exists to be *reviewed*, and an
 * unbounded list of long-settled rows is the state that makes an operator stop
 * reading it. The row itself is durable — this bounds one card's reach, nothing
 * else. Thirty days comfortably covers the club's own reconciliation rhythm, and
 * the audit entry `booking.payment.refunded_after_cancellation` remains the
 * permanent record for anything older.
 */
export const AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS = 30;

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
 *
 * CLOSED IS NOT HIDDEN (#2750). The task is the only durable record that this
 * particular money movement happened, and until #2750 closing it took it off the
 * only screen it ever appeared on — the finance queue lists OPEN rows. The
 * `/admin/payments` queue now also shows rows matching
 * `automaticallyRefundedManualRefundTaskFilter` as a read-only "refunded
 * automatically" card, so "a human is told" reaches somebody who is looking at
 * refunds rather than only somebody who thinks to query the table. The note
 * below is that card's text as well as this row's, which is why its opening
 * words are a shared constant.
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
      note: automaticCancelledBookingRefundNote(paymentIntentId),
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
