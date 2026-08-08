/**
 * AI Diagnostics — AID-6B booking/membership pack, part 3: THE AUTHORITATIVE
 * CALCULATIONS (#2376, epic #2369).
 *
 * THREE `server_owned` evidence sources. The entries that read them live in
 * `booking-state.ts`; this module is the sources themselves.
 *
 *   readBookingBlockStateEvidence      → diagnostics.booking_block_state
 *   readBookingCapacityEvidence        → diagnostics.booking_capacity_by_night
 *   readMemberEligibilityEvidence      → diagnostics.member_eligibility_state
 *
 * WHY THESE ARE NOT `select_only_sql` ENTRIES, which is the question a reviewer
 * should ask first and which #2376 answers as a rule rather than a preference:
 * "Do not ask the model to recreate booking or membership rules from raw rows
 * where the application already has authoritative services, reason codes or
 * evaluators. Reuse or safely expose authoritative results."
 *
 * Every classification below already has exactly one definition in this codebase,
 * and re-deriving any of them in SQL would create a SECOND definition that can
 * drift from the screen a Booking Officer trusts:
 *
 *  - `evaluateProposalPartyViolations` (`booking-exception-request-service.ts`) is
 *    the ONE server-side evaluator of the exception-eligible soft policies. It
 *    composes `validateMinimumStay`, `evaluateProposedAdultMemberHosting` and
 *    `evaluateProposedPaidUpAdultPresence` and returns structured
 *    `PolicyExceptionViolation` records carrying `reasonCode`, `policyId`,
 *    `policyVersion`, `resolvedScope`, `affectedNights` and `capacityMode`. It is
 *    the same call the officer queue and the member's own request path make, so a
 *    diagnostic and the request the member submits cannot disagree about whether
 *    a rule is broken.
 *  - `bookingReviewReasonCodes` (`booking-review.ts`) is the ONE derivation of why
 *    a booking is in admin review, and it is deliberately derived at read time
 *    rather than stored. `isCheckinBlockedByPendingReview` is the ONE predicate
 *    for "blocked from check-in by a pending review", and it is NOT the same
 *    question — a pending ADULT-MEMBER HOSTING review deliberately does not turn a
 *    party away at the door, and this module keeps the two apart for that reason.
 *  - `checkCapacity` (`capacity.ts`) is the per-night engine every booking path
 *    uses. Its `nightDetails` already account for custodian bed holds, held
 *    policy-exception reservations and whole-lodge exclusive holds — three
 *    populations a hand-written diagnostic query would miss, and each of which
 *    makes a lodge full with no `Booking` row to show for it.
 *  - `getBookingEditPolicy` (`booking-edit-policy.ts`) is the ONE classifier of the
 *    locked-period edit window. "A booking lock" in this platform is not a table:
 *    it is this window plus the advisory locks the writers take, and the window is
 *    the only half a read can report.
 *  - `getLifecycleStatusConfig` (`admin-member-badges.ts`) is the ONE resolver of a
 *    member's lifecycle label, and it is the reason this module reads
 *    `isDeletedAccountRecord`: anonymisation sets `active: false` and stamps
 *    NEITHER `cancelledAt` NOR `archivedAt`, so a three-column read reports an
 *    ERASED member as merely "Inactive".
 *  - `resolveMemberSubscriptionSettlement` + `loadMemberSubscriptionSettlements`
 *    (`subscription-lockout-facts.ts`) are the ONE answer to "does this member owe
 *    a season subscription", and `peekSubscriptionLockoutMode`
 *    (`member-subscription-eligibility.ts`) is the club POLICY that decides what
 *    that fact costs the member. The two are deliberately separate and this module
 *    reports both, because the same unpaid fact hard-blocks at one club and merely
 *    reprices at the next.
 *  - `participantQualifiesAsHost` (`policies/adult-member-hosting.ts`) is the ONE
 *    adult-member-host predicate, and `participantIsNonMemberGuest` is its exact
 *    complement so a lapsed member cannot fall between the two.
 *
 * `peekSubscriptionLockoutMode` AND NOT `resolveSubscriptionLockoutMode`, and the
 * difference is load-bearing rather than stylistic: the latter reseeds an
 * in-process financial-year cache and can reach Xero. A diagnostics read must
 * contact no provider and must not mutate process state, so this module uses the
 * peek. A contract test pins that the resolving variant is never named here.
 *
 * A `server_owned` entry is NOT a way around the substrate's gates: registry
 * lookup, loop budget, fresh AND-ed authorization, `.strict()` argument parsing
 * with the reserved-key scan, the metering breaker, the fixed projection with
 * redaction and per-field caps, the row and byte ceilings, truncation honesty and
 * the approved-metadata audit row all apply identically. The only gate it skips is
 * the SELECT-only credential check, which does not govern it.
 *
 * WHAT THAT COSTS, STATED PLAINLY, because AID-6A's pack doc requires it of any
 * server-owned source and AID-6C's review found the same residual worth naming
 * twice. These sources query application tables on the application's own
 * FULL-PRIVILEGE Prisma connection, so unlike the SQL entries there is no column
 * grant behind them and the registry projection in `booking-state.ts` is the ONLY
 * boundary. Nothing leaks today — every row is built field by field from named
 * `select` clauses — but that makes every edit to this file or to those
 * projections a security-relevant change that needs the review a grant would get.
 * Columns that sit one `select` away and must never be added: `Booking."notes"`,
 * `"adminReviewNotes"`, `"memberReviewJustification"`, `"deletedReason"`,
 * `"adultMemberHostingReview"` (a frozen JSON snapshot), `Member."comments"`,
 * `"dateOfBirth"`, `"passwordHash"` and `"totpSecret"`. The authoritative helpers
 * this module calls DO read some of those columns internally to reach their
 * verdict — that is the point of delegating to them — and none of their return
 * values carries one.
 *
 * READ ONLY, AND NO PROVIDER, AND NO LOCK. Every call below is a Prisma
 * `findUnique`, `findFirst`, `findMany`, `count` or a read-only helper built from
 * those. There is no write, no `$transaction`, no `$executeRaw`, no advisory lock
 * and no HTTP request of any kind. The lock-taking and write-performing siblings of
 * several helpers used here are named in the pack doc precisely so a future edit
 * cannot reach for one by accident: `evaluateBookingAdultMemberHosting` takes an
 * advisory lock and is NOT used; `reconcileAdultMemberHostingReview`,
 * `createModificationExceptionRequest`, `approveAndExecutePolicyExceptionRequest`,
 * `processWaitlistForDates`, `confirmWaitlistOffer` and
 * `replaceBedAllocationsForBooking` all write and are NOT used.
 *
 * BOOKING DATES ARE NZ DATE-ONLY LODGE NIGHTS THROUGHOUT. Every date this module
 * emits goes through `formatDateOnly`, never `toISOString()`, so a night is a
 * calendar day and can never be narrated as a moment. Money stays in integer
 * cents; there is no division, no `toFixed` and no formatting in this file.
 */

