/**
 * The admin repair for a stranded zero-dollar waitlist confirm (#2649).
 *
 * #2648 made the strand VISIBLE — the member is told plainly that their offer
 * was used up and not to retry, and a `critical`
 * `waitlist.confirm_offer_release_failed` audit row names the booking in
 * Admin -> Audit log — but it left the booking unrepairable from the admin UI.
 * The waitlist screen lists only `WAITLISTED` / `WAITLIST_OFFERED`, Force
 * Confirm refuses any other status, and Record payment deliberately refuses a
 * booking with nothing owing, so putting the member's place back needed direct
 * database access.
 *
 * This module holds the strings that repair shares with its tests, its runbook
 * entry in `docs/MAINTENANCE.md` and the audit-writer census, so there is one
 * spelling of each rather than four.
 */

/**
 * The audit action the repair writes. Its metadata carries the id of the
 * `waitlist.confirm_offer_release_failed` row it resolves, so an operator
 * reading either row can find the other and the trail closes.
 */
export const RETURN_TO_WAITLIST_AUDIT_ACTION = "waitlist.returned_to_waitlist";

/**
 * Refused because the booking is not sitting in `PAYMENT_PENDING`. Says where
 * to look rather than naming an internal status the operator cannot act on.
 */
export const RETURN_TO_WAITLIST_STATUS_MESSAGE =
  "Only a booking still sitting in Payment pending can be returned to the waitlist. This one has moved on — reload the page to see where it is now.";

/**
 * Refused because the booking has a price. A priced booking has a payment path,
 * so it is not the stranded shape and this is not an "un-confirm" tool
 * (#2649 owner decision: `PAYMENT_PENDING` at zero only).
 */
export const RETURN_TO_WAITLIST_PRICED_MESSAGE =
  "This booking has a balance to pay, so it still has a payment path and is not a stranded free confirm. Cancel it instead if the member should leave the queue.";

/**
 * Refused because a `Payment` row exists. A free confirm mints its own $0
 * payment only AFTER it reaches `PAID` (#2623), so a payment row means the
 * confirm finished and this booking is not stranded.
 */
export const RETURN_TO_WAITLIST_PAYMENT_PRESENT_MESSAGE =
  "This booking already has a payment record, so its confirmation completed and it is not stranded. Nothing was changed.";

/**
 * The status-guarded claim matched no row: another writer moved the booking
 * between the re-read and the claim. Nothing was written, and the operator is
 * told exactly that rather than being left to guess.
 */
export const RETURN_TO_WAITLIST_CLAIM_LOST_MESSAGE =
  "The booking changed while it was being returned to the waitlist, so nothing was written. Reload the page and check where it ended up.";

/**
 * Prisma's transaction contention codes: P2028 (transaction API error, which
 * covers an exhausted `maxWait`/`timeout`) and P2034 (write conflict/deadlock,
 * retryable by definition). Same set and same 503 answer as
 * `waitlist-confirm/route.ts`, `admin-bed-allocation-routes.ts`,
 * `admin/site-style/route.ts` and `deletion-request-decision.ts`, for the reason
 * `docs/CONCURRENCY_AND_LOCKING.md` gives: a counterpart writer legitimately
 * holds `lock(1)` or the lodge key for the length of a whole transaction, so an
 * exhausted wait is contention rather than a fault, nothing was committed, and
 * the real remedy is "again shortly", not "differently".
 *
 * This route needs the distinction more than most: it exists precisely BECAUSE
 * lock contention broke the confirm's compensating release (#2623 T4). Reporting
 * its own contention as an opaque 500 would tell the operator the repair is
 * broken when the honest answer is that something else is holding the booking.
 */
const RETURN_TO_WAITLIST_CONTENTION_CODES: ReadonlySet<string> = new Set([
  "P2028",
  "P2034",
]);

export function isReturnToWaitlistTransactionContention(
  error: unknown,
): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETURN_TO_WAITLIST_CONTENTION_CODES.has(code);
}

/**
 * Refused because the locked transaction could not take its locks in time.
 * Nothing was written, so the operator is told to retry rather than to escalate.
 */
export const RETURN_TO_WAITLIST_CONTENDED_MESSAGE =
  "Something else is holding this booking right now, so it could not be returned to the waitlist in time. Nothing was changed — try again in a moment.";
