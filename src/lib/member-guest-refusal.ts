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
 * answer; it does not remove the signal in the PATTERN of answers.
 *
 * WHAT MG3 (#2308) ADDED, AND WHAT IS STILL TRUE AFTERWARDS. #2388 was decided
 * by the owner on 31 Jul 2026 and the three mitigations shipped with MG3, so the
 * paragraph above needs three corrections and one thing it said stands:
 *
 *   * **The wording is no longer the only uniformity.** Two refusals used to
 *     escape the collapse entirely and needed no stopwatch to tell apart:
 *     "Linked member is inactive or not found" (400) and the age-exempt-account
 *     refusal (400) both answered a cross-family probe in their own words with
 *     their own status. `resolveLinkedMemberRecords` now collapses BOTH for a
 *     beyond-family id on a member-initiated path, so the existence oracle they
 *     constituted is closed. Family-scope adds keep them verbatim.
 *   * **Response timing is now equalised, partially and honestly.** Every
 *     collapsed refusal is held to a fixed floor
 *     (`MEMBER_GUEST_REFUSAL_FLOOR_MS`, `member-guest-probe-guard.ts`), which
 *     removes the cheap, reliable measurement — the not-found answer used to
 *     come back in one query's time, every time. It does NOT close the channel:
 *     a refusal slower than the floor still reports its own duration.
 *   * **The probing is now throttled**, per ACTING MEMBER rather than per IP,
 *     and only on attempts that name a beyond-family member — so an ordinary
 *     family booking is not rate-limited at all, and a run of probes across
 *     dates is capped at 15 per quarter-hour and 50 per day. That is what turns
 *     "map a season in an afternoon" into "map a season over three weeks".
 *   * **Every collapsed refusal is now audited**, naming the actor and the
 *     target, and a run of them against the same target raises a distinct
 *     admin-visible row. By the owner's explicit sub-decision this LOGS and
 *     never blocks: a member trying several dates to find one that suits a
 *     friend is the normal case, and refusing them would produce a vague answer
 *     they could not act on.
 *
 * SO THE HONEST STATEMENT AFTER MG3 IS THIS: a single refusal still tells a
 * caller nothing, and a run of them is now slow, capped, and recorded against
 * the caller's name — but the PATTERN of answers still carries the signal it
 * always did, and a patient member who stays inside the daily cap can still
 * learn which nights another member is booked. That residual is deliberate: the
 * owner rejected closing it with an automatic block, on the grounds that the
 * innocent case is indistinguishable from the probing one and only a person can
 * tell them apart. It is now a detectable residual rather than an invisible one.
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
