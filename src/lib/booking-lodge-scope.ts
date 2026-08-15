/**
 * The booking-create lodge contract, shared by `POST /api/bookings` and the two
 * wizards that call it (#2701).
 *
 * Its own module, and client-safe by construction — no imports, no Prisma, no
 * Next — because `src/lib/lodges.ts` reaches the database and a wizard
 * importing it would drag the server into the browser bundle.
 *
 * A booking must name its lodge. The server used to fill a missing one with the
 * club's DEFAULT lodge, which is how a member could pay for a stay at a lodge
 * they were never shown: a failed lodge list leaves `LodgeSelect` rendering
 * nothing and the selection `null`, and the wizard posted no lodge at all.
 */

/** Machine-readable code on the 400 body, so a client need not match prose. */
export const BOOKING_LODGE_REQUIRED_CODE = "BOOKING_LODGE_REQUIRED";

/**
 * What a member is told when their booking cannot name a lodge, and what the
 * wizard shows in place of the submit. Written for someone who did nothing
 * wrong and cannot see a lodge selector, because in this state there is not one
 * on screen to point at.
 */
export const BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE =
  "We could not load the list of lodges, so we cannot tell which lodge this booking is for — and we will not guess. Nothing has been booked or charged. Try again in a moment.";
