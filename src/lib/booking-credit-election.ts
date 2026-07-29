import { BookingStatus, PaymentStatus, type Prisma } from "@prisma/client";
import {
  applyCreditToBooking,
  deriveBookingAppliedCreditCents,
  getMemberCreditBalance,
  lockMemberCreditLedger,
} from "@/lib/member-credit";
import { calculateBookingCreditApplication } from "@/lib/policies/booking-route-decisions";
import {
  queueSupersededPrimaryIntentCancellations,
  type SupersededPrimaryPaymentIntent,
} from "@/lib/booking-payment-cleanup";

/**
 * The stored credit election (#2265, epic #2245 E1).
 *
 * A member can tick "use my credit" in the booking wizard and then save the
 * booking as a draft. Applying the credit there would tie their balance up
 * against a booking that may never be confirmed, so the owner's decision was to
 * REMEMBER the election on the draft (`Booking.creditElectionCents`) and apply
 * it the moment the booking reaches `PAYMENT_PENDING` — the same point at which
 * a directly-confirmed booking applies credit.
 *
 * Because time passes between the election and the confirmation, the amount the
 * member asked for is not necessarily still available or still owed: they may
 * have spent the balance on another booking, an admin may have adjusted it, or
 * the draft may have been edited to a lower price. This module resolves that
 * gap, and the rule it follows is CLAMP, NOT REFUSE.
 *
 * Why clamp. `calculateBookingCreditApplication` throws when the request
 * exceeds the balance or the price, and that is right where it is used — at
 * booking-create, the wizard validated the balance seconds earlier in the same
 * request, so an over-request there is a bug worth failing loudly. At
 * confirmation the same over-request is ordinary life, and throwing would leave
 * the member unable to pay their own draft at all: the pay step would 500 and
 * the only escape would be deleting the booking. The house already settled this
 * question the same way for the neighbouring case — `clampAppliedCreditToBookingPrice`
 * (#1887) clamps already-applied credit down when a modification reprices a
 * booking below it, precisely so the booking stays payable. This follows that
 * precedent.
 *
 * What is never allowed is applying less than the member asked for WITHOUT
 * saying so, so the outcome returned here carries the requested amount, the
 * applied amount, the shortfall and its reason, and the pay route returns them
 * to the client.
 *
 * The election is single-consumption, and that is enforced by a guarded CLAIM,
 * not by a read-then-write: the column is moved from the exact amount that was
 * read to NULL with `updateMany`, inside the same transaction that writes the
 * credit ledger row. A concurrent consumer, a retry, a double-submit or a
 * second pay attempt therefore either wins the claim and applies the credit
 * exactly once, or loses it and does nothing at all.
 */
export type StoredCreditElectionOutcome = {
  /** What the member asked to apply, in integer cents, as stored on the draft. */
  requestedCents: number;
  /** What was actually applied to the booking, in integer cents. */
  appliedCents: number;
  /** `requestedCents - appliedCents`; greater than zero means reality moved. */
  shortfallCents: number;
  /**
   * Which bound actually decided the applied amount. `"none"` when the full
   * election was applied. `"balance"` when the member's live balance is what
   * capped it, `"price"` when the booking's uncovered price is what capped it,
   * and `"balance_and_price"` only when the two are EQUAL and both below the
   * request — the one case where naming a single culprit would be arbitrary. A
   * bound that sits under the request but above the other bound did not decide
   * anything and is not reported, so the member is never told their balance was
   * short when the price was the real cap.
   */
  shortfallReason: "none" | "balance" | "price" | "balance_and_price";
  /** The member's credit balance at the moment of application, integer cents. */
  availableBalanceCents: number;
  /**
   * True when the booking is now fully covered by account credit and owes no
   * card payment at all. The caller must settle it at $0 rather than mint a
   * Stripe intent (Stripe rejects zero-amount intents).
   */
  fullyCovered: boolean;
};

