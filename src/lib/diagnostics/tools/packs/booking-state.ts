/**
 * AI Diagnostics — AID-6B booking/membership pack, part 4: THE AUTHORITATIVE
 * REGISTRY ENTRIES (#2376, epic #2369).
 *
 * THREE entries, and they are the ones an operator should reach for FIRST when the
 * question is "why can this not happen".
 *
 *   diagnostics.booking_block_state        bookings + membership   server_owned
 *   diagnostics.booking_capacity_by_night  bookings                server_owned
 *   diagnostics.member_eligibility_state   membership              server_owned
 *
 * PERMISSIONS. `booking_block_state` requires BOTH `bookings:view` and
 * `membership:view`, AND-ed, re-read from the database on every invocation: its
 * answer composes booking evidence (status, nights, capacity, review, the exception
 * queue) with MEMBERSHIP evidence (the paid-up-adult requirement and the
 * adult-member hosting rule both read live `Member` rows and season subscription
 * facts), which is exactly the combination the epic says requires every relevant
 * area. A Booking Officer without `membership:view` is denied it and told which area
 * is missing; they can still use every other booking entry in the pack, which needs
 * `bookings:view` alone. `booking_capacity_by_night` needs `bookings:view` only —
 * capacity and bed allocation are governed by the `bookings` area, which is what
 * `/admin/bed-allocation` and `/api/admin/bed-allocation` resolve to in the route
 * matrix. `member_eligibility_state` needs `membership:view` only.
 *
 * NEITHER REQUIRES `support:view`, which is #2376's owner decision and its first two
 * acceptance criteria. An argument can never move an entry between permission sets:
 * `requiredAreas` is fixed on the entry and `invoke.ts` authorizes before it parses
 * arguments.
 *
 * WHAT MAKES THESE THREE DIFFERENT FROM THE REST OF THE PACK. The other twelve
 * entries return STORED ROWS. These return the application's OWN AUTHORITATIVE
 * ANSWER: the same soft-policy evaluator the member's exception request runs
 * through, the same review-reason derivation the officer queue renders, the same
 * capacity engine every booking path checks against, the same edit-window
 * classifier the member's own Edit button obeys, the same lifecycle label the admin
 * badge shows, the same subscription rule every gate shares, and the same
 * adult-member-host predicate the hosting policy enforces. #2375 forbids a second
 * definition of an answer an admin screen already owns, and #2376 says the same
 * about booking and membership rules in as many words.
 *
 * THE RESIDUAL, STATED PLAINLY. A `server_owned` entry runs on the application's
 * own FULL-PRIVILEGE Prisma connection, so there is no column grant behind it and
 * the projections in THIS file are the only boundary. That is the same residual
 * AID-6A recorded for its four server-owned entries and AID-6C for its one, and it
 * means every edit to a projection below, or to `booking-evidence.ts`, is a
 * security-relevant change that needs the review a grant would get.
 *
 * READ ONLY. These entries compute; they never write, never call a provider, never
 * take a lock, and their codes are a diagnosis rather than an action taken.
 */

import "server-only";

import { z } from "zod";

import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "../define";
import {
  BOOKING_BLOCKER_CODES,
  MEMBER_ELIGIBILITY_CODES,
  readBookingBlockStateEvidence,
  readBookingCapacityEvidence,
  readMemberEligibilityEvidence,
} from "./booking-evidence";
import {
  AID6B_DESCRIPTION_TAIL,
  AID6B_NIGHT_ROW_LIMIT,
  AID6B_SCOPE_TAIL,
  AID6B_SINGLE_ROW_BYTE_LIMIT,
  AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE,
  AID6B_WIDE_BYTE_LIMIT,
  countOrNull,
  dateOnlyOrNull,
  signedIntegerOrNull,
} from "./booking-shared";
import {
  RECORD_ID,
  boolOf,
  codeListOrNull,
  countOf,
  instantOrNull,
  recordRefOrNull,
  serverLabelOrNull,
  stableCodeOrNull,
} from "./finance-shared";

export const DIAGNOSTICS_BOOKING_BLOCK_STATE_TOOL_ID =
  "diagnostics.booking_block_state";
export const DIAGNOSTICS_BOOKING_CAPACITY_TOOL_ID =
  "diagnostics.booking_capacity_by_night";
