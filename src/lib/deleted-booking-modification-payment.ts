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
 *   Since #2760 the webhook WRITES the record itself in that case, already
 *   DISMISSED — see `recordAutomaticCancelledBookingRefundTask`.
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
 *
 * TWO POPULATIONS SINCE #2760 (owner decision 10 Aug 2026), and the record now
 * covers both. #1350's refund fires on `Booking.status === "CANCELLED"`, not on
 * `deletedAt`, so a late capture on a booking that is cancelled but still on file
 * is auto-refunded exactly the same way — and used to leave no row at all,
 * because the confirm route's raise only fires on a deleted booking. The webhook
 * now writes a DISMISSED row for either population. The owner took that wider
 * option over the narrower recommendation knowing it makes the card busier: for a
 * merely cancelled booking the refund is usually the expected outcome, so those
 * rows are records of normal operation. `cancelledBookingModificationRefundReason`
 * keeps them distinguishable from the deleted ones, which are the interesting
 * case.
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
 * The same sentence for the OTHER population #2760 widened this record to: a
 * late capture on a booking that is CANCELLED but has not been deleted.
 *
 * WHY A SECOND STRING AND NOT ONE SHARED SENTENCE. The reason is stored on the
 * row and printed on the finance card, so the sentence above — which says the
 * booking "had already been deleted" and asks an operator to decide — would be
 * false on both counts for a booking that is merely cancelled. Two honest
 * sentences beat one that is wrong for half the rows it now covers.
 *
 * AND WHY THE FIRST ONE'S BYTES DID NOT CHANGE. `reason` is the idempotency key
 * (`bookingId + paymentId + reason`) that the confirm route's raise and the
 * webhook's close/record both match on. Rewording it would leave any OPEN task
 * raised before this deploy unmatchable: the webhook would create a second,
 * DISMISSED row and leave the OPEN one in the hand-back queue asking an operator
 * to hand back money Stripe had already returned. So the deleted-population
 * sentence is frozen, this one is new, and every lookup matches BOTH — see
 * `automaticCancelledBookingRefundTaskReasons`.
 *
 * NO "decide by hand" CLAUSE, deliberately. Only the webhook writes this
 * variant, and only already-DISMISSED, so there has never been a decision on one
 * of these rows.
 */
export function cancelledBookingModificationRefundReason(
  paymentIntentId: string,
): string {
  return `Booking modification payment ${paymentIntentId} was captured against a booking the club had already cancelled (#2760). Nothing was owed on a cancelled booking, so there is no hand-back to make — but if the cancellation was itself the mistake, put that right rather than treating this as a refund somebody still owes.`.slice(
    0,
    500,
  );
}

/**
 * Every `reason` this record can carry for one payment intent, for the writers
 * that must find a row REGARDLESS of which population produced it (#2760).
 *
 * THE KEY MUST NOT DEPEND ON THE POPULATION, and that is the whole reason this
 * exists. A booking can be deleted BETWEEN two Stripe deliveries of the same
 * capture — deletion is one-way (`INV-ADDPAY-030`), but it can arrive at any
 * moment — so a redelivery would see the deleted population where the first
 * delivery saw the cancelled one. Keyed per population, that redelivery finds no
 * row and writes a SECOND one for a single refund. Matching both sentences makes
 * the lookup population-independent while each row still stores the sentence
 * that was true when it was written.
 *
 * The confirm route's raise matches this list too, so a webhook-created row of
 * either kind stops it raising a duplicate OPEN task. Its refund fence would
 * also decline that raise — this is deliberate belt and braces on the one path
 * where a duplicate would be an operator asked to hand back money twice.
 */