/**
 * Consume the booking's stored credit election, if it has one.
 *
 * Must run inside the caller's transaction, and only once the booking is in
 * `PAYMENT_PENDING` — a booking still in `DRAFT` or `AWAITING_REVIEW` must not
 * have its credit consumed, which is the whole point of storing the election
 * rather than applying it. Returns `null` when there is nothing to do (no
 * election stored, the booking is not in a state that may consume one, or a
 * concurrent consumer won the claim first), in which case not a single row is
 * written.
 *
 * Lock order. The per-member credit-ledger lock is taken FIRST, before any
 * Booking row is written, because that is the order every other credit writer
 * in the house uses (`member-credit.ts` documents the lock; the modification
 * clamp, the Internet Banking switch and the cancellation restores all take it
 * before touching the booking). The caller is expected to already hold the
 * global booking lock(1) and, where it claims capacity, the per-lodge lock, so
 * the composed order stays global -> lodge -> member.
 *
 * Concurrency. Everything the decision depends on is read AFTER the lock, and
 * the election is then taken with a guarded claim — `updateMany` matching the
 * booking id, `PAYMENT_PENDING`, and the exact amount that was read. Two
 * requests racing on the same booking cannot both see a claim succeed, so the
 * credit can never be debited twice and the loser reports "nothing to do"
 * rather than a phantom outcome its caller would act on (a second confirmation
 * email, a second Xero invoice, a second MEMBER_PAID event).
 *
 * Credit is applied through the ordinary `applyCreditToBooking` path — the same
 * ledger row shape, the same validation, the same
 * `deriveBookingAppliedCreditCents` arithmetic — so the invariant
 * `amountCents + creditAppliedCents = finalPriceCents` on the Payment mirror
 * continues to hold and no bespoke money arithmetic exists here.
 */
export async function consumeStoredCreditElection(
  tx: Prisma.TransactionClient,
  { bookingId }: { bookingId: string },
): Promise<StoredCreditElectionOutcome | null> {
  // Pre-lock read: the lock key (memberId) plus the cheap "is there anything to
  // do at all" test, so a booking with no election costs one SELECT and takes
  // no lock. Every decision below consumes the POST-lock re-read instead.
  const lockTarget = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { memberId: true, creditElectionCents: true },
  });

  if (!lockTarget || lockTarget.creditElectionCents == null) return null;

  await lockMemberCreditLedger(lockTarget.memberId, tx);

  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: {
      memberId: true,
      status: true,
      finalPriceCents: true,
      creditElectionCents: true,
    },
  });

  if (!booking || booking.creditElectionCents == null) return null;
  // Defence in depth. Credit belongs to the member until the booking is real;
  // a DRAFT or AWAITING_REVIEW booking keeps its election stored and untouched.
  if (booking.status !== BookingStatus.PAYMENT_PENDING) return null;

  const requestedCents = booking.creditElectionCents;

  // Guarded claim (#2265). Matching on the status AND the exact amount read
  // means the election is taken atomically: whoever's UPDATE lands first sets
  // the column to NULL and every other racer matches zero rows. A lost claim is
  // NOT an error — a concurrent pay attempt already applied the credit, or a
  // concurrent cancel moved the booking out of PAYMENT_PENDING — so return
  // "nothing to do" and let the caller carry on against the live ledger.
  const claimed = await tx.booking.updateMany({
    where: {
      id: bookingId,
      status: BookingStatus.PAYMENT_PENDING,
      creditElectionCents: requestedCents,
    },
    data: { creditElectionCents: null },
  });

  if (claimed.count === 0) return null;

  const availableBalanceCents = await getMemberCreditBalance(booking.memberId, tx);
  // Credit may already have been applied to this booking by another path (an
  // admin, or a legacy flow). The election can only claim the REMAINING price,
  // never re-cover a slice that is already covered.
  const alreadyAppliedCents = await deriveBookingAppliedCreditCents(bookingId, tx);
  const outstandingPriceCents = Math.max(
    0,
    booking.finalPriceCents - alreadyAppliedCents,
  );

  // Which bound ACTUALLY bound? A bound only counts when it is below the
  // request (so it bit at all) AND is no higher than the other bound (so it is
  // the one that decided the answer). Both flags are true only when the two
  // bounds are equal and both below the request — the honest reading of
  // "balance and price". Reporting `balance_and_price` merely because both
  // happened to sit under the request told a member whose price had dropped
  // that their balance was short when it was not.
  const limitedByBalance =
    availableBalanceCents < requestedCents &&
    availableBalanceCents <= outstandingPriceCents;
  const limitedByPrice =
    outstandingPriceCents < requestedCents &&
    outstandingPriceCents <= availableBalanceCents;
  const clampedRequestCents = Math.max(
    0,
    Math.min(requestedCents, availableBalanceCents, outstandingPriceCents),
  );

  // The clamp above is the ONLY new arithmetic; the application decision itself
  // stays in the shared policy function, which by construction can no longer
  // throw now that the request is inside both of its bounds.
  const { creditAppliedCents } = calculateBookingCreditApplication({
    requestedCreditCents: clampedRequestCents,
    creditBalanceCents: availableBalanceCents,
    finalPriceCents: outstandingPriceCents,
    status: BookingStatus.PAYMENT_PENDING,
  });

  if (creditAppliedCents > 0) {
    await applyCreditToBooking(
      booking.memberId,
      creditAppliedCents,
      bookingId,
      tx,
    );
  }

  const shortfallCents = requestedCents - creditAppliedCents;
  const shortfallReason: StoredCreditElectionOutcome["shortfallReason"] =
    shortfallCents <= 0
      ? "none"
      : limitedByBalance && limitedByPrice
        ? "balance_and_price"
        : limitedByBalance
          ? "balance"
          : "price";

  return {
    requestedCents,
    appliedCents: creditAppliedCents,
    shortfallCents: Math.max(0, shortfallCents),
    shortfallReason,
    availableBalanceCents,
    fullyCovered:
      booking.finalPriceCents > 0 &&
      alreadyAppliedCents + creditAppliedCents >= booking.finalPriceCents,
  };
}

