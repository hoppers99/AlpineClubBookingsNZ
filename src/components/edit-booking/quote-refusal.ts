import {
  MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE,
  MEMBER_GUEST_NOT_ADDABLE_CODE,
} from "@/lib/member-guest-refusal";

/**
 * How a refused `modify-quote` is worded for the person who caused it.
 *
 * Moved verbatim from `edit-booking-panel.tsx` (#2690).
 */

/**
 * Did the quote request this panel just sent actually try to ADD anybody?
 *
 * Finding 3 of the MG3 (#2308) privacy re-review. Once a booking carries a
 * cross-family member guest, C1's marking makes every date change re-ask the
 * person-night question about that member, so `modify-quote` can answer D-8's
 * collapsed refusal — "This member can't be added to this booking right now." —
 * to a request whose body contains no `addGuests` at all. The booker changed two
 * dates and is told they failed to add somebody. It reads as a bug, and the
 * natural response to a bug is to try again, which is the behaviour #2388's
 * throttle is least able to tell apart from probing.
 *
 * The payload is this component's own JSON, one parse per quote, so reading it
 * back is cheap and cannot be wrong about what was sent. It fails CLOSED — an
 * unparseable payload is treated as an add, which keeps the server's own wording
 * — because the alternative is silently re-writing a refusal that WAS about an
 * add.
 */
export function quotePayloadAddsGuests(payloadJson: string): boolean {
  try {
    const body = JSON.parse(payloadJson) as { addGuests?: unknown };
    return Array.isArray(body.addGuests) && body.addGuests.length > 0;
  } catch {
    return true;
  }
}

/**
 * The sentence to show for a refused quote.
 *
 * Only ONE case is re-worded: D-8's collapsed member-guest refusal on a request
 * that added nobody. Everything else — including the same collapsed refusal on a
 * request that DID add somebody — is shown exactly as the server sent it. The
 * server's answer is unchanged either way; this only stops the panel asserting
 * an act the booker did not perform. See `MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE`.
 */
export function quoteRefusalMessage(
  data: { code?: unknown; error?: unknown },
  requestAddsGuests: boolean,
): string {
  if (!requestAddsGuests && data?.code === MEMBER_GUEST_NOT_ADDABLE_CODE) {
    return MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE;
  }
  return typeof data?.error === "string" && data.error
    ? data.error
    : "Failed to get quote";
}