export const DIAGNOSTICS_MEMBER_ELIGIBILITY_TOOL_ID =
  "diagnostics.member_eligibility_state";

/**
 * The operator-facing description of every booking blocker code, kept beside the
 * entry so the words the model reads and the words a UI renders come from one
 * place.
 *
 * Exported because #2378 needs it to render a case, and because a test pins that
 * every declared code has a sentence — a code with no sentence is a code a model
 * will paraphrase, and AID-6C's review found exactly that: `manual_refund_open`
 * handed to a model bare reads as "a refund is in progress", the opposite of its
 * meaning. The same trap is live here. `exception_request_open` bare reads as "the
 * member has an exception", which sounds like permission GRANTED; it means nobody
 * has decided and the booking is waiting on an officer.
 */
export const BOOKING_BLOCKER_DESCRIPTIONS: Record<
  (typeof BOOKING_BLOCKER_CODES)[number],
  string
> = {
  booking_deleted:
    "This booking has been soft-deleted. The member cannot see it, nothing will act on it, and every other check below is suppressed because it no longer applies.",
  booking_lifecycle_terminal:
    "This booking is CANCELLED or BUMPED. Nothing more can be confirmed, allocated or reviewed against it, and every other check below is suppressed because it no longer applies. Its MONEY may still need attention — that is a finance question this tool cannot see.",
  booking_waitlisted:
    "This booking is on the waitlist. It holds no beds and is not admitted, which is the reason it does not fit — not a separate fault.",
  member_night_conflict:
    "A member on this booking is already staying on one of these nights under another booking. The platform refuses to double-book a member's night, and one of the two bookings has to change.",
  capacity_exceeded:
    "On at least one night this booking's party needs more beds than the lodge has left. Only a deliberate admin over-capacity confirmation can admit it, and the shortfall is per night — see the capacity tool.",
  whole_lodge_held:
    "Another booking holds SOLE OCCUPANCY of the lodge on at least one of these nights. That is a hard block on any other admission and an admin over-capacity override cannot punch through it.",
  admin_review_pending:
    "A Booking Officer review of this booking is still PENDING, and while it is the party is BLOCKED from checking in. Today the only reason is a party of under-18s with no adult. An officer has to decide before they arrive.",
  hosting_review_pending:
    "An adult-member hosting review of this booking is still PENDING: it has non-member guests on nights when no adult member is staying. This does NOT block arrival — it is a club membership rule an administrator may accept, and it clears itself the moment an adult member covers the nights.",
  policy_minimum_stay:
    "These nights break a minimum-stay policy that is in force at this lodge. The member can ask a Booking Officer to allow it as an exception.",
  policy_adult_member_hosting:
    "The adult-member hosting rule is BROKEN as this booking currently stands: non-member guests are staying on nights no qualifying adult member covers. The member can ask a Booking Officer to allow it as an exception.",
  policy_paid_up_adult_member:
    "This booking needs a PAID-UP adult member in the party and does not have one — an adult member whose season subscription is unsettled does not count. Either the subscription is settled or the member asks a Booking Officer to allow it.",
  exception_request_open:
    "The member has ASKED a Booking Officer to allow something and nobody has decided yet. Nothing has been granted: the ball is with an officer.",
  exception_hold_expiring:
    "An open exception request is holding real beds and that hold has a deadline. If nobody decides before it passes, the reaper releases the beds and closes the request as EXPIRED — the member loses their place.",
  edit_window_locked:
    "The member cannot change this booking themselves in its current status and dates. A change to a night that is today or in the past needs a locked-period change request an administrator applies.",
};

/**
 * The operator-facing description of every member eligibility code, on the same
 * terms and pinned by the same kind of test.
 */
export const MEMBER_ELIGIBILITY_DESCRIPTIONS: Record<
  (typeof MEMBER_ELIGIBILITY_CODES)[number],
  string