/**
 * Thrown when the $0 settlement's status-guarded claim matches no row: the
 * booking left `PAYMENT_PENDING` (a concurrent cancel, most likely) while this
 * transaction was assembling its settlement. Loud on purpose — the caller's
 * transaction must roll back, taking the credit application with it, rather
 * than resurrect a cancelled booking as PAID.
 */
export class CreditCoveredSettlementConflictError extends Error {
  constructor(bookingId: string) {
    super(
      `Booking ${bookingId} left PAYMENT_PENDING during the credit-covered settlement`,
    );
    this.name = "CreditCoveredSettlementConflictError";
  }
}

/**
 * Settle a booking whose account credit now covers its whole price, so it owes
 * no card payment.
 *
 * Same shape as the existing zero-dollar settlements (`createConfirmedBooking`'s
 * fully-credit-covered branch and `applyLifecycleTransitions`' repriced-to-zero
 * branch): status PAID, one $0 SUCCEEDED Payment mirroring the applied credit
 * so `amountCents + creditAppliedCents = finalPriceCents` holds, and every
 * stale primary Stripe intent queued for cancellation. Must run inside the
 * caller's transaction, which must already hold the global booking lock(1) and
 * the booking's per-lodge capacity lock; the caller performs the post-commit
 * side effects (member email, Xero invoice, booking event, provider intent
 * cancellations).
 *
 * The PAID write is a status-guarded claim, so a booking that a concurrent
 * cancel moved out of `PAYMENT_PENDING` can never be clobbered back to PAID.
 */
export async function settleFullyCreditCoveredBooking(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    appliedCreditCents,
  }: { bookingId: string; appliedCreditCents: number },
): Promise<{ supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[] }> {
  // Status-guarded claim FIRST, so nothing else in this settlement is written
  // for a booking that is no longer payable.
  const claimed = await tx.booking.updateMany({
    where: { id: bookingId, status: BookingStatus.PAYMENT_PENDING },
    data: { status: BookingStatus.PAID },
  });

  if (claimed.count === 0) {
    throw new CreditCoveredSettlementConflictError(bookingId);
  }

  const payment = await tx.payment.upsert({
    where: { bookingId },
    create: {
      bookingId,
      amountCents: 0,
      creditAppliedCents: appliedCreditCents,
      status: PaymentStatus.SUCCEEDED,
    },
    update: {
      amountCents: 0,
      creditAppliedCents: appliedCreditCents,
      status: PaymentStatus.SUCCEEDED,
      // Nothing is owed by card, so no card pointer on this Payment can still
      // be live. Clearing them is the same shape the repriced-to-zero
      // settlement uses (booking-modify-settlement.ts), and it is not
      // hypothetical here: an admin payment link or a saved-card charge can
      // mint a primary intent against a PAYMENT_PENDING booking that still
      // carries an unconsumed election, and that booking can then settle at $0
      // when the member's balance grows. The queue below cancels the intents
      // with the provider; this stops the Payment row pointing at them.
      //
      // `stripePaymentMethodId` is DELIBERATELY kept (unlike the
      // booking-modify-settlement sibling): a split parent's saved card is the
      // fallback the deferred non-member guest charge uses
      // (cron-confirm-pending.ts, payment-link.ts both read
      // `parentBooking.payment.stripePaymentMethodId`), so clearing it here
      // would strip the card the child booking is charged on later. Nothing
      // about this booking's own settlement needs it gone.
      stripePaymentIntentId: null,
      additionalPaymentIntentId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
    },
  });

  // A zero effective price supersedes every positive pending primary intent —
  // the same sweep the repriced-to-zero modification path performs.
  const supersededPrimaryPaymentIntents =
    await queueSupersededPrimaryIntentCancellations(tx, {
      bookingId,
      paymentId: payment.id,
      newFinalPriceCents: 0,
    });

  return { supersededPrimaryPaymentIntents };
}