export function automaticCancelledBookingRefundTaskReasons(
  paymentIntentId: string,
): string[] {
  return [
    deletedBookingModificationRefundReason(paymentIntentId),
    cancelledBookingModificationRefundReason(paymentIntentId),
  ];
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
      // BOTH population sentences (#2760), even though this writer only ever
      // fires on a deleted booking: since #2760 the webhook may already have
      // written the cancelled-population row for this same capture, and the
      // booking may have been deleted afterwards. Matching only this path's own
      // sentence would then miss that row and raise a duplicate — an OPEN task
      // asking an operator to hand back money Stripe has already returned.
      where: {
        bookingId,
        paymentId,
        reason: { in: automaticCancelledBookingRefundTaskReasons(paymentIntentId) },
      },
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
 * The opening words of the note the automatic writer writes — whether it closes a
 * raised task or creates the record itself (#2760) — and the phrase the operator
 * surface matches on (#2750).
 *
 * IT IS A SHARED CONSTANT, not two copies of one sentence, because the writer
 * below and the finance queue's reader
 * (`/api/admin/payments/manual-refund-tasks`) have to agree on it exactly. A
 * reworded note in one place and not the other does not fail a build, it
 * silently empties the list of automatically-refunded captures — the surface
 * whose entire purpose is that this money movement does not go unseen.
 *
 * Only `recordAutomaticCancelledBookingRefundTask` below ever writes it — on both
 * arms, the close AND the #2760 create — so it is the load-bearing half of the
 * filter. Kept short of the full sentence on purpose: the sentence ends with the
 * payment intent id, so a prefix is what a `startsWith` can match.
 *
 * THESE BYTES ARE STORED DATA, NOT DISPLAY COPY (#2750 review). Sharing the
 * constant keeps writer and reader from drifting apart, but it does NOT make the
 * value safe to edit: `startsWith` is evaluated against notes already written to
 * rows, so rewording this would leave every test that derives its expectation
 * from the constant green while making every automatic refund the club has
 * already had disappear from the card — the exact defect #2750 exists to close.
 * `deleted-booking-refund-visibility.test.ts` therefore pins these bytes as a
 * golden string. Changing them needs a migration that rewrites the stored notes,
 * or a reader that accepts the old prefix as well, in the same commit.
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
 * The record of one automatic refund: close the task if the confirm route raised
 * one, and WRITE it if nothing did (#2760, owner decision 10 Aug 2026).
 *
 * WHAT CHANGED, AND WHY. Until #2760 this only closed. A row therefore existed
 * on exactly one of the four orderings — the confirm endpoint winning the race —
 * because that endpoint is the only other writer of one of these tasks. On the
 * ordinary healthy ordering (webhook first), on a member who closes the tab after
 * paying, and on the interleaved ordering the raise's refund fence declines, the
 * money went back with no row at all, so the finance card was a partial record
 * and said so. The owner chose the wider fix over the recommendation: the webhook
 * writes the row itself, for EVERY auto-refunded late capture on a cancelled
 * booking — deleted or not — so the card is now complete for both populations.
 *
 * ALREADY-DISMISSED, NEVER OPEN. An OPEN row is work, and there is none: Stripe
 * returned the money before anybody saw the capture. An OPEN row here would
 * queue an operator to hand back money that has already gone, and completing it
 * throws out of `applyLocalRefundAllocation` ("Refund amount exceeds captured
 * payments"), so it would look unresolvable as well as being wrong.
 *
 * DISMISSED, not COMPLETED, and the distinction is load-bearing. In
 * `manual-booking-payment.ts` COMPLETED means "an operator handed the money back
 * by hand" and is what writes the local refund allocation; DISMISSED means
 * "settled another way", moves no money and writes no allocation. Stripe
 * refunded this one and `refundPaymentTransactions` already wrote the
 * allocation, so COMPLETED here would be both untrue and a second allocation
 * for one refund. `completedByMemberId` stays null because no member did it.
 *
 * NO MONEY DECISION IS MADE OR CHANGED HERE. The refund, its amount and its
 * timing are #1350's, decided and executed by the caller before this runs. This
 * writes one bookkeeping row.
 *
 * WHY THE LOCK NOW, WHEN THE CLOSE NEEDED NONE. The close was a single
 * status-fenced `updateMany`, atomic on its own. Close-or-create is a
 * find-then-write, which is not: two Stripe deliveries of one capture landing
 * together — or a delivery racing the confirm route's raise — would each see no
 * row and each write one, and the card would show one refund twice. It takes
 * `pg_advisory_xact_lock(1)`, the canonical global booking/settlement-money key
 * this file's raise already holds and `booking-cancel.ts` holds when IT creates a
 * `ManualRefundTask`, so this joins an existing cohort rather than minting a
 * keyspace. It takes that key and nothing else, holds it across an `updateMany`,
 * a `findFirst` and at most one `create` — no provider call, no capacity or
 * member-credit tier — so it composes with nothing and reverses no order. The
 * caller's Stripe refund has already returned by the time this is called.
 *
 * IDEMPOTENT ON THE INTENT, ACROSS BOTH POPULATIONS. Every lookup matches
 * `bookingId + paymentId + reason IN {deleted, cancelled}` (see
 * `automaticCancelledBookingRefundTaskReasons`), so Stripe redelivery, a confirm
 * retry, and a deletion that lands between two deliveries all resolve to the one
 * row. The `updateMany` stays fenced on OPEN so it can only ever close a raise,
 * never re-date a row it already wrote.
 *
 * NEVER FLIPS AN EXISTING ROW BACK. If a row exists in any non-OPEN state —
 * already DISMISSED by this writer, DISMISSED by an operator, or COMPLETED
 * because a human handed money back before the webhook arrived — it is left
 * exactly as it is. This writer only ever creates a DISMISSED row or closes an
 * OPEN one.
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
export async function recordAutomaticCancelledBookingRefundTask(params: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  /**
   * The captured amount Stripe has just returned, in integer cents. Written to
   * the row as-is: nothing here recomputes a refund.
   */
  amountCents: number;
  /**
   * Which population this capture belongs to, read from `Booking.deletedAt` at
   * the moment of the refund. It selects the row's stored `reason` sentence and
   * nothing else — every lookup matches both sentences.
   */
  bookingDeleted: boolean;
}): Promise<{ closed: number; created: boolean; alreadyRecorded: boolean }> {
  const { bookingId, paymentId, paymentIntentId, amountCents, bookingDeleted } =
    params;
  const reasons = automaticCancelledBookingRefundTaskReasons(paymentIntentId);
  const note = automaticCancelledBookingRefundNote(paymentIntentId);

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const closed = await tx.manualRefundTask.updateMany({
      where: {
        bookingId,
        paymentId,
        reason: { in: reasons },
        status: ManualRefundTaskStatus.OPEN,
      },
      data: {
        status: ManualRefundTaskStatus.DISMISSED,
        completedAt: new Date(),
        note,
      },
    });
    if (closed.count > 0) {
      return { closed: closed.count, created: false, alreadyRecorded: false };
    }

    // Nothing was OPEN. Either this writer (or a hand dismissal, or a hand
    // completion) already accounted for the capture, or no row exists at all and
    // this is one of the three orderings that used to leave the refund unrecorded.
    const existing = await tx.manualRefundTask.findFirst({
      where: { bookingId, paymentId, reason: { in: reasons } },
      select: { id: true },
    });
    if (existing) {
      return { closed: 0, created: false, alreadyRecorded: true };
    }

    await tx.manualRefundTask.create({
      data: {
        bookingId,
        paymentId,
        amountCents,
        reason: bookingDeleted
          ? deletedBookingModificationRefundReason(paymentIntentId)
          : cancelledBookingModificationRefundReason(paymentIntentId),
        // Written EXPLICITLY, against a schema that defaults to OPEN. The
        // owner's rule is that this row is never OPEN, and a default that lives
        // only in the database cannot be asserted — stating it here makes the
        // property the code's and lets a test prove it.
        status: ManualRefundTaskStatus.DISMISSED,
        // The card's window and ordering both read `completedAt`, so a row
        // without it would be invisible to the surface it exists for.
        completedAt: new Date(),
        note,
      },
      select: { id: true },
    });
    return { closed: 0, created: true, alreadyRecorded: false };
  });

  if (outcome.closed > 0) {
    logger.info(
      { bookingId, paymentId, paymentIntentId, closed: outcome.closed },
      "Closed the cancelled-booking modification refund task after the automatic refund",
    );
  } else if (outcome.created) {
    logger.info(
      { bookingId, paymentId, paymentIntentId, amountCents, bookingDeleted },
      "Recorded an automatically refunded late capture that no confirm route had raised (#2760)",
    );
  }

  return outcome;
}
