import { NextResponse } from "next/server";

/**
 * The ONE sentence every deleted-booking refusal says (#2700).
 *
 * WHY A MESSAGE AND NOT A BARE 404. `INV-ADDPAY-031` — the house shape for a
 * deleted-booking guard, set by `requested-room/options` (#2673) and
 * `refund-request` POST (#2674) — says the 404 body must be byte-identical to
 * the ordinary not-found body, so an authorised caller cannot tell a deleted
 * booking from one that never existed. The owner's 10 Aug 2026 walkthrough of
 * #2700 deliberately departs from that half of the rule on the surfaces below,
 * and the departure is worth stating precisely because the general rule is the
 * opposite of it.
 *
 * The people who reach these surfaces are following a link from an email the
 * club itself sent — a consent request to a guest, a booking page bookmark to
 * the owner. Handing them "Booking not found" is a dead end that reads as a
 * fault. Telling them the booking was cancelled or removed is an explanation
 * they can act on.
 *
 * THAT IS SAFE ONLY BECAUSE OF WHERE THE GUARD SITS. Every caller of this
 * module places the check AFTER its authorisation check, so to see this
 * sentence at all you must already be the guest on that booking, its owner, or
 * an admin. A stranger still gets 403 and learns nothing, which is the property
 * `INV-ADDPAY-031`'s ordering half exists to protect and which is untouched
 * here. Disclosure to somebody already entitled to the record is not an oracle.
 *
 * WHAT THE SENTENCE DELIBERATELY DOES NOT SAY:
 * - **Who deleted it.** The guest does not need it, the system cannot always
 *   assert it accurately, and naming an actor invites the reader to wonder
 *   whether somebody made a mistake.
 * - **The booking owner's name.** That would leak a member's name on a booking
 *   the club has deleted. "Contact the club" costs the reader nothing.
 *
 * ONE MESSAGE, NOT THREE. The consent write and both read surfaces share this
 * constant precisely so the wording cannot drift into three variants that say
 * subtly different things about the same event.
 */
export const DELETED_BOOKING_MESSAGE =
  "This booking has been cancelled or removed. Contact the club if you need to know more.";

/**
 * The shared refusal, as an HTTP response.
 *
 * 404, not 410: 404 is the status `INV-ADDPAY-031` already fixed for a deleted
 * booking across this route folder, every existing client treats it as
 * "gone", and the decision above changes the BODY, not the status. Uniform for
 * every role, including a Full Admin — the record-viewing exemption on
 * `bookings/[id]/page.tsx` belongs to the page, not to the APIs beneath it.
 */
export function deletedBookingRefusalResponse(): NextResponse {
  return NextResponse.json({ error: DELETED_BOOKING_MESSAGE }, { status: 404 });
}