import "server-only";

import { getLifecycleStatusConfig } from "@/lib/admin-member-badges";
import { getAgeTierSettings } from "@/lib/age-tier";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { evaluateProposalPartyViolations } from "@/lib/booking-exception-request-service";
import { findBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { formatBookingReference } from "@/lib/booking-reference";
import { bookingReviewReasonCodes, isCheckinBlockedByPendingReview } from "@/lib/booking-review";
import { checkCapacity } from "@/lib/capacity";
import { formatDateOnly } from "@/lib/date-only";
import {
  DELETED_ACCOUNT_PASSWORD_HASH,
  isDeletedAccountRecord,
} from "@/lib/deleted-account";
import { getInductionForMember } from "@/lib/induction";
import { peekSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import { resolveMembershipTypePolicyForMember } from "@/lib/membership-type-policy";
import { participantQualifiesAsHost } from "@/lib/policies/adult-member-hosting";
import { prisma } from "@/lib/prisma";
import {
  resolveMemberSubscriptionSettlement,
  subscriptionIsUnpaid,
} from "@/lib/subscription-lockout-facts";

import type { DiagnosticsToolRawRow } from "../define";

/**
 * These sources' OWN deadline, below the executor's 15-second wait.
 *
 * The executor's `Promise.race` does not cancel the loser and nothing propagates a
 * cancellation into Prisma, so a source that can be slow has to bound its own
 * WORK. `readBookingBlockStateEvidence` has the widest fan-out in either pack —
 * the booking, its guests and their night sets, the policy evaluation, the
 * capacity engine and the member-night conflict scan — all for exactly one
 * booking and all on indexed columns.
 *
 * IT REFUSES RATHER THAN RETURNING A PARTIAL ROW, and that is the whole reason the
 * deadline exists here rather than only in the executor. A block state assembled
 * from some of its inputs is a FABRICATED answer, not an absent one: a row that
 * reported "no policy violations" because the policy evaluation timed out would be
 * the exact failure mode this pack is designed against. `evidence_unavailable` is
 * the honest outcome and the executor's own message tells the operator so.
 */
const AID6B_EVIDENCE_DEADLINE_MS = 10_000;

/**
 * How many nights one capacity read may report. Kept in step with
 * `AID6B_NIGHT_ROW_LIMIT` by the pack's own contract test; declared here as a
 * local so this module does not import the registry-facing bounds and create a
 * cycle with `booking-state.ts`.
 */
export const AID6B_CAPACITY_NIGHT_CEILING = 31;

/**
 * The booking statuses that make a booking TERMINAL — nothing more can be
 * collected, confirmed, allocated or reviewed against it.
 *
 * A LOCAL CONSTANT PINNED BY A TEST, not an import, and the reason is the same one
 * AID-6C gave for its recovery-attempt ceiling: the authoritative predicate
 * (`bookingAttendanceIsTerminal` in `adult-member-hosting-review.ts`) lives in the
 * hosting RECONCILER, a module full of advisory locks, queue drains and writers.
 * Importing it would drag that graph into the diagnostics import closure for a
 * two-element array. The pack's contract test asserts this list agrees with the
 * real predicate on every `BookingStatus` value, so the two cannot drift.
 *
 * `deletedAt` is the third terminal condition and is handled separately, because a
 * soft-deleted booking is a DIFFERENT answer from a cancelled one: the member sees
 * nothing at all, and the operator's next step is the deleted-bookings view rather
 * than the cancellation record.
 */
const TERMINAL_BOOKING_STATUSES: readonly string[] = ["CANCELLED", "BUMPED"];

/**
 * The statuses that mean this booking is ON THE WAITLIST rather than admitted.
 *
 * They get their own set because of the ranking trap AID-6C's review named: a
 * waitlisted booking does not fit BY DEFINITION, so reporting `capacity_exceeded`
 * as its primary problem would outrank the fact that actually explains it. On
 * these two statuses the capacity shortfall is reported as a supporting FACT and
 * never as a blocker.
 */
const WAITLIST_BOOKING_STATUSES: readonly string[] = [
  "WAITLISTED",
  "WAITLIST_OFFERED",
];

/**
 * The stable blocker codes `readBookingBlockStateEvidence` can emit, in the
 * PRIORITY ORDER an operator should act on them.
 *
 * THE ORDER IS THE PRODUCT, and getting it wrong is how a diagnostic sends an
 * officer to the wrong screen. It is asserted end to end by a test that drives a
 * booking carrying every blocker at once and requires this exact sequence, and the
 * emitting code filters this catalogue rather than sorting a list — so priority is
 * structural rather than a comparator somebody can drop.
 *
 * The reasoning, stated because a reviewer must be able to disagree with it:
 *
 *  1-2. EXISTENCE FIRST. A deleted or terminal booking makes every other question
 *       moot, and reporting a policy failure on a cancelled booking is the
 *       "confidently wrong about a healthy record" failure in its purest form —
 *       the booking is not broken, it is over. Every downstream blocker is
 *       SUPPRESSED on these two, exactly as AID-6C suppresses payment-progress
 *       blockers on a terminal booking.
 *  3.   WAITLIST NEXT, because it explains the capacity shortfall that would
 *       otherwise be reported as the primary fault.
 *  4-6. HARD STOPS. A member double-booked on a night, a party that does not fit,
 *       and a night another booking holds exclusively are all refusals no officer
 *       can talk their way past — and the whole-lodge hold is explicitly NOT
 *       bypassable by the admin over-capacity override.
 *  7.   THE CHILD-SAFETY GATE. A pending minors review blocks arrival at the door,
 *       which is more urgent than a membership rule.
 *  8.   THE HOSTING REVIEW, which deliberately does NOT block arrival.
 *  9-11. THE SOFT POLICIES, in the order `sortPolicyExceptionViolations` already
 *       puts them. Each is exception-eligible, which is what makes them softer
 *       than the hard stops above.
 *  12-13. THE OFFICER'S OWN QUEUE. An open exception request means the ball is with
 *       an officer, and an expiring hold means the member's beds are about to be
 *       released — urgent, but only after the reason they asked.
 *  14.  THE EDIT WINDOW, last, because it constrains HOW a fix is applied rather
 *       than whether the booking is sound.
 */
export const BOOKING_BLOCKER_CODES = [
  "booking_deleted",
  "booking_lifecycle_terminal",
  "booking_waitlisted",
  "member_night_conflict",
  "capacity_exceeded",
  "whole_lodge_held",
  "admin_review_pending",
  "hosting_review_pending",
  "policy_minimum_stay",
  "policy_adult_member_hosting",
  "policy_paid_up_adult_member",
  "exception_request_open",
  "exception_hold_expiring",
  "edit_window_locked",
] as const;

export type BookingBlockerCode = (typeof BOOKING_BLOCKER_CODES)[number];

/**
 * The blocker codes that survive a TERMINAL or DELETED booking. There are none,
 * and saying so as a constant rather than as an `if` is deliberate: it is the one
 * place a future edit would have to argue for an exception.
 *
 * AID-6C kept its bookkeeping blockers alive on a terminal booking because a
 * refund still had to be paid and a Xero invoice still had to be corrected — money
 * outlives the booking. Nothing in THIS pack does: a cancelled booking cannot
 * exceed capacity, cannot break a minimum stay, and cannot be blocked from a
 * check-in that will never happen. Reporting any of those would be the false
 * actionable finding this pack exists to avoid.
 */
const TERMINAL_SURVIVING_BLOCKERS: readonly BookingBlockerCode[] = [];

/**
 * The stable eligibility codes `readMemberEligibilityEvidence` can emit, in
 * priority order. Same discipline as the blocker catalogue: filtered, never
 * sorted.
 *
 *  1.   ERASED. An anonymised account is not a member and is invisible to the
 *       three-column read every other surface would do.
 *  2-4. LIFECYCLE, outermost first: archived, then cancelled, then inactive. The
 *       order matches `getLifecycleStatusConfig`'s own precedence exactly, because
 *       a diagnostic that ranked them differently from the badge an officer is
 *       looking at would be describing a different member.
 *  5.   THE MEMBERSHIP TYPE BLOCKS BOOKING OUTRIGHT — a club-configured refusal
 *       that no subscription payment fixes.
 *  6.   THE SUBSCRIPTION IS UNPAID, which is a fact whose CONSEQUENCE depends on
 *       the club's lockout mode and is reported beside it.
 *  7.   NOT AN ADULT, which is why they cannot host.
 *  8.   NO LOGIN, which is why they cannot act for themselves.
 *  9.   AN INDUCTION IS REQUIRED OF THEM AND IS NOT COMPLETE. Last, and reported
 *       as a warning rather than a booking blocker, because in THIS release
 *       induction gates nomination and the member dashboard and gates NO booking
 *       path — see `readMemberEligibilityEvidence`.
 */
export const MEMBER_ELIGIBILITY_CODES = [
  "member_erased",
  "member_archived",
  "member_cancelled",
  "member_inactive",
  "membership_type_blocks_booking",
  "subscription_unpaid",
  "not_adult_age_tier",
  "cannot_log_in",
  "induction_outstanding",
] as const;

export type MemberEligibilityCode = (typeof MEMBER_ELIGIBILITY_CODES)[number];

/** Race one read against this module's own deadline, refusing rather than waiting. */
async function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `AI Diagnostics AID-6B: ${label} exceeded ${AID6B_EVIDENCE_DEADLINE_MS}ms`,
              ),
            ),
          AID6B_EVIDENCE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The current season year, as every subscription surface in this platform means it. */
