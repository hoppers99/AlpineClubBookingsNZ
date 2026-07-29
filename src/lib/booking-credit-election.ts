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
 * The election is single-consumption: it is cleared to NULL in the same
 * transaction that writes the credit ledger row, so a retry, a double-submit or
 * a second pay attempt can never apply it twice.
 */
export type StoredCreditElectionOutcome = {
  /** What the member asked to apply, in integer cents, as stored on the draft. */
  requestedCents: number;
  /** What was actually applied to the booking, in integer cents. */
  appliedCents: number;
  /** `requestedCents - appliedCents`; greater than zero means reality moved. */
  shortfallCents: number;
  /**
   * Why the shortfall happened. `"none"` when the full election was applied.
   * `"balance"` when the member no longer holds that much credit, `"price"`
   * when the booking is no longer worth that much, `"balance_and_price"` when
   * both bit.
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
 * election stored, or the booking is not in a state that may consume one), in
 * which case not a single row is read or written beyond the booking lookup.
 *
 * Takes the member-credit ledger lock before reading the balance, so the
 * balance this clamps against cannot move under it. Credit is applied through
 * the ordinary `applyCreditToBooking` path — the same ledger row shape, the
 * same validation, the same `deriveBookingAppliedCreditCents` arithmetic — so
 * the invariant `amountCents + creditAppliedCents = finalPriceCents` on the
 * Payment mirror continues to hold and no bespoke money arithmetic exists here.
 */
export async function consumeStoredCreditElection(
  tx: Prisma.TransactionClient,
  { bookingId }: { bookingId: string },
): Promise<StoredCreditElectionOutcome | null> {
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

  // Single consumption: clear the election in the SAME transaction as the
  // ledger write below, so a re-drive of this transaction (retry, double
  // submit, a second pay attempt) either applies the credit exactly once or
  // not at all — never twice.
  await tx.booking.update({
    where: { id: bookingId },
    data: { creditElectionCents: null },
  });

  await lockMemberCreditLedger(booking.memberId, tx);

  const availableBalanceCents = await getMemberCreditBalance(booking.memberId, tx);
  // Credit may already have been applied to this booking by another path (an
  // admin, or a legacy flow). The election can only claim the REMAINING price,
  // never re-cover a slice that is already covered.
  const alreadyAppliedCents = await deriveBookingAppliedCreditCents(bookingId, tx);
  const outstandingPriceCents = Math.max(
    0,
    booking.finalPriceCents - alreadyAppliedCents,
  );

  const limitedByBalance = requestedCents > availableBalanceCents;
  const limitedByPrice = requestedCents > outstandingPriceCents;
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
 * Settle a booking whose account credit now covers its whole price, so it owes
 * no card payment.
 *
 * Same shape as the existing zero-dollar settlements (`createConfirmedBooking`'s
 * fully-credit-covered branch and `applyLifecycleTransitions`' repriced-to-zero
 * branch): status PAID, one $0 SUCCEEDED Payment mirroring the applied credit
 * so `amountCents + creditAppliedCents = finalPriceCents` holds, and every
 * stale primary Stripe intent queued for cancellation. Must run inside the
 * caller's transaction; the caller performs the post-commit side effects
 * (member email, Xero invoice, booking event, provider intent cancellations).
 */
export async function settleFullyCreditCoveredBooking(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    appliedCreditCents,
  }: { bookingId: string; appliedCreditCents: number },
): Promise<{ supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[] }> {
  const payment = await tx.payment.upsert({
    where: { bookingId },
    create: {
      bookingId,
      amountCents: 0,
      creditAppliedCents,
      status: PaymentStatus.SUCCEEDED,
    },
    update: {
      amountCents: 0,
      creditAppliedCents,
      status: PaymentStatus.SUCCEEDED,
    },
  });

  await tx.booking.update({
    where: { id: bookingId },
    data: { status: BookingStatus.PAID },
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
