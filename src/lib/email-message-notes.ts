/**
 * #2268 - composers for the OPTIONAL and outcome-dependent lines of the
 * admin-editable plain-text email bodies.
 *
 * The editable bodies are rendered by a flat regex substitution
 * (`renderTemplateString`) with no conditional syntax whatsoever, so a body
 * that writes `Admin note: {{adminNote}}` prints a dangling `Admin note:` on
 * every send where the value is absent, and a body that states one branch of an
 * either/or states it even when the other branch is true. Authors used to paper
 * over both with `[only when ...]` guidance, which simply printed itself into
 * member inboxes.
 *
 * These helpers are the single source of truth for that copy: the hand-built
 * HTML templates and the flat `{{...Note}}` tokens the senders supply are built
 * from the same function, so the two paths cannot drift apart.
 *
 * This module deliberately imports nothing - the email template layer, the
 * senders and the template registry all depend on it.
 */

/**
 * #2268 — compose an OPTIONAL line of an admin-editable plain-text email body.
 *
 * The editable bodies are rendered by a flat regex substitution
 * (`renderTemplateString`) with no conditional syntax whatsoever, so a body that
 * writes `Admin note: {{adminNote}}` prints a dangling `Admin note:` on every
 * send where the value is absent. Authors used to paper over that with
 * `[only when adminNote exists]` guidance, which simply printed itself.
 *
 * The fix is the `{{provisionalGuestsNote}}` / `{{promoSummary}}` pattern: the
 * SENDER composes the whole line (or nothing at all) and the default body
 * carries only the token. The composed value brings its own trailing blank
 * line, so a default body writes `{{adminNoteLine}}Next paragraph` and renders
 * a clean paragraph when there is a value and nothing whatsoever when there is
 * not.
 *
 * `label` may be null for a value that is already a full sentence.
 * Values are unescaped plain text; HTML paths escape at their own edge.
 */
export function composeOptionalEmailLine(
  label: string | null,
  value: string | null | undefined,
  options?: { trailing?: string },
): string {
  const text = (value ?? "").trim();
  if (!text) return "";
  return `${label ? `${label}: ${text}` : text}${options?.trailing ?? "\n\n"}`;
}

/**
 * #2268 — one line of a chore list for a flat email body: `Name: description`,
 * or just `Name` when the chore carries no description, so the line can never
 * trail off after a colon. Each line brings its own newline.
 */
export function composeChoreLine(
  name: string,
  description?: string | null,
): string {
  const text = (description ?? "").trim();
  return text ? `${name}: ${text}\n` : `${name}\n`;
}

/**
 * #2268 — the one paragraph of the duplicate-capture alert that changes with
 * the outcome, shared by the hand-built HTML below and the `{{refundOutcomeNote}}`
 * token the admin-editable body renders. The flat body used to state the
 * success wording unconditionally and park the failure wording in an
 * `[only when …]` annotation, so an admin who saved that default was told a
 * duplicate charge had been refunded even when the refund had failed.
 */
export function duplicateCaptureRefundOutcomeParagraph(
  refundFailed: boolean,
): string {
  return refundFailed
    ? "A second, distinct card capture arrived on a booking that was already paid and settled by another capture. The system tried to refund the duplicate charge automatically, but the refund could not complete inline. A durable recovery operation is queued and the payment recovery cron will retry it with backoff — watch the recovery queue and confirm the refund lands. The booking's own settlement is untouched."
    : "A second, distinct card capture arrived on a booking that was already paid and settled by another capture. The duplicate charge was automatically refunded in full, so the member has not been double-charged and no action is needed unless the member reports otherwise. The booking's own settlement is untouched.";
}

/**
 * #2268 — the outcome-dependent lead paragraph of the recurring split-settlement
 * alert, shared by the hand-built HTML below and the `{{settlementActionNote}}`
 * token the admin-editable body renders. The flat body used to assert that a
 * payment link had been emailed and park the "no link sent, chase the whole
 * booking" case in an `[only when …]` annotation.
 */
export function adminSplitSettlementUnpaidLeadParagraph(
  parentUnpaid: boolean,
): string {
  return parentUnpaid
    ? "A split booking reached its hold deadline for the non-member guest portion, but there is no saved card to charge and the member's own linked booking has not been paid either. No payment link has been sent — the guest portion should not be paid ahead of the member's own place. The hold has been extended; follow up with the member about paying for the whole booking."
    : "A split booking reached its hold deadline for the non-member guest portion, but there is no saved card to charge — the member paid their own place by internet banking. A secure payment link has been emailed to the member so they can pay for their guests, and the hold has been extended.";
}

