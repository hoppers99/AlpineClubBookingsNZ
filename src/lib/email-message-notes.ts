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

/** A labelled link in an email: the button caption and the site-relative path. */
export interface EmailLinkAction {
  label: string;
  path: string;
}

/**
 * #2430 — where a BUMPED booking's owner is invited to go next.
 *
 * The bumped notice used to end in "Book Again: {BASE_URL}/book" for everyone,
 * but `/book` is the MEMBER booking flow behind the login. Two of the three
 * recipient classes that reach `sendBookingBumpedEmail` cannot use it:
 *
 *   - a club MEMBER whose pending booking (their own non-member guests, or a
 *     split guest child) lost its beds — `/book` is exactly right;
 *   - the non-login NON_MEMBER/SCHOOL contact who owns a booking converted from
 *     a public booking request (#707), and any other non-login contact an admin
 *     booked on behalf of — these have `canLogin = false` by construction
 *     (`assertMappableOwnerContact` refuses a login-capable owner outright), so
 *     `/book` bounces them to a login they can never complete.
 *
 * There is no tokenised respond link to offer them either: the bump path
 * revokes the booking's payment links, and the request itself is CONVERTED, so
 * the club's contact page is the only live way back in.
 *
 * Shared by the hand-built HTML template and the `{{rebookNote}}` token the
 * admin-editable body renders, so the two paths cannot drift. The caller owns
 * the base URL — this module deliberately imports nothing.
 */
export function bookingBumpedRebookAction(
  recipientCanBookOnline: boolean,
): EmailLinkAction {
  return recipientCanBookOnline
    ? { label: "Book Again", path: "/book" }
    : { label: "Contact the Club", path: "/contact" };
}