> = {
  member_erased:
    "This account has been ERASED by an approved deletion request. Its personal details are gone and it must never be reactivated, however ordinary the remaining row looks.",
  member_archived:
    "This membership is ARCHIVED. An archived member is not a current member and does not qualify as an adult-member host.",
  member_cancelled:
    "This membership is CANCELLED. A cancelled member is not a current member and does not qualify as an adult-member host.",
  member_inactive:
    "This account is INACTIVE with no cancellation and no archival recorded — somebody deactivated it. That is a different state from cancelled and from erased.",
  membership_type_blocks_booking:
    "This member's membership TYPE for the season blocks booking outright. Paying a subscription will not change that; the type or its configuration has to.",
  subscription_unpaid:
    "This member owes an unsettled season subscription. What that COSTS them depends on the club's lockout mode, which is reported beside this: NO_BLOCK means nothing, NON_MEMBER_PRICING means they and their party are repriced, HARD_BLOCK means they cannot book at all.",
  not_adult_age_tier:
    "This member is not on the ADULT age tier, so they cannot act as the responsible adult member for a party.",
  cannot_log_in:
    "This member has no login, so they cannot act for themselves: an administrator has to do it on their behalf.",
  induction_outstanding:
    "An administrator has flagged that this member must complete a lodge induction, and no completed induction exists. In THIS release that does NOT block any booking — it gates nomination and shows on their dashboard. Do not report it as the reason a booking is refused.",
};

/**
 * The catalogues as ONE server-owned block of text each, interpolated into the
 * entries' `description` so they actually reach the model.
 *
 * AID-6C shipped a catalogue whose only consumer was its own test, and its review
 * called that a HIGH finding for a reason: a stable code is only better than prose
 * if the prose travels with it. A test pins that every code appears in the entry's
 * model-facing text, whichever field carries it.
 *
 * THE `description` AND NOT THE `evidenceScope`, and the reason is a measurement
 * rather than a preference. `render.ts` puts the scope inside EVERY result block
 * and clips that block at `DIAGNOSTICS_TOOL_BOUNDS.renderedBlockMaxChars` by
 * dropping whole rows from the tail. `booking_block_state`'s scope with the
 * 3 101-character blocker catalogue inside it rendered an empty block of 7 545 of
 * the 8 000 available, which is not enough room for the entry's own single row —
 * so the renderer dropped the evidence and left a header claiming one row above a
 * listing of none. `registry.test.ts`'s "stays HONEST" contract caught it.
 *
 * A catalogue is IDENTICAL for every result, so the per-result block is the wrong
 * place to spend on it: the `description` reaches the model once with the tool
 * definition and stays in context for every call, while the block's budget goes to
 * the evidence. Both catalogues move for one rule rather than one of them moving
 * for one measurement.
 */
const BOOKING_BLOCKER_CATALOGUE_TEXT = BOOKING_BLOCKER_CODES.map(
  (code) => `${code} = ${BOOKING_BLOCKER_DESCRIPTIONS[code]}`,
).join(" ");

const MEMBER_ELIGIBILITY_CATALOGUE_TEXT = MEMBER_ELIGIBILITY_CODES.map(
  (code) => `${code} = ${MEMBER_ELIGIBILITY_DESCRIPTIONS[code]}`,
).join(" ");

// ---------------------------------------------------------------------------
// 1. The authoritative booking block state.
// ---------------------------------------------------------------------------

const bookingIdArgsSchema = z.object({ bookingId: RECORD_ID }).strict();
type BookingIdArgs = z.infer<typeof bookingIdArgsSchema>;

const bookingIdInputSchema = {
  type: "object" as const,
  properties: {
    bookingId: {
      type: "string",
      description:
        "The EXACT booking record id, as returned by diagnostics.booking_search. Not the eight-character booking reference.",
    },
  },
  required: ["bookingId"],
  additionalProperties: false as const,
};

