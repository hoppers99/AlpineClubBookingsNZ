/**
 * #2668 — the only thing a browser may honestly say when it does not know
 * whether a write landed.
 *
 * WHY THIS EXISTS. `fetch` rejects in two quite different situations:
 *
 *  1. the request never left, or never reached the server — nothing was written;
 *  2. the request reached the server, the server processed it, and the
 *     connection dropped before the response came back — the write may well
 *     have committed.
 *
 * A client cannot tell those apart. It sees one rejected promise for both. So a
 * message that states case 1 as fact ("your room request was not saved",
 * "nothing was recorded") is a guess presented as a certainty, and on the flaky
 * mobile connection that produces it — a member on a phone at a lodge, an admin
 * on lodge wifi — the guess is wrong often enough to matter. It sends the
 * person back to redo something that may already have happened, and for a
 * non-idempotent write (recording a cash payment, closing a refund task) that
 * invites a duplicate.
 *
 * The same is true of a response that ARRIVES but cannot be read — a body that
 * is not the JSON expected, or a `response.json()` that throws. The server has
 * already done whatever it was going to do; the client simply cannot see the
 * receipt.
 *
 * WHERE THE LINE IS. Saying the ATTEMPT failed is honest and stays: "Failed to
 * save arrival time" (`arrival-time-editor.tsx`) claims nothing about the
 * stored row. Saying the RECORD did not change is the claim a client is not
 * entitled to make. Only the second is what this module replaces.
 *
 * A refusal the SERVER reported — a 403, a 409, a validation 400 — is not
 * affected: there the server is the one making the claim, and it is the one
 * that knows. Those messages keep their confident wording.
 *
 * The sentence shape is the one already merged for the waitlist offer card
 * (`waitlist-offer-card.tsx`, #2623 T8), which was the first surface in this
 * repository to get this right; it now reads its copy from here so there is a
 * single wording rather than a convention two files agree on by accident.
 *
 * Enforced by `src/lib/__tests__/unverified-write-copy-contract.test.ts`, which
 * re-walks the tree and fails if any network-failure branch grows a confident
 * "nothing happened" claim again.
 */

/**
 * Build the message for a write whose outcome the client could not read.
 *
 * @param outcome     what could not be verified, phrased as the thing that may
 *                    or may not have happened — e.g. `"your room request was
 *                    saved"`. Read as "we could not verify whether {outcome}".
 * @param howToCheck  a complete sentence telling the person how to find out.
 *                    Always route them at the server's own value (reload the
 *                    page, reload the board) rather than at the screen they are
 *                    looking at, which is the stale one.
 */
export function unverifiedWriteMessage(
  outcome: string,
  howToCheck: string,
): string {
  return `The service response could not be read, so we could not verify whether ${outcome}. ${howToCheck}`;
}
