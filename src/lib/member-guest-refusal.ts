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
 *     dates is capped at 15 per quarter-hour and 50 per day, charged exactly
 *     once per attempt.
 *   * **Every collapsed refusal is now audited**, naming the actor and the
 *     target, and a run of them against the same target raises a distinct
 *     admin-visible row. By the owner's explicit sub-decision this LOGS and
 *     never blocks: a member trying several dates to find one that suits a
 *     friend is the normal case, and refusing them would produce a vague answer
 *     they could not act on.
 *
 * THREE CORRECTIONS THE PRIVACY AND CORRECTNESS REVIEWS FORCED ON THIS FILE, kept
 * here rather than quietly folded in, because the mistakes are instructive and an
 * overclaiming docblock is worse than no docblock at all.
 *
 *   1. **"Fifty probes a day is three weeks to map a season" was wrong by about
 *      a factor of seven.** A lodge season is roughly 150 nights; at fifty a day
 *      that is about THREE DAYS, and a whole year is about seven and a half. The
 *      cap is still worth having — it turns a scripted afternoon into days of
 *      work that leave up to fifty audit rows a day naming the prober and their
 *      target — but it does not make mapping infeasible and this file must not
 *      say that it does.
 *   2. **The throttle briefly WAS the oracle it was meant to remove.** Applied
 *      after member resolution, an unresolvable beyond-family id threw first and
 *      answered with the neutral 403 while a real bookable member answered 429 —
 *      one bit per request, for free, out of the mitigation itself. It is now
 *      spent the moment the family boundary is known, before a single member row
 *      is read, so both answer alike.
 *   3. **"Every collapsed refusal is audited" was not true when it was written.**
 *      `POST /api/bookings/[id]/modify` is a fifth member-facing add path and
 *      carried none of the three mitigations, and `modify-quote`'s
 *      unpaid-subscription branch skipped the handler. Both are fixed; the
 *      audited set is now every refusal on `bookings/quote`, `bookings/create`,
 *      `bookings/guests-add`, `bookings/modify-quote`, `bookings/modify` and
 *      `bookings/modify-dates`.
 *
 * AND ONE LEAK THAT WAS NOT A RESIDUAL AT ALL. The collapse used to be driven by
 * a marker set only on guests a request was ADDING, so a cross-family member
 * guest ALREADY on a booking was never marked and the person-night guard answered
 * for them in full — name and exact booked nights — on every later date change,
 * through a side-effect-free preview that spent no throttle and wrote no audit
 * row. That was a direct read-out rather than a pattern to be inferred, and it
 * defeated all of the above at once. `markCrossFamilyGuestsOnBooking` now derives
 * the set from the live family boundary over the WHOLE proposed party.
 *
 * SO THE HONEST STATEMENT AFTER MG3 IS THIS: a single refusal still tells a
 * caller nothing, and a run of them is now slow, capped, and recorded against
 * the caller's name — but the PATTERN of answers still carries the signal it
 * always did, and a patient member who stays inside the daily cap can still
 * learn which nights another member is booked, over days rather than minutes.
 * That residual is deliberate: the owner rejected closing it with an automatic
 * block, on the grounds that the innocent case is indistinguishable from the
 * probing one and only a person can tell them apart. It is now a detectable
 * residual rather than an invisible one.
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

/**
 * D-8's collapsed cross-family refusal, as a machine code (MG3 #2308, plan §5.4).
 *
 * The wizard needs to tell this refusal apart from every other booking error so
 * it can show it where the booker was working — in the find panel, beside the
 * person they were trying to add — rather than only in the page-level banner.
 * Matching on the message text would work today and break the first time the
 * sentence is reworded.
 *
 * It discloses nothing new: EVERY collapsed refusal carries the same code, for
 * the same reason they all carry the same sentence and the same 403. It says
 * "this is the neutral member-guest refusal", which the body already said
 * verbatim.
 *
 * IT LIVES IN THIS LEAF, not in `booking-guests.ts` where it was first written
 * (privacy re-review of MG3 #2308, finding 3). Two CLIENT components now have to
 * recognise the code — the create wizard and the booking edit panel — and
 * `booking-guests.ts` is a server module carrying the profile gate, the member
 * resolver and the Prisma types with it. This file has no imports at all, which
 * is what makes it safe for both sides. `booking-guests.ts` re-exports it, so
 * every existing import keeps working.
 */
export const MEMBER_GUEST_NOT_ADDABLE_CODE = "MEMBER_GUEST_NOT_ADDABLE";

/**
 * The same refusal, worded for a request that ADDED NOBODY (privacy re-review of
 * MG3 #2308, finding 3).
 *
 * THE SERVER STILL SENDS ONE SENTENCE; THIS IS A CLIENT-SIDE RE-WORDING, and the
 * distinction matters. The collapse above exists so that two refusals cannot be
 * told apart, and varying the SERVER's answer by anything would undo it. What a
 * client may safely do is describe its OWN request more accurately, because it
 * already knows what it asked for: nothing is disclosed by a browser telling its
 * user what the browser just sent.
 *
 * WHY IT IS NEEDED. `MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE` says "this member
 * can't be added", which is true on every path that adds somebody. It is FALSE on
 * the booking edit panel's auto-quote: once a booking already carries a
 * cross-family member guest, the C1 marking makes every date change re-ask the
 * person-night question about them, so moving the dates and adding nobody can be
 * refused with "this member can't be added" — naming an act the booker did not
 * perform, about a person they cannot see referenced anywhere on screen. Bookers
 * read that as a bug, and the honest ones then retry, which is the behaviour the
 * throttle is least able to distinguish from probing.
 *
 * IT IS DELIBERATELY VAGUE ABOUT THE CAUSE, for the same reason its sibling is.
 * "Try different dates" is not promised: the refusal can equally be an unpaid
 * subscription, which no date fixes, and a hint that sends the booker on a
 * date-by-date hunt is exactly the pattern #2388 asks us not to encourage.
 */
export const MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE =
  "This change can't be made to this booking right now. If it keeps happening, please contact the club.";