function currentSeasonYear(): number {
  return new Date().getUTCFullYear();
}

// ---------------------------------------------------------------------------
// 1. The authoritative booking block state.
// ---------------------------------------------------------------------------

/**
 * The columns this source reads off `Booking`. A NAMED `select`, never a bare
 * `findUnique`, because the projection in `booking-state.ts` is the only boundary
 * behind this connection and a `select`-less read would put `notes`,
 * `adminReviewNotes`, `memberReviewJustification`, `deletedReason` and the frozen
 * `adultMemberHostingReview` JSON one field-name typo away from a projected row.
 */
const BLOCK_STATE_BOOKING_SELECT = {
  id: true,
  memberId: true,
  lodgeId: true,
  status: true,
  checkIn: true,
  checkOut: true,
  deletedAt: true,
  requiresAdminReview: true,
  adminReviewStatus: true,
  adminReviewedAt: true,
  adultMemberHostingReviewStatus: true,
  adultMemberHostingReviewedAt: true,
  waitlistPosition: true,
  waitlistOfferExpiresAt: true,
  wholeLodgeHold: true,
  adminCapacityHoldAt: true,
  capacityOverriddenAt: true,
  parentBookingId: true,
  draftExpiresAt: true,
} as const;

/**
 * THE authoritative answer to "what is actually blocking this booking".
 *
 * Returns exactly ONE row, or REFUSES. It never returns a partial row: the
 * executor reports a rejection as `evidence_unavailable`, and an operator told
 * "the evidence could not be gathered" is strictly better served than one told
 * "no policy violations" by a calculation that did not run.
 */
