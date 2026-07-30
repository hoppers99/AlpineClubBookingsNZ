/**
 * The ONE neutral refusal a cross-family member-guest add is allowed to return
 * ("+ Add Member Guest", epic #2305, MG2 #2307, owner decision **D-8**).
 *
 * WHY THIS FILE HAS NO IMPORTS. It is read by `booking-guests.ts` (the profile
 * gate), by `booking-member-night-conflicts.ts` (the person-night guard), and by
 * the two routes that refuse an unpaid member guest. `booking-guests.ts` takes an
 * INJECTED `db` narrowed to two models precisely so it can run inside a booking
 * transaction without dragging the Prisma client in; if this constant lived
 * alongside the settings loader or the notification dispatcher, importing it
 * there would pull `@/lib/prisma` into the transaction-safe module and create an
 * import cycle back through `member-guest-add-policy.ts`. A leaf with a single
 * string cannot do either.
 *
 * WHAT D-8 ACTUALLY ASKS FOR, because it is easy to implement the wrong half.
 * MG2 is the release in which a cross-family `memberId` first gets past
 * authorization, so from here on three refusals become reachable by anybody who
 * can call the booking API, against a member the caller may have no relationship
 * with whatsoever:
 *
 *   1. the unpaid-subscription refusal, which named the member AND their
 *      financial status (and, on the create route, their invoice number and a
 *      link to their invoice);
 *   2. the person-night conflict, which returned the member's already-booked
 *      nights;
 *   3. the profile-completeness gate, which returned their name, which fields
 *      of their profile are blank, and whether they hold a login.
 *
 * The refusal ITSELF cannot be removed — each one enforces a real invariant — so
 * what D-8 removes is the ability to tell the three APART. All three collapse to
 * this one message with ONE status (403), so a caller probing a stranger learns
 * only "not right now" and cannot use the booking API as a subscription-status,
 * occupancy, or profile oracle. A 409 for a collapsed night conflict would have
 * defeated the whole exercise: the status alone would have said "that member is
 * already booked those nights".
 *
 * STRICTLY CROSS-FAMILY, STRICTLY PRE-CONSENT. A family-scope add (D-6) keeps
 * today's detailed, actionable errors verbatim — a member adding their own child
 * needs to be told which field is missing, and nothing is disclosed to somebody
 * who is already in that household. Every collapse site therefore takes the
 * `BEYOND_FAMILY` id set computed by `computeMemberGuestBoundary` and applies the
 * collapse to that set only.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not equalise response TIMING, and
 * it does not hide the fact that a refusal happened. A caller can still learn
 * "this member cannot be added right now" — that is unavoidable, because the
 * booking genuinely cannot proceed. Timing equalisation belongs with MG3's
 * find-endpoint work, where the discoverability question is decided.
 */
export const MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE =
  "This member can't be added to this booking right now.";

/** The single status every collapsed refusal returns — see the note above. */
export const MEMBER_GUEST_CROSS_FAMILY_REFUSAL_STATUS = 403;