const bookingBlockState = defineDiagnosticsTool<BookingIdArgs>({
  id: DIAGNOSTICS_BOOKING_BLOCK_STATE_TOOL_ID,
  source: "server_owned",
  label: "Authoritative booking block state",
  description: `Returns this platform's OWN authoritative answer for why ONE booking cannot proceed — not a second reading of its columns. It runs the same soft-policy evaluator a member's exception request runs through (minimum stay, adult-member hosting, paid-up adult member), the same review-reason derivation the officer queue renders, the same per-night capacity engine every booking path checks against, the same member-night conflict scan, and the same edit-window classifier the member's own Edit button obeys. It gives the booking's lifecycle state, whether a Booking Officer review or an adult-member hosting review is still pending, the review reason codes, the live policy violation codes and whether an exception request for them would HOLD beds, the number of nights short of capacity and the tightest spare-bed figure, the nights another booking holds exclusively, how many member-night conflicts exist, the open exception requests and how many bed-nights they are actually holding with the deadline, whether the MEMBER could change the booking themselves, and stable blocker codes in the order they should be acted on. Needs BOTH bookings and membership access. BLOCKER CODES, in priority order — use these exact meanings and do not paraphrase them: ${BOOKING_BLOCKER_CATALOGUE_TEXT} ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["bookings", "membership"],
  evidenceScope: `The authoritative blocking state of ONE booking, computed by the same code the booking and officer surfaces use, true as at its own observed instant.

WHAT EACH FIELD MEANS WHERE IT IS NOT OBVIOUS. bookingLifecycleState is "live", "terminal" (CANCELLED or BUMPED) or "deleted" (soft-deleted). ON A TERMINAL OR DELETED BOOKING EVERY OTHER CHECK IS SUPPRESSED — no policy is evaluated, no capacity is read, no conflict is scanned, and blockerCodes carries only the lifecycle code. That is deliberate: a cancelled booking cannot break a minimum stay or exceed capacity, and reporting that it does would be a false and actionable finding about a booking that is simply over. Such a booking's MONEY may still need attention and this tool cannot see it — that needs finance access and the finance diagnostics tools.

tightestSpareBeds is the WORST night's beds remaining AFTER this booking's own party is counted, with this booking excluded from the occupancy figure; a negative value is a shortfall. It is null on a terminal or deleted booking, where no capacity read was performed — null means "not measured", never "it fits". The same is true of memberNightConflictCount, shortfallNightCount and wholeLodgeHeldNightCount: all four are ABSENT rather than 0 whenever the calculation behind them did not run, so a 0 in any of them is a measurement and an absence is not. openExceptionRequestCount and exceptionHeldNightCount are read on every booking including a cancelled one, so a 0 there IS a measurement. shortfallNightCount is 0 on a WAITLISTED or WAITLIST_OFFERED booking's blocker list by design: a waitlisted booking does not fit by definition, so the waitlist status is reported as the reason and the shortfall as a supporting fact rather than as a separate fault.

exceptionHeldNightCount is the ONLY reliable test of whether an open request is holding real beds. Never infer it from exceptionHoldExpiresAtUtc being present: a request written before that column existed can be holding beds with no deadline recorded, and the platform's own schema warns against exactly that inference. memberCanModify answers whether the MEMBER could change this booking themselves, not whether an administrator could — an administrator always can, with an override.

BLOCKER CODES. blockerCodes is in PRIORITY order — report the first one as the primary problem and mention the rest as also true. Absent means nothing is blocking. Each code's exact meaning is in this tool's own description; use those words and do not paraphrase them.

WHAT THIS DOES NOT COVER. A NEW-BOOKING policy-exception request lives in a different record with no booking id until it is converted, so it is not counted here. Induction does not gate any booking path in this release. Bed ALLOCATION is a separate question from capacity — a booking can fit and still have no bed assigned. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: bookingIdArgsSchema,
  inputSchema: bookingIdInputSchema,
  readEvidence: (args) =>
    readBookingBlockStateEvidence({ bookingId: args.bookingId }),
  /**
   * TWENTY-FOUR fields, which is the substrate's hard `maxFieldsPerRow` exactly —
   * gate 8 refuses a wider row outright rather than trimming one, so this
   * projection is at its ceiling and adding a field means removing one.
   *
   * What was left out, and where to get it: the lodge id and name, the guest count
   * and the money are all in `booking_diagnostic_summary`; the per-night capacity
   * detail is in `booking_capacity_by_night`; the exception requests' own kinds and
   * statuses are in `booking_exception_request_state`.
   */
  project: (row) => ({
    bookingId: recordRefOrNull(row.booking_id) ?? "",
    bookingReference: recordRefOrNull(row.booking_reference) ?? "",
    ownerMemberRef: recordRefOrNull(row.owner_member_ref) ?? "",
    bookingStatus: stableCodeOrNull(row.booking_status),
    bookingLifecycleState: stableCodeOrNull(row.booking_lifecycle_state),
    checkIn: dateOnlyOrNull(row.check_in) ?? "",
    checkOut: dateOnlyOrNull(row.check_out) ?? "",
    adminReviewPending: boolOf(row.admin_review_pending),
    hostingReviewPending: boolOf(row.hosting_review_pending),
    // Comma-joined stable codes from a closed server-owned set; `null` when there
    // are none, which is an honest "no review reason" rather than an empty string a
    // consumer would have to guess about.
    reviewReasonCodes: row.review_reason_codes === null
      ? null
      : codeListOrNull(String(row.review_reason_codes).toLowerCase()),
    policyViolationCodes: row.policy_violation_codes === null
      ? null
      : codeListOrNull(String(row.policy_violation_codes).toLowerCase()),
    policyCapacityMode: stableCodeOrNull(row.policy_capacity_mode),
    // `countOrNull` and NOT `countOf` on all three. The source emits `null` when
    // the conflict scan or the capacity read did not run — which it does on every
    // terminal or deleted booking — and `countOf` maps `null` to `0`, turning "not
    // measured" back into an affirmative "none" at the last step. The helper and
    // the source have to agree or the fix only holds on one side.
    memberNightConflictCount: countOrNull(row.member_night_conflict_count),
    shortfallNightCount: countOrNull(row.shortfall_night_count),
    wholeLodgeHeldNightCount: countOrNull(row.whole_lodge_held_night_count),
    // `signedIntegerOrNull` and NOT `countOf`: this is a SIGNED integer that is
    // negative on a shortfall and NULL when no capacity read happened. `countOf`
    // clamps at zero, which would turn "three beds short" into "exactly full" and
    // "not measured" into "no spare beds" — two different false findings from one
    // wrong helper.
    tightestSpareBeds: signedIntegerOrNull(row.tightest_spare_beds),
    openExceptionRequestCount: countOf(row.open_exception_request_count),
    exceptionHeldNightCount: countOf(row.exception_held_night_count),
    exceptionHoldExpiresAtUtc: instantOrNull(row.exception_hold_expires_at_utc),
    memberCanModify: boolOf(row.member_can_modify),
    editWindowMode: stableCodeOrNull(row.edit_window_mode),
    blockerCodes: codeListOrNull(row.blocker_codes),
    blockerCount: countOf(row.blocker_count),
    observedAtUtc: instantOrNull(row.observed_at_utc) ?? "",
  }),
  rowLimit: 1,
  byteLimit: AID6B_SINGLE_ROW_BYTE_LIMIT,
  // No name and no email — but the booking's owner member id identifies a person to
  // anyone who can resolve it, and the booking reference plus nights is per-person
  // information. ADR-004's per-invocation opt-in applies.
  //
  // ADR-004's opt-in is DECLARED and NOT YET ENFORCED: nothing in the shipped code
  // implements a per-invocation operator consent, and that is recorded as a
  // prerequisite on #2378. This flag must therefore not be leaned on as a control.
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 2. Per-night capacity, as the booking engine computes it.
// ---------------------------------------------------------------------------

const bookingCapacityByNight = defineDiagnosticsTool<BookingIdArgs>({
  id: DIAGNOSTICS_BOOKING_CAPACITY_TOOL_ID,
  source: "server_owned",
  label: "Booking capacity by night",
  description: `Returns ONE row per New Zealand lodge night of a booking's stay, computed by the SAME capacity engine every booking path checks against — not a count of bookings. For each night it gives the beds the rest of the lodge occupies and the beds left (both with THIS booking excluded, so the figures answer "what room is there for it"), how many beds this booking's own party needs that night, the spare beds that would remain, whether it fits, whether another booking holds sole occupancy of the lodge that night, whether this booking itself holds the whole lodge, whether it carries a deliberate admin over-capacity override, how many bed-nights are actually allocated to it, and whether the booking itself is still live, terminal or deleted. The occupancy figure already includes custodian bed holds and beds held by pending policy-exception requests, neither of which has a booking to show for it. At most ${AID6B_NIGHT_ROW_LIMIT} nights. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["bookings"],
  evidenceScope: `Per-night capacity for ONE booking's own nights, from the platform's own capacity engine, true as at its own observed instant.

WHY THE FIGURES EXCLUDE THIS BOOKING. occupiedBedsExcludingThisBooking and availableBedsExcludingThisBooking are computed with this booking taken out of the population, so availableBeds minus partyBedsThisNight is the honest answer to "does it fit". If you want the lodge's total occupancy INCLUDING this booking, add partyBedsThisNight back.

ON A WHOLE-LODGE-HELD NIGHT occupiedBedsExcludingThisBooking IS ABSENT, and absent means "not reportable", never "zero" and never "empty". The capacity engine deliberately pins that figure to the lodge's full capacity on a held night so that a MEMBER reading the public availability payload cannot tell a held night from a genuinely full one. That is right for a member and wrong for you: an operator told "occupied 20 of 20" would conclude the lodge is full when in fact one booking has reserved sole occupancy and the beds are empty, and their next step — chase the other bookings, or over-capacity confirm — would be wrong twice, because an admin over-capacity override cannot punch into a held night at all. So the count is withheld rather than passed off as real, availableBeds is honestly 0, and wholeLodgeHeldByAnotherBooking is the fact that explains it. Say that the lodge is exclusively held, not that it is full.

WHAT IS ALREADY COUNTED, and why a booking query would get it wrong: a custodian bed hold (a hut-leader assignment holding a specific bed for a season) takes a bed out of the pool with NO booking and NO bed-allocation row; a pending policy-exception request in HOLD mode reserves real bed-nights while it waits; and a whole-lodge exclusive hold pins available beds to zero regardless of headcount and cannot be punched through by an admin over-capacity override. All three are in these numbers.

THIS ENTRY DOES NOT SUPPRESS ON A CANCELLED OR DELETED BOOKING, and bookingLifecycleState on every row is why it does not have to. "What room was there on those nights" is a fair and answerable question about a booking that is over — it is often the question an officer is asking BECAUSE it is over — so the figures stand and the row carries the fact that qualifies them. When bookingLifecycleState is "terminal" or "deleted", fitsThisNight is a statement about the LODGE and not an invitation to confirm anything; say the booking is cancelled or deleted first. diagnostics.booking_block_state is the entry that suppresses, and it uses the same three values with the same precedence.

ALLOCATION IS NOT CAPACITY. allocatedBedNights counts the bed-allocation rows this booking has for that night. A booking can fit the lodge and have none — allocation is a separate, later step on the bed-allocation board — so a zero here is not evidence the lodge was full. A stay longer than ${AID6B_NIGHT_ROW_LIMIT} nights is REFUSED rather than clipped, because half a stay's capacity invites a conclusion about the half that was shown; the bed-allocation board answers it for a long stay. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: bookingIdArgsSchema,
  inputSchema: bookingIdInputSchema,
  readEvidence: (args) => readBookingCapacityEvidence({ bookingId: args.bookingId }),
  project: (row) => ({
    bookingId: recordRefOrNull(row.booking_id) ?? "",
    bookingReference: recordRefOrNull(row.booking_reference) ?? "",
    lodgeRef: recordRefOrNull(row.lodge_ref) ?? "",
    // "live", "terminal" or "deleted", on EVERY night row. This entry does not
    // suppress on a terminal booking — "what room was there on those nights" is a
    // fair question about a cancelled one — so the qualifier has to travel with
    // the figures instead. Without it the row said `fitsThisNight: true` about a
    // booking that is over, which is the opposite of what the operator needs.
    bookingLifecycleState: stableCodeOrNull(row.booking_lifecycle_state),
    night: dateOnlyOrNull(row.night) ?? "",
    // `signedIntegerOrNull` and NOT `countOf`: this is `null` on a whole-lodge-held
    // night, where the capacity engine deliberately pins the figure to the lodge's
    // full capacity so a member cannot tell held from full. `countOf` would turn that
    // honest "not reportable" into `0`, which reads as "the lodge is empty" — the
    // opposite of the truth — and a number the engine did not mean as a count.
    occupiedBedsExcludingThisBooking: signedIntegerOrNull(
      row.occupied_beds_excluding_this_booking,
    ),
    availableBedsExcludingThisBooking: countOf(
      row.available_beds_excluding_this_booking,
    ),
    partyBedsThisNight: countOf(row.party_beds_this_night),
    // Signed: negative is a shortfall. See `booking_block_state`'s
    // `tightestSpareBeds` for why `countOf` would be the wrong helper here.
    spareBedsAfterThisBooking: signedIntegerOrNull(row.spare_beds_after_this_booking),
    fitsThisNight: boolOf(row.fits_this_night),
    wholeLodgeHeldByAnotherBooking: boolOf(row.whole_lodge_held_by_another_booking),
    thisBookingHoldsWholeLodge: boolOf(row.this_booking_holds_whole_lodge),
    capacityOverridden: boolOf(row.capacity_overridden),
    allocatedBedNights: countOf(row.allocated_bed_nights),
    observedAtUtc: instantOrNull(row.observed_at_utc) ?? "",
  }),
  rowLimit: AID6B_NIGHT_ROW_LIMIT,
  // Measured, not chosen: see `AID6B_WIDE_BYTE_LIMIT`. Thirty-one nights of
  // four-figure bed counts do not fit under the pack's ordinary ceiling, and a
  // refused capacity read is worse than a clipped listing that says it clipped.
  byteLimit: AID6B_WIDE_BYTE_LIMIT,
  // A booking reference and a set of nights is per-person information even without
  // a name. See `booking_block_state` on ADR-004's opt-in being declared and not
  // yet enforced.
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 3. The authoritative member eligibility state.
// ---------------------------------------------------------------------------

const memberIdArgsSchema = z.object({ memberId: RECORD_ID }).strict();
type MemberIdArgs = z.infer<typeof memberIdArgsSchema>;

const memberEligibilityState = defineDiagnosticsTool<MemberIdArgs>({
  id: DIAGNOSTICS_MEMBER_ELIGIBILITY_TOOL_ID,
  source: "server_owned",
  label: "Authoritative member eligibility state",
  description: `Returns this platform's OWN authoritative answer for ONE member's standing — not a second reading of their columns. It runs the same lifecycle resolver the admin badge shows (including the erasure test, which a plain three-column read misses), the same membership-type resolution the season assignment drives, the same subscription-settlement rule every booking gate shares, the club's own subscription lockout MODE, the same adult-member-host predicate the hosting policy enforces, and the member's induction state. It gives the lifecycle label, whether the account is active and can log in, the age tier, the season year, the membership type key and where that type came from, what the type does to booking and to subscriptions, the stored subscription status and how it was settled, whether a subscription is required and whether it is unsettled, the club's lockout mode, whether the member QUALIFIES as an adult-member host, their induction state, whether an induction gates a booking at all, and stable eligibility codes in the order they should be acted on. ELIGIBILITY CODES, in priority order — use these exact meanings and do not paraphrase them: ${MEMBER_ELIGIBILITY_CATALOGUE_TEXT} ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["membership"],
  evidenceScope: `The authoritative standing of ONE member, computed by the same code the membership surfaces use, true as at its own observed instant.

THE FACT AND THE CONSEQUENCE ARE SEPARATE FIELDS, and conflating them is the most likely way to get this wrong. subscriptionUnpaid is the FACT that a required season subscription is unsettled. subscriptionLockoutMode is the club POLICY that decides what it costs: NO_BLOCK means nothing happens, NON_MEMBER_PRICING means the member and their party are repriced at non-member rates, HARD_BLOCK means they cannot book at all. The same unpaid fact is harmless at one club and a refusal at the next, so never state a consequence without reading the mode.

subscriptionStatus is null when NO season row exists at all, which is a different fact from the stored status NOT_INVOICED ("a row exists and nobody has billed them"). Neither is the same as UNPAID. subscriptionRequired comes from the membership TYPE and the age-tier rule, not from the row: a NOT_REQUIRED type never owes one, and a type based on age tier is dominated by a NOT_REQUIRED season row.

membershipTypeSource says where the type came from: "assignment" is a real seasonal assignment, and "role_default" or "built_in_default" mean NO assignment exists for this season and the platform fell back — which is worth saying out loud, because an officer expecting an explicit type will not find one.

INDUCTION DOES NOT GATE A BOOKING IN THIS RELEASE, and inductionGatesBooking is false to say so on the row itself. requiresInduction is an administrator's flag and no booking-create, booking-modify or capacity path reads it or the induction record. An outstanding induction gates nomination and shows on the member's dashboard. Never report it as the reason a booking was refused.

THERE IS NO MEMBER NUMBER in this platform, so none is reported. If a member quotes one it is something else, probably a Xero contact or invoice number.

ELIGIBILITY CODES. eligibilityCodes is in PRIORITY order — report the first one as the primary problem and mention the rest as also true. Absent means nothing in this list applies. Each code's exact meaning is in this tool's own description; use those words and do not paraphrase them.

This is a MEMBER-scoped answer. Whether they are present on a particular night, and whether a particular booking's hosting rule is satisfied, are booking questions — diagnostics.booking_block_state answers those. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: memberIdArgsSchema,
  inputSchema: {
    type: "object",
    properties: {
      memberId: {
        type: "string",
        description:
          "The EXACT member record id, as returned by diagnostics.member_search.",
      },
    },
    required: ["memberId"],
    additionalProperties: false,
  },
  readEvidence: (args) => readMemberEligibilityEvidence({ memberId: args.memberId }),
  /**
   * TWENTY-FOUR fields, at the substrate's hard ceiling. What was left out, and
   * where to get it: the member's name, email address, joined date, family links
   * and dependent count are all in `member_diagnostic_summary`; the per-season
   * subscription rows are in `member_subscription_state`.
   *
   * No name, and no email address. This entry answers a question about STANDING,
   * and a standing answer does not need to identify the person to be useful — the
   * caller already holds the id they searched for.
   */
  project: (row) => ({
    memberId: recordRefOrNull(row.member_id) ?? "",
    // A closed set of server-owned badge labels ("Active", "Inactive",
    // "Cancelled", "Archived", "Deleted"). Not a code, so not validated as one.
    lifecycleLabel: serverLabelOrNull(row.lifecycle_label) ?? "unknown",
    isActive: boolOf(row.is_active),
    canLogin: boolOf(row.can_login),
    ageTier: stableCodeOrNull(row.age_tier),
    seasonYear: countOf(row.season_year),
    membershipTypeKey: stableCodeOrNull(row.membership_type_key),
    membershipTypeSource: stableCodeOrNull(row.membership_type_source),
    membershipBookingBehavior: stableCodeOrNull(row.membership_booking_behavior),
    membershipSubscriptionBehavior: stableCodeOrNull(
      row.membership_subscription_behavior,
    ),
    // `null` when no season row exists at all. Deliberately distinguishable from
    // the stored status NOT_INVOICED, which means a row exists and nobody has
    // billed them.
    subscriptionStatus: stableCodeOrNull(row.subscription_status),
    subscriptionPaidAtUtc: instantOrNull(row.subscription_paid_at_utc),
    subscriptionManuallyMarkedPaid: boolOf(row.subscription_manually_marked_paid),
    subscriptionRequired: boolOf(row.subscription_required),
    subscriptionUnpaid: boolOf(row.subscription_unpaid),
    subscriptionLockoutMode: stableCodeOrNull(row.subscription_lockout_mode),
    qualifiesAsAdultMemberHost: boolOf(row.qualifies_as_adult_member_host),
    requiresInduction: boolOf(row.requires_induction),
    inductionStatus: stableCodeOrNull(row.induction_status),
    // Constant `false` in this release, and on the row rather than only in prose,
    // because this is the field most likely to be read as a booking blocker.
    inductionGatesBooking: boolOf(row.induction_gates_booking),
    hutLeaderEligible: boolOf(row.hut_leader_eligible),
    eligibilityCodes: codeListOrNull(row.eligibility_codes),
    eligibilityCodeCount: countOf(row.eligibility_code_count),
    observedAtUtc: instantOrNull(row.observed_at_utc) ?? "",
  }),
  rowLimit: 1,
  byteLimit: AID6B_SINGLE_ROW_BYTE_LIMIT,
  // No name, no email, no phone — but a member id plus a membership and
  // subscription standing is per-person information. See `booking_block_state` on
  // ADR-004's opt-in being declared and not yet enforced.
  surfacesPersonalData: true,
});

/** The AID-6B authoritative half, in presentation order. */
export const DIAGNOSTICS_AID6B_STATE_TOOLS: readonly DiagnosticsToolEntry[] = [
  bookingBlockState,
  bookingCapacityByNight,
  memberEligibilityState,
];