export async function readBookingBlockStateEvidence(args: {
  bookingId: string;
}): Promise<readonly DiagnosticsToolRawRow[]> {
  return withDeadline(readBookingBlockState(args.bookingId), "booking block state");
}

async function readBookingBlockState(
  bookingId: string,
): Promise<readonly DiagnosticsToolRawRow[]> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: BLOCK_STATE_BOOKING_SELECT,
  });
  // An absent booking is an EMPTY result, not a refusal. The executor's
  // `not_found` state plus the entry's scope sentence is the honest answer, and a
  // rejection here would tell an operator the evidence was unavailable when in
  // fact it was conclusive.
  if (!booking) return [];

  const guests = await prisma.bookingGuest.findMany({
    where: { bookingId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      isMember: true,
      memberId: true,
      stayStart: true,
      stayEnd: true,
      consentStatus: true,
      nights: { select: { stayDate: true } },
    },
    orderBy: [{ stayStart: "asc" }, { id: "asc" }],
  });

  const deleted = booking.deletedAt !== null;
  const terminal = TERMINAL_BOOKING_STATUSES.includes(booking.status);
  const waitlisted = WAITLIST_BOOKING_STATUSES.includes(booking.status);

  /**
   * The live per-guest night footprint, from the `BookingGuestNight` rows where
   * they exist and from the envelope where they do not.
   *
   * BOTH ARMS ARE NECESSARY AND THE ORDER MATTERS. A guest may occupy
   * NON-CONTIGUOUS nights inside one booking, in which case `stayStart`/`stayEnd`
   * are only the derived min/max envelope and expanding them would invent nights
   * the guest is not staying — which would then be reported as capacity demand and
   * as hosting coverage that does not exist. Where a guest has no night rows at
   * all (a booking written before #713) the envelope IS the footprint, and
   * refusing to expand it would report a party of zero nights.
   */
  const guestNights = new Map<string, string[]>();
  for (const guest of guests) {
    const explicit = guest.nights
      .map((night) => formatDateOnly(night.stayDate))
      .sort();
    if (explicit.length > 0) {
      guestNights.set(guest.id, [...new Set(explicit)]);
      continue;
    }
    const envelope: string[] = [];
    for (
      let cursor = new Date(guest.stayStart.getTime());
      cursor < guest.stayEnd;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      envelope.push(formatDateOnly(cursor));
    }
    // A single-night guest whose envelope is inclusive rather than half-open still
    // occupies one night; an empty footprint would silently drop them from every
    // calculation below.
    guestNights.set(
      guest.id,
      envelope.length > 0 ? envelope : [formatDateOnly(guest.stayStart)],
    );
  }

  const checkInDay = formatDateOnly(booking.checkIn);
  const checkOutDay = formatDateOnly(booking.checkOut);

  /**
   * The party as the policy evaluator wants it. Built from the LIVE rows, so the
   * violations reported are the violations the booking currently carries — not the
   * ones frozen into whatever request an officer last looked at.
   */
  const party = {
    checkIn: checkInDay,
    checkOut: checkOutDay,
    guests: guests.map((guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: String(guest.ageTier),
      isMember: guest.isMember,
      memberId: guest.memberId,
      nights: guestNights.get(guest.id) ?? [],
    })),
  };

  /**
   * The three reads that can each fail independently, run together so one slow
   * one does not serialise behind the others — and awaited as a set, because a
   * row missing any of them is not a row this source may return.
   *
   * `checkCapacity` is called with a guest count of ZERO and this booking
   * EXCLUDED. That is not a shortcut: `nightDetails` is what the tool reports, and
   * with the booking excluded each night's `occupiedBeds` and `availableBeds` are
   * the room the rest of the lodge leaves for it. The party's own demand is
   * computed separately from `guestNights`, so "does it fit" is a comparison the
   * row shows its working for rather than a boolean the engine returns for a
   * headcount that ignores non-contiguous stays.
   */
  const [violations, capacity, conflicts] = await Promise.all([
    // Terminal and deleted bookings skip the policy evaluation entirely. It is not
    // an optimisation: evaluating a cancelled booking's party would produce
    // violations that are true of the rows and false of the world, and the
    // suppression below would then have to be trusted to drop every one of them.
    deleted || terminal
      ? Promise.resolve([])
      : evaluateProposalPartyViolations(prisma, booking.lodgeId, party, {
          requestedByMemberId: booking.memberId,
          bookingId: booking.id,
        }),
    deleted || terminal
      ? Promise.resolve(null)
      : checkCapacity(
          booking.lodgeId,
          booking.checkIn,
          booking.checkOut,
          0,
          booking.id,
        ),
    deleted || terminal
      ? Promise.resolve([])
      : findBookingMemberNightConflicts(prisma, {
          // The ACTING identity here is the booking's own owner, not the
          // administrator running the diagnostic. The conflict scan's privileged
          // fields are gated on the actor's role, and passing a real admin role
          // would put another member's booking reference into a refusal payload
          // this tool then projects. `"USER"` is the least-privileged answer and
          // the tool reports only counts and nights, never the counterpart
          // booking.
          actorMemberId: booking.memberId,
          actorRole: "USER",
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guests: guests.map((guest) => ({
            memberId: guest.memberId,
            stayStart: guest.stayStart,
            stayEnd: guest.stayEnd,
            nights: (guestNights.get(guest.id) ?? []).map(
              (night) => new Date(`${night}T00:00:00.000Z`),
            ),
          })),
          excludeBookingId: booking.id,
        }),
  ]);

  /** The open exception requests, and whether any of them is actually holding beds. */
  const openRequests = await prisma.bookingChangeRequest.findMany({
    where: { bookingId, status: "REQUESTED" },
    select: {
      id: true,
      kind: true,
      holdExpiresAt: true,
      createdAt: true,
      _count: { select: { reservationNights: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const heldNightCount = openRequests.reduce(
    (total, request) => total + request._count.reservationNights,
    0,
  );
  /**
   * The earliest hold deadline among the requests that are ACTUALLY holding beds.
   *
   * The reservation-night COUNT is the test, never `holdExpiresAt IS NOT NULL`.
   * The schema states the trap in as many words: a row written before that column
   * existed can be holding beds with a NULL deadline, so filtering a capacity
   * question on the deadline would report "no beds held" about beds that are held.
   */
  const holdDeadlines = openRequests
    .filter((request) => request._count.reservationNights > 0)
    .map((request) => request.holdExpiresAt)
    .filter((deadline): deadline is Date => deadline !== null)
    .sort((left, right) => left.getTime() - right.getTime());
  const nextHoldExpiresAt = holdDeadlines[0] ?? null;

  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    // The BOOKING OWNER's role, deliberately, and not the administrator's. This
    // field answers "can the member fix this themselves, or does it need an
    // officer", which is one of the two next-step questions #2376 asks for; the
    // admin answer is always yes-with-an-override and would tell an operator
    // nothing.
    role: "USER",
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  });

  const reviewCodes = bookingReviewReasonCodes({
    requiresAdminReview: booking.requiresAdminReview,
    adminReviewStatus: booking.adminReviewStatus,
    adultMemberHostingReviewStatus: booking.adultMemberHostingReviewStatus,
  });

  /**
   * A pending review, keyed on the STATUS and not on the flag.
   *
   * `requiresAdminReview === true` with `adminReviewStatus === "APPROVED"` is a
   * booking an officer has already cleared. Reporting it as blocked would be the
   * exact defect AID-6C's review found in its sibling — a predicate reading the
   * wrong one of two columns that usually agree — and the platform's own
   * `isCheckinBlockedByPendingReview` is the conjunction, so this delegates to it
   * rather than restating it.
   */
  const adminReviewPending = isCheckinBlockedByPendingReview({
    requiresAdminReview: booking.requiresAdminReview,
    adminReviewStatus: booking.adminReviewStatus,
    // The predicate ignores the reason; passing null keeps this call from needing
    // a column the projection must never carry.
    adminReviewReason: null,
  });
  const hostingReviewPending = booking.adultMemberHostingReviewStatus === "PENDING";

  const reasonCodes = new Set(violations.map((violation) => violation.reasonCode));

  /** Per-night demand from the live footprint, and the tightest night. */
  const demandByNight = new Map<string, number>();
  for (const nights of guestNights.values()) {
    for (const night of nights) {
      demandByNight.set(night, (demandByNight.get(night) ?? 0) + 1);
    }
  }
  const nightDetails = capacity?.nightDetails ?? [];
  let shortfallNights = 0;
  let wholeLodgeHeldNights = 0;
  let tightestSpareBeds: number | null = null;
  for (const detail of nightDetails) {
    const night = formatDateOnly(detail.date);
    const demand = demandByNight.get(night) ?? 0;
    const spare = detail.availableBeds - demand;
    if (tightestSpareBeds === null || spare < tightestSpareBeds) {
      tightestSpareBeds = spare;
    }
    if (spare < 0) shortfallNights += 1;
    if (detail.wholeLodgeHeld === true) wholeLodgeHeldNights += 1;
  }

  /**
   * Which blockers are TRUE of this booking, as a predicate per code. Filtered
   * against the catalogue below so the emitted order is the declared order — the
   * dead `sort` AID-6C's review removed cannot come back here, because there is no
   * comparator to drop.
   */
  const raised: Record<BookingBlockerCode, boolean> = {
    booking_deleted: deleted,
    booking_lifecycle_terminal: terminal,
    booking_waitlisted: waitlisted,
    member_night_conflict: conflicts.length > 0,
    // A waitlisted booking does not fit BY DEFINITION. Reporting the shortfall as
    // a blocker would outrank the status that explains it, so the shortfall stays
    // a reported FACT (`shortfallNightCount`) on those two statuses.
    capacity_exceeded: shortfallNights > 0 && !waitlisted,
    whole_lodge_held: wholeLodgeHeldNights > 0,
    admin_review_pending: adminReviewPending,
    hosting_review_pending: hostingReviewPending,
    policy_minimum_stay: reasonCodes.has("MINIMUM_STAY"),
    policy_adult_member_hosting: reasonCodes.has("ADULT_MEMBER_HOSTING_REQUIRED"),
    policy_paid_up_adult_member: reasonCodes.has("PAID_UP_ADULT_MEMBER_REQUIRED"),
    exception_request_open: openRequests.length > 0,
    exception_hold_expiring: nextHoldExpiresAt !== null,
    edit_window_locked: !editPolicy.canModify,
  };

  const suppressed = deleted || terminal;
  const blockers = BOOKING_BLOCKER_CODES.filter((code) => {
    if (!raised[code]) return false;
    if (!suppressed) return true;
    return (
      code === "booking_deleted" ||
      code === "booking_lifecycle_terminal" ||
      TERMINAL_SURVIVING_BLOCKERS.includes(code)
    );
  });

  return [
    {
      booking_id: booking.id,
      booking_reference: formatBookingReference(booking.id),
      owner_member_ref: booking.memberId,
      lodge_ref: booking.lodgeId,
      booking_status: booking.status,
      check_in: checkInDay,
      check_out: checkOutDay,
      guest_count: guests.length,
      /**
       * ONE field for three states, and not two booleans, because the substrate
       * caps a row at 24 fields and because two booleans are misreadable in
       * combination. A soft-deleted booking whose status is still `PAID` would
       * carry `terminal: false` beside a blocker list this source has deliberately
       * emptied, and "not terminal, no blockers" is the healthiest-looking row this
       * pack can emit about a booking the member can no longer see.
       *
       * `deleted` wins over `terminal` because it is the wider fact and the
       * operator's next step differs: a cancelled booking has a cancellation record
       * to read, a deleted one is in the deleted-bookings view.
       */
      booking_lifecycle_state: deleted ? "deleted" : terminal ? "terminal" : "live",
      // The ADMIN review gate, as the platform's own check-in predicate answers it.
      admin_review_pending: adminReviewPending,
      hosting_review_pending: hostingReviewPending,
      review_reason_codes: reviewCodes.length > 0 ? reviewCodes.join(",") : null,
      policy_violation_codes:
        violations.length > 0
          ? [...new Set(violations.map((violation) => violation.reasonCode))]
              .sort()
              .join(",")
          : null,
      // The HOLD-if-any-HOLD aggregate over the live violations. It decides whether
      // an exception request would reserve real beds while it waits, which is the
      // difference between a member keeping their place and losing it.
      policy_capacity_mode: violations.some(
        (violation) => violation.capacityMode === "HOLD",
      )
        ? "HOLD"
        : violations.length > 0
          ? "NO_HOLD"
          : null,
      member_night_conflict_count: conflicts.length,
      shortfall_night_count: shortfallNights,
      whole_lodge_held_night_count: wholeLodgeHeldNights,
      // `null` and not `0` when the capacity engine did not run: on a terminal or
      // deleted booking there is no shortfall to report, and a zero would read as
      // "it fits", which is a claim about a booking that no longer exists.
      tightest_spare_beds: capacity === null ? null : tightestSpareBeds,
      open_exception_request_count: openRequests.length,
      exception_held_night_count: heldNightCount,
      exception_hold_expires_at_utc: nextHoldExpiresAt?.toISOString() ?? null,
      member_can_modify: editPolicy.canModify,
      edit_window_mode: editPolicy.mode,
      blocker_codes: blockers.length > 0 ? blockers.join(",") : null,
      blocker_count: blockers.length,
      observed_at_utc: new Date().toISOString(),
    },
  ];
}

// ---------------------------------------------------------------------------
// 2. Per-night capacity, as the booking engine computes it.
// ---------------------------------------------------------------------------

/**
 * One row per lodge night of a booking's stay: what the rest of the lodge occupies
 * that night, what is left, whether the night is exclusively held, and what this
 * booking's own party demands of it.
 *
 * WHY `checkCapacity` AND NOT A QUERY. Its occupancy figure already includes three
 * populations no `Booking` query would find: custodian bed holds (a
 * `HutLeaderAssignment` with a `bedId`, which has no booking and no allocation
 * row), held policy-exception reservations, and the whole-lodge exclusive hold that
 * pins `availableBeds` to zero regardless of headcount. A diagnostic that reported
 * "eight beds free" on a night a custodian has taken four of them would send an
 * officer to confirm a booking the engine will then refuse.
 */
export async function readBookingCapacityEvidence(args: {
  bookingId: string;
}): Promise<readonly DiagnosticsToolRawRow[]> {
  return withDeadline(readBookingCapacity(args.bookingId), "booking capacity");
}

async function readBookingCapacity(
  bookingId: string,
): Promise<readonly DiagnosticsToolRawRow[]> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      lodgeId: true,
      status: true,
      checkIn: true,
      checkOut: true,
      deletedAt: true,
      wholeLodgeHold: true,
      capacityOverriddenAt: true,
    },
  });
  if (!booking) return [];

  const guests = await prisma.bookingGuest.findMany({
    where: { bookingId },
    select: {
      id: true,
      stayStart: true,
      stayEnd: true,
      nights: { select: { stayDate: true } },
    },
  });

  const demandByNight = new Map<string, number>();
  for (const guest of guests) {
    const explicit = [
      ...new Set(guest.nights.map((night) => formatDateOnly(night.stayDate))),
    ];
    const nights =
      explicit.length > 0
        ? explicit
        : (() => {
            const envelope: string[] = [];
            for (
              let cursor = new Date(guest.stayStart.getTime());
              cursor < guest.stayEnd;
              cursor.setUTCDate(cursor.getUTCDate() + 1)
            ) {
              envelope.push(formatDateOnly(cursor));
            }
            return envelope.length > 0
              ? envelope
              : [formatDateOnly(guest.stayStart)];
          })();
    for (const night of nights) {
      demandByNight.set(night, (demandByNight.get(night) ?? 0) + 1);
    }
  }

  const capacity = await checkCapacity(
    booking.lodgeId,
    booking.checkIn,
    booking.checkOut,
    0,
    booking.id,
  );

  const bedAllocations = await prisma.bedAllocation.groupBy({
    by: ["stayDate"],
    where: { bookingId },
    _count: { _all: true },
  });
  const allocatedByNight = new Map<string, number>();
  for (const row of bedAllocations) {
    allocatedByNight.set(formatDateOnly(row.stayDate), row._count._all);
  }

  /**
   * REFUSE rather than clip. `rowLimit` would truncate honestly and the model would
   * be told, but a per-night capacity answer that stops in the middle of a stay
   * invites "the lodge has room" about the half that was shown. A stay longer than
   * the ceiling is a real answer this tool cannot give, and the entry's scope line
   * names the bed-allocation board as the place that can.
   */
  if (capacity.nightDetails.length > AID6B_CAPACITY_NIGHT_CEILING) {
    throw new Error(
      `AI Diagnostics AID-6B: this booking covers ${capacity.nightDetails.length} nights, above the ${AID6B_CAPACITY_NIGHT_CEILING}-night ceiling for a single capacity read`,
    );
  }

  const observedAt = new Date().toISOString();
  return capacity.nightDetails.map((detail) => {
    const night = formatDateOnly(detail.date);
    const demand = demandByNight.get(night) ?? 0;
    return {
      booking_id: booking.id,
      booking_reference: formatBookingReference(booking.id),
      lodge_ref: booking.lodgeId,
      night,
      // Excluding THIS booking, which is what makes the spare figure answerable.
      occupied_beds_excluding_this_booking: detail.occupiedBeds,
      available_beds_excluding_this_booking: detail.availableBeds,
      party_beds_this_night: demand,
      spare_beds_after_this_booking: detail.availableBeds - demand,
      fits_this_night: detail.availableBeds - demand >= 0,
      whole_lodge_held_by_another_booking: detail.wholeLodgeHeld === true,
      this_booking_holds_whole_lodge: booking.wholeLodgeHold,
      capacity_overridden: booking.capacityOverriddenAt !== null,
      allocated_bed_nights: allocatedByNight.get(night) ?? 0,
      observed_at_utc: observedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// 3. The authoritative member eligibility state.
// ---------------------------------------------------------------------------

/**
 * THE authoritative answer to "why is this member blocked, or charged non-member
 * rates".
 *
 * It composes six independent authorities and reports each one's answer beside the
 * others, because they answer different questions and collapsing them is how a
 * membership diagnostic becomes wrong:
 *
 *  - the LIFECYCLE label, from the platform's own resolver, with erasure detected
 *    rather than inferred;
 *  - the MEMBERSHIP TYPE for the season, resolved through
 *    `SeasonalMembershipAssignment` with the documented role-default fallback, and
 *    the booking and subscription BEHAVIOURS it carries;
 *  - the SUBSCRIPTION SETTLEMENT fact, from the pure rule every gate shares;
 *  - the club's LOCKOUT MODE, which decides what that fact costs;
 *  - the ADULT-MEMBER-HOST predicate, unchanged from the hosting policy's own;
 *  - the INDUCTION state, reported as a warning and NOT as a booking blocker.
 *
 * INDUCTION DOES NOT GATE A BOOKING IN THIS RELEASE, and saying so is the most
 * useful sentence this tool carries. #2376 lists induction among the conditions
 * that block a booking. It does not: `MemberInduction` is read by the nomination
 * gate, the member dashboard card and the induction sign-off surfaces, and no
 * booking-create, booking-modify or capacity path reads it at all.
 * `Member."requiresInduction"` is an administrator's flag, not an enforcement.
 * Reporting an outstanding induction as a booking blocker would send an officer to
 * complete an induction that will not change the answer.
 */
export async function readMemberEligibilityEvidence(args: {
  memberId: string;
}): Promise<readonly DiagnosticsToolRawRow[]> {
  return withDeadline(readMemberEligibility(args.memberId), "member eligibility");
}

async function readMemberEligibility(
  memberId: string,
): Promise<readonly DiagnosticsToolRawRow[]> {
  const seasonYear = currentSeasonYear();

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      // SELECTED AND NEVER PROJECTED. It is an input to the erasure test below —
      // an approved deletion rewrites the address to an anonymised one — and this
      // entry's projection has no field for it. The one entry that DOES return an
      // email address is `member_diagnostic_summary`, under the same permission,
      // for one selected member.
      email: true,
      ageTier: true,
      active: true,
      canLogin: true,
      cancelledAt: true,
      archivedAt: true,
      requiresInduction: true,
      hutLeaderEligible: true,
      joinedDate: true,
    },
  });
  if (!member) return [];

  const [typePolicy, subscription, ageTierSettings, lockoutMode, induction] =
    await Promise.all([
      resolveMembershipTypePolicyForMember(prisma, { memberId, seasonYear }),
      prisma.memberSubscription.findUnique({
        where: { memberId_seasonYear: { memberId, seasonYear } },
        select: { status: true, paidAt: true, manuallyMarkedPaidAt: true },
      }),
      getAgeTierSettings(),
      peekSubscriptionLockoutMode(),
      getInductionForMember(memberId),
    ]);

  const settlement = resolveMemberSubscriptionSettlement({
    subscriptionBehavior: typePolicy?.subscriptionBehavior ?? null,
    subscriptionStatus: subscription?.status ?? null,
    ageTier: member.ageTier,
    ageTierSettings,
  });
  const unpaid = subscriptionIsUnpaid(settlement);

  /**
   * The lifecycle label, from the resolver every admin badge uses — and
   * `deletedAccount` computed rather than left `false`.
   *
   * Erasure sets `active: false` and stamps NEITHER `cancelledAt` NOR
   * `archivedAt`, so a caller that omits this flag gets "Inactive" for an
   * anonymised account. That is not a cosmetic difference: an officer told a member
   * is merely inactive will try to reactivate them.
   *
   * THE PASSWORD HASH IS A PREDICATE, NOT A PROJECTION, and this is the one place
   * in either tool pack where that pattern is applied to a credential column.
   * `isDeletedAccountRecord` is the single definition of the erasure test and it is
   * a disjunction: the anonymised email address OR the sentinel password hash.
   * Reading a real password hash into a diagnostics module — even to compare it —
   * is not something this pack will do, and reading only the email half would make
   * the test silently incomplete for an account erased before the address was
   * rewritten. So the hash comparison happens INSIDE PostgreSQL as a `count` on an
   * equality against the server-written sentinel; only the boolean crosses the
   * boundary, and the sentinel constant is then handed back to the authoritative
   * predicate so the disjunction keeps exactly one definition. No member's real
   * hash is ever loaded, logged, hashed into an audit row or projected.
   */
  const erasedPasswordHash =
    (await prisma.member.count({
      where: { id: memberId, passwordHash: DELETED_ACCOUNT_PASSWORD_HASH },
    })) > 0;
  const erased = isDeletedAccountRecord({
    email: member.email,
    passwordHash: erasedPasswordHash ? DELETED_ACCOUNT_PASSWORD_HASH : null,
  });
  const lifecycle = getLifecycleStatusConfig({
    deletedAccount: erased,
    active: member.active,
    cancelledAt: member.cancelledAt,
    archivedAt: member.archivedAt,
  });

  /**
   * The host predicate, called with exactly the facts it reads and with the two
   * optional inputs supplied EXPLICITLY.
   *
   * `operationallyPresent` and `subscriptionSettled` are both `!== false` tests
   * inside the predicate, so leaving them undefined would silently answer
   * "present and settled" for a member whose subscription is unpaid — the
   * false-positive shape this pack exists to avoid. `operationallyPresent` is
   * `true` here because the question is member-scoped rather than booking-scoped:
   * whether they are on a particular night is what `booking_block_state` answers.
   */
  const qualifiesAsHost = participantQualifiesAsHost({
    member: {
      id: member.id,
      ageTier: member.ageTier,
      active: member.active,
      cancelledAt: member.cancelledAt,
      archivedAt: member.archivedAt,
    },
    operationallyPresent: true,
    subscriptionSettled: !unpaid,
  });

  const inductionComplete = induction?.status === "COMPLETED";

  const raised: Record<MemberEligibilityCode, boolean> = {
    member_erased: erased,
    member_archived: member.archivedAt !== null,
    member_cancelled: member.cancelledAt !== null,
    // Only when nothing more specific explains it: an archived or cancelled member
    // is also inactive, and reporting both would make the list read as two
    // problems where there is one.
    member_inactive:
      !member.active &&
      !erased &&
      member.archivedAt === null &&
      member.cancelledAt === null,
    membership_type_blocks_booking: typePolicy?.bookingBehavior === "BLOCK_BOOKING",
    subscription_unpaid: unpaid,
    not_adult_age_tier: member.ageTier !== "ADULT",
    cannot_log_in: !member.canLogin,
    induction_outstanding: member.requiresInduction && !inductionComplete,
  };

  const codes = MEMBER_ELIGIBILITY_CODES.filter((code) => raised[code]);

  return [
    {
      member_id: member.id,
      lifecycle_label: lifecycle.label,
      member_erased: erased,
      is_active: member.active,
      can_login: member.canLogin,
      age_tier: String(member.ageTier),
      season_year: seasonYear,
      membership_type_key: typePolicy?.membershipType?.key ?? null,
      membership_type_source: typePolicy?.source ?? null,
      membership_booking_behavior: typePolicy?.bookingBehavior ?? null,
      membership_subscription_behavior: typePolicy?.subscriptionBehavior ?? null,
      // `null` and not a status string when no row exists: NOT_INVOICED is a real
      // stored state meaning "nobody has billed them", and a member with no row at
      // all is a different fact.
      subscription_status: subscription?.status ?? null,
      subscription_paid_at_utc: subscription?.paidAt?.toISOString() ?? null,
      subscription_manually_marked_paid:
        (subscription?.manuallyMarkedPaidAt ?? null) !== null,
      subscription_required: settlement.subscriptionRequired,
      subscription_paid: settlement.subscriptionPaid,
      subscription_unpaid: unpaid,
      subscription_lockout_mode: lockoutMode,
      qualifies_as_adult_member_host: qualifiesAsHost,
      requires_induction: member.requiresInduction,
      induction_status: induction?.status ?? null,
      induction_complete: inductionComplete,
      // Stated on the row itself, not only in the scope line, because this is the
      // field most likely to be read as a booking blocker.
      induction_gates_booking: false,
      hut_leader_eligible: member.hutLeaderEligible,
      joined_date: member.joinedDate ? formatDateOnly(member.joinedDate) : null,
      eligibility_codes: codes.length > 0 ? codes.join(",") : null,
      eligibility_code_count: codes.length,
      observed_at_utc: new Date().toISOString(),
    },
  ];
}
