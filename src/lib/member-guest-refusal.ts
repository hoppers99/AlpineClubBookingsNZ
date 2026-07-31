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
 * this one message with ONE status (403). A 409 for a collapsed night conflict
 * would have defeated even that much: the status alone would have said "that
 * member is already booked those nights".
 *
 * WHAT THAT DOES AND DOES NOT BUY, stated exactly, because an overclaim here is
 * how somebody later builds on a guarantee that was never made.
 *
 * WHAT IT DELIVERS: one refusal is byte-identical whatever the REASON. A caller
 * holding a single refused response cannot tell "there is no such member" from
 * "that member's subscription is unpaid" from "that member is already booked
 * those nights" from "that member's profile is incomplete" — same words, same
 * 403, so a single probe answers only "not right now".
 *
 * WHAT IT DOES NOT DELIVER: the refusal is DATE-DEPENDENT, and a caller who
 * repeats it is not limited to a single probe. Adding the same member across a
 * run of dates and recording which attempts succeed maps the nights that member
 * is already booked on — at ANY lodge, since the person-night guard is
 * club-wide. Repeating that across seasons separates a member who is refused on
 * every date in a year (which is what unpaid subscription looks like) from one
 * refused only on scattered nights. Uniform wording removes the label from each
 * answer; it does not remove the signal in the PATTERN of answers. Nor does it
 * equalise response timing, and nothing here rate-limits the probing: the tight
 * `memberGuestConsentRespond` limiter covers the consent-answer endpoint, not
 * the quote and create paths this refusal is returned from.
 *
 * Closing the correlation channel needs a different tool — a discoverability
 * decision plus per-caller throttling on the add paths — which is MG3's
 * find-endpoint work. It is tracked as a follow-up issue on MG3 (#2388)
 * rather than left as an implied property of this constant.
 *
 * STRICTLY CROSS-FAMILY, STRICTLY PRE-CONSENT. A family-scope add (D-6) keeps
 * today's detailed, actionable errors verbatim — a member adding their own child
 * needs to be told which field is missing, and nothing is disclosed to somebody
 * who is already in that household. Every collapse site therefore takes the
 * `BEYOND_FAMILY` id set computed by `computeMemberGuestBoundary` and applies the
 * collapse to that set only.
 *
 * ONE MORE THING IT DELIBERATELY DOES NOT DO: it does not hide the fact that a
 * refusal happened at all. A caller always learns "this member cannot be added
 * right now" — that is unavoidable, because the booking genuinely cannot
 * proceed, and it is the fact the paragraph above turns into a probe.
 */
export const MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE =
  "This member can't be added to this booking right now.";

/** The single status every collapsed refusal returns — see the note above. */
export const MEMBER_GUEST_CROSS_FAMILY_REFUSAL_STATUS = 403;