/**
 * #2268 — the outcome-dependent lead paragraph of the terminal split-settlement
 * cancellation alert, shared by the hand-built HTML below and the
 * `{{settlementActionNote}}` token the admin-editable body renders. The flat
 * body used to assert the member's own booking was settled and unaffected, and
 * park the "not settled either — review the whole booking" case in an
 * `[only when …]` annotation.
 */
export function adminSplitSettlementCancelledLeadParagraph(
  parentUnpaid: boolean,
): string {
  return parentUnpaid
    ? "A split booking's non-member guest portion was still unpaid at the end of its check-in day, with no saved card to charge, and the member's own linked booking is not settled either (it may be unpaid or already cancelled). The provisional guest booking has now been automatically cancelled. No payment was taken and no beds were held. The member has been notified. Review the whole booking to confirm the state of the member's own place."
    : "A split booking's non-member guest portion was still unpaid at the end of its check-in day, with no saved card to charge (the member had paid their own place by internet banking). The provisional guest booking has now been automatically cancelled. No payment was taken and no beds were held. The member has been notified; the member's own linked booking is settled and is unaffected.";
}

/**
 * #2263 × #2444 — the whole confirmed-but-UNPAID paragraph of a booking
 * confirmation, shared by the hand-built HTML confirmation
 * (`bookingConfirmedTemplate`) and the flat `{{paymentDueNote}}` token the
 * admin-editable body renders inside `{{paymentOutcome}}`.
 *
 * It was written out TWICE — once in `email-templates.ts` and once in
 * `email/booking.ts` — with only a comment claiming the two copies were
 * byte-identical. #2444 has to add a sentence to it, and adding a sentence to
 * two hand-kept copies is exactly the drift `composeOptionalEmailLine` and
 * `appliedCreditSummaryRows` exist to prevent, so the paragraph moved here.
 *
 * THE ACCOUNT-CREDIT SENTENCE, and why it is worded conditionally (#2444).
 * Under #1620 "allocate-existing" the club's Xero invoice for this booking is
 * raised for the FULL amount and the member's own floating credit notes are
 * then ALLOCATED against it (the same approval enqueues that allocation), so
 * Xero asks the member for LESS than the "Total Due" line above. A member
 * holding credit who transferred the figure in this email would OVERPAY, and
 * the club would unwind it by hand.
 *
 * The sentence is deliberately CONDITIONAL and states no figure. The great
 * majority of members hold no credit at all, so an unconditional "credit has
 * been applied" would be false for them; and computing the real net figure
 * needs a Xero read, which a transactional send must not make (it would put a
 * provider round-trip, and a provider outage, in the path of a member's
 * confirmation). The owner's decision (1 Aug 2026) is that this neutral
 * sentence ships now and the computed figure is its own later piece of work.
 *
 * `amount` and `reference` arrive ALREADY FORMATTED and already escaped for
 * the caller's medium — this module imports nothing (see the file docblock), so
 * money formatting stays with the caller, and the HTML path escapes the
 * club-entered reference at its own edge exactly as it did before.
 */
export function bookingPaymentDueNote({
  amount,
  reference,
  invoiceEmailed,
}: {
  /** Amount owing, already formatted as money — "$300.00". */
  amount: string;
  /** Internet-banking reference the member must quote, already escaped. */
  reference: string;
  /** TRUE only when an invoice really was raised (the Xero module is on). */
  invoiceEmailed: boolean;
}): string {
  return (
    `This booking is confirmed, but payment of ${amount} is still owing. Please pay by internet banking quoting reference ${reference}.` +
    (invoiceEmailed
      ? " An invoice has been emailed to you separately."
      : " The club will send you an invoice for it.") +
    " If you hold account credit with the club, it will be applied to your invoice, so please transfer the amount the invoice shows."
  );
}

/**
 * #2268 — the one member-facing sentence about their OWN booking, shared by the
 * hand-built HTML below and the `{{ownBookingNote}}` token the admin-editable
 * body renders. The flat body used to promise "your own booking is unaffected
 * and remains confirmed" unconditionally, with the truthful alternative parked
 * in an `[only when …]` annotation — so an admin who saved that default told
 * members with an unsettled booking something false.
 */
export function splitGuestPortionOwnBookingLine(
  parentConfirmed: boolean,
): string {
  return parentConfirmed
    ? "This only affects your guests' provisional place — your own booking is unaffected and remains confirmed."
    : "This only affects your guests' provisional place — your own linked booking has not been changed by this cancellation.";
}
