import {
  AdminReviewStatus,
  BookingStatus,
  Prisma,
  type MemberGuestConsentStatus,
  type PrismaClient,
} from "@prisma/client";

import {
  hostingCoverageStateKey,
  openOrUpdateHostingCoverageIncident,
  resolveHostingCoverageIncidents,
  type HostingCoverageIncidentCause,
  type HostingCoverageIncidentOutcome,
} from "@/lib/adult-member-hosting-coverage-incidents";
import { enqueueHostingCoverageReevaluation } from "@/lib/adult-member-hosting-coverage-queue";
import {
  SameOwnerCoverageWouldBreakError,
  sameBookingOwnerCoverageSourceWhere,
  sameOwnerCoverageDependentWhere,
  strandedCoverageReference,
  type StrandedCoverageBooking,
} from "@/lib/adult-member-hosting-same-owner";
import { ApiError } from "@/lib/api-error";
import type {
  AdultMemberHostingPolicyExceptionViolation,
  AggregatedPolicyExceptions,
} from "@/lib/booking-policy-exceptions";
import { aggregatePolicyExceptionViolations } from "@/lib/booking-policy-exceptions";
import { isHostingCoverageSourceBookingStatus } from "@/lib/booking-status";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { getDefaultLodgeId } from "@/lib/lodges";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import { prisma } from "@/lib/prisma";
import {
  adultMemberHostingReviewChanged,
  adultMemberHostingStateKey,
  evaluateAdultMemberHostingWithPolicy,
  hostingModeIsActive,
  resolveAdultMemberHostingPolicy,
  type EffectiveAdultMemberHostingMode,
  type HostingParticipant,
  type ResolvedAdultMemberHostingPolicy,
} from "@/lib/policies/adult-member-hosting";
import {
  loadUnpaidSubscriptionMemberIds,
  type SubscriptionLockoutDb,
} from "@/lib/subscription-lockout-enforcement";
import { getSeasonYear } from "@/lib/utils";

/**
 * Booking-side integration for the adult-member hosting policy (#2364).
 *
 * The evaluator in `policies/adult-member-hosting.ts` is pure; this module is
 * the only place that turns a persisted booking into evaluator input and turns
 * the answer back into review state. Keeping it in one place is what makes the
 * "any change re-evaluates" requirement tractable: every booking mutation calls
 * `reconcileAdultMemberHostingReviewWithSiblings`, and none of them has to
 * understand the rule.
 *
 * The reconciler is IDEMPOTENT and derives everything from live rows, so calling
 * it twice, or from a path that changed nothing, is a no-op that writes nothing.
 * That is deliberate — it means a new call site can be added anywhere without
 * having to reason about what the previous one did.
 *
 * WHICH ENTRY POINT TO CALL. `reconcileAdultMemberHostingReview` answers for ONE
 * booking id. That is not enough for a mutator, because `loadSiblingHosts` makes
 * a split child's answer a function of its PARENT's rows: shortening the
 * member's own stay on the parent removes a host from the child, and extending
 * it restores one, without a single row on the child changing. A mutator that
 * reconciled only the id it was handed would therefore leave the other half of a
 * #738 split pair asserting facts that are no longer true — in both directions,
 * defeating hazard detection AND the issue's automatic clear. Every mutation
 * path calls `reconcileAdultMemberHostingReviewWithSiblings`; the single-id form
 * is for callers that already hold every id in the family and reconcile each one
 * deliberately (booking creation, which must attach an admin's decision to the
 * right row).
 */

/**
 * The narrow client this service needs; a `Prisma.TransactionClient` satisfies it.
 *
 * The member/subscription/membership-type delegates are #2543's: under a club
 * running `NON_MEMBER_PRICING` a member with an unpaid subscription stops
 * counting as a host, and that fact has to be read before the evaluator runs.
 * They are part of the required shape rather than optional because a caller that
 * quietly could not read them would silently restore the unpaid member as a
 * host — a rule that is off when nobody notices is worse than no rule.
 */
export type AdultMemberHostingReviewDb = Pick<
  PrismaClient,
  | "booking"
  | "adultMemberHostingPolicy"
  | "lodge"
  | "member"
  | "memberSubscription"
  | "seasonalMembershipAssignment"
  | "membershipType"
  // #2576: the same-owner coverage machinery. The incident and the queue row are
  // written INSIDE the caller's transaction alongside the change that caused them
  // (§8), and the audit row with them, so they are part of the required shape
  // rather than optional extras — a caller that quietly could not write them
  // would allow an authoritative change and lose the obligation to check what it
  // broke, which is the one failure this design must not have.
  | "hostingCoverageIncident"
  | "hostingCoverageReevaluation"
  | "auditLog"
>;

/** The narrow client the policy read needs on its own. */
export type AdultMemberHostingPolicyDb = Pick<
  PrismaClient,
  "adultMemberHostingPolicy" | "lodge"
>;

/**
 * Resolve the adult-member hosting policy in force at one lodge (#2364).
 *
 * The table holds at most one club-wide row plus one row per lodge, so both
 * candidates come back in a single query and `resolveAdultMemberHostingPolicy`
 * decides between them. A lodge with no row, or an INHERIT row, falls through to
 * the club default; a club with no row at all resolves DISABLED.
 *
 * COMPOSITION RULE — `db`. The same rule `validateMinimumStay` carries
 * (`booking-policies.ts`), and binding for the same reason: **a caller already
 * inside `prisma.$transaction` MUST pass its own `tx`.** Reaching for the
 * module-level client while the caller holds `pg_advisory_xact_lock(1)` and a
 * per-lodge capacity lock checks out a SECOND pool connection underneath both,
 * which is the pool-starvation shape the ordering rule at the top of
 * `member-guest-add-policy.ts` exists to forbid; passing `tx` also makes the
 * read see the transaction's own snapshot rather than a second, later one.
 * Callers genuinely outside a transaction keep the default.
 *
 * Deliberately declared HERE rather than beside `validateMinimumStay`, even
 * though the two are siblings. A dozen booking tests blanket-mock
 * `@/lib/booking-policies` with non-spreading factories, so an export added
 * there is missing from every one of them the moment a booking path calls it —
 * the same reason `over-capacity-confirmation.ts` lives outside `@/lib/capacity`.
 *
 * Throws `UnknownAdultMemberHostingScopeError` when no lodge can be resolved,
 * rather than answering "disabled" for a scope it could not identify.
 */
export async function loadAdultMemberHostingPolicy(
  lodgeId?: string | null,
  db: AdultMemberHostingPolicyDb = prisma,
): Promise<ResolvedAdultMemberHostingPolicy> {
  const effectiveLodgeId = lodgeId ?? (await getDefaultLodgeId(db));
  const rows = await db.adultMemberHostingPolicy.findMany({
    where: { OR: [{ lodgeId: effectiveLodgeId }, { lodgeId: null }] },
    select: {
      id: true,
      scopeKey: true,
      lodgeId: true,
      mode: true,
      capacityMode: true,
      version: true,
      // #2569's second dimension. Named explicitly because this select is
      // narrowed: omitting them would hand the resolver `undefined`s, which it
      // reads as "this row did not decide" — so a lodge with a custom scope set
      // would silently fall back to the club's, or to the built-in default, and
      // the club's rule would be quietly widened or narrowed. The db parameter is
      // a hand-written narrow interface, so a stale column name here is NOT a
      // typecheck error — it is a runtime Prisma validation failure on every
      // booking write path. `adult-member-hosting-call-sites.test.ts` pins the
      // selected set against the schema for that reason.
      hostScopeSameBooking: true,
      hostScopeSameBookingOwner: true,
    },
  });
  return resolveAdultMemberHostingPolicy(rows, effectiveLodgeId);
}

const BOOKING_HOSTING_SELECT = {
  id: true,
  memberId: true,
  parentBookingId: true,
  lodgeId: true,
  checkIn: true,
  checkOut: true,
  // #2576: a booking that is no longer happening has no attendance, so it has no
  // hosting hazard. See `bookingAttendanceIsTerminal`.
  status: true,
  deletedAt: true,
  adultMemberHostingReview: true,
  adultMemberHostingReviewStatus: true,
  guests: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      stayStart: true,
      stayEnd: true,
      // #2364 review finding: a member guest who has not accepted their invite
      // is not operationally present (D-12), so they cannot host. See
      // `toHostingParticipants`.
      consentStatus: true,
      nights: { select: { stayDate: true } },
      member: {
        select: {
          id: true,
          ageTier: true,
          active: true,
          cancelledAt: true,
          archivedAt: true,
        },
      },
    },
  },
} as const;

type LoadedHostingBooking = {
  id: string;
  memberId: string;
  parentBookingId: string | null;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  status: BookingStatus | string;
  deletedAt: Date | null;
  adultMemberHostingReview: unknown;
  adultMemberHostingReviewStatus: AdminReviewStatus | null;
  guests: Array<{
    id: string;
    firstName: string;
    lastName: string;
    stayStart: Date;
    stayEnd: Date;
    consentStatus: MemberGuestConsentStatus | null;
    nights: Array<{ stayDate: Date }>;
    member: {
      id: string;
      ageTier: string;
      active: boolean;
      cancelledAt: Date | null;
      archivedAt: Date | null;
    } | null;
  }>;
};

/**
 * Turn persisted guest rows into evaluator participants.
 *
 * Nights come from the sparse `BookingGuestNight` rows (#713), which are the
 * authoritative per-night record and the only representation that gets a
 * non-contiguous stay right. Rows predating #713 have none, so those fall back
 * to the guest's own stayStart..stayEnd envelope — the same fallback the rest of
 * the codebase uses, and never the BOOKING's range, which would credit a guest
 * with nights they are not staying.
 *
 * `member` is the live Member row, not the guest's `isMember` snapshot. See the
 * module header of `policies/adult-member-hosting.ts` for why.
 *
 * `operationallyPresent` is the shared D-12 predicate (`member-guest-consent`),
 * the same one the kiosk, the arrival roster, bed allocation and the arrival
 * emails filter on. A member guest whose invite is still `PENDING` is kept off
 * every one of those surfaces, so counting them as a host here would let a
 * member suppress the review with an adult who never agreed to come — and the
 * lodge would then receive the non-member guests unaccompanied, which is
 * precisely the situation the rule exists to flag. `null` (no consent was ever
 * needed) and `CONFIRMED` are present; nothing else is.
 */
export function toHostingParticipants(
  booking: Pick<LoadedHostingBooking, "guests">,
  hostOnly = false,
): HostingParticipant[] {
  return booking.guests.map((guest) => {
    const nights =
      guest.nights.length > 0
        ? guest.nights.map((night) => formatDateOnly(night.stayDate))
        : eachDateOnlyInRange(guest.stayStart, guest.stayEnd).map(formatDateOnly);
    return {
      guestRef: guest.id,
      guestName: `${guest.firstName} ${guest.lastName}`.trim(),
      member: guest.member,
      nights,
      operationallyPresent: isOperationallyPresentConsent(guest.consentStatus),
      ...(hostOnly ? { hostOnly: true } : {}),
    };
  });
}

/**
 * The people staying with this booking's party who are carried on a SIBLING
 * booking row: its direct parent, or its direct children, belonging to the SAME
 * member and still live.
 *
 * This is the split-booking shape (#738) and nothing else. The same-member
 * filter is what keeps a group booking out: a joiner's booking hangs off the
 * organiser's, but belongs to a different member, so the organiser's adults are
 * never borrowed to host somebody else's guests. Cancelled, bumped and
 * soft-deleted rows are excluded — a bumped sibling is not staying.
 */
function hostingSiblingWhere(
  booking: Pick<LoadedHostingBooking, "id" | "memberId" | "parentBookingId">,
): Prisma.BookingWhereInput {
  const relatedIds: Prisma.BookingWhereInput[] = [
    { parentBookingId: booking.id },
  ];
  if (booking.parentBookingId) relatedIds.push({ id: booking.parentBookingId });

  return {
    OR: relatedIds,
    memberId: booking.memberId,
    deletedAt: null,
    status: { notIn: [BookingStatus.CANCELLED, BookingStatus.BUMPED] },
    id: { not: booking.id },
  };
}

async function loadSiblingHosts(
  booking: LoadedHostingBooking,
  db: AdultMemberHostingReviewDb,
): Promise<{ participants: HostingParticipant[]; siblingIds: string[] }> {
  const siblings = (await db.booking.findMany({
    where: hostingSiblingWhere(booking),
    select: BOOKING_HOSTING_SELECT,
  })) as LoadedHostingBooking[];

  return {
    participants: siblings
      // A sibling that arrived without its guest relation contributes no hosts.
      // Dropping it is the safe direction here: fewer borrowed hosts can only
      // OPEN a review for an admin to look at, never suppress one.
      .filter((sibling) => Array.isArray(sibling.guests))
      .flatMap((sibling) => toHostingParticipants(sibling, true)),
    siblingIds: siblings.map((sibling) => sibling.id),
  };
}

/**
 * A hard ceiling on how many same-owner source bookings one evaluation reads
 * (#2576 §10: "use suitable indexes and bounded result limits").
 *
 * Generous rather than tight, because it is a guard and not a policy: a member
 * with more than this many CONFIRMED-or-PAID bookings at ONE lodge overlapping ONE
 * stay is a data problem, not a club member. Twenty-five is far beyond anything the
 * split-booking and family shapes produce (a #738 split pair is two), and the read
 * is already narrowed to one owner, one lodge and one date window before the limit
 * applies.
 *
 * FAILING SAFE MEANS FAILING TOWARDS THE RULE: if the ceiling ever truncated, fewer
 * hosts are seen, so a night reads as uncovered and the booking is flagged or
 * refused rather than quietly allowed.
 */
const SAME_OWNER_COVERAGE_SOURCE_LIMIT = 25;

/**
 * The qualifying-adult-member candidates attending ANOTHER eligible booking on the
 * SAME account, at the same lodge, over nights that overlap this stay (#2576 §1
 * to §4).
 *
 * Three things about the returned rows carry the whole scope:
 *
 *  - `hostScope: "SAME_BOOKING_OWNER"` — the evaluator counts them only where the
 *    club has that scope switched on. That is the seam #2569 left, used exactly as
 *    intended: no branch of the rule changed to add this scope.
 *  - `hostOnly: true` — their own nights are NOT this booking's responsibility.
 *    This is also §15's capacity answer: the adult member's REAL attendance on
 *    their own booking is recognised as evidence here, and they are never
 *    duplicated as a guest on this one, so no bed is double-counted.
 *  - the participant shape is `toHostingParticipants`' — the same live Member
 *    facts, the same sparse `BookingGuestNight` nights, the same D-12 consent
 *    predicate. §13 forbids a second definition of a qualifying adult member and
 *    there is none: whether these people actually qualify is decided afterwards by
 *    `participantQualifiesAsHost`, exactly as for the booking's own guests.
 *
 * THE GUEST READ IS NARROWED TO MEMBER-LINKED ROWS, which is a true narrowing
 * rather than a policy: a guest with no Member link can never host under any
 * scope, so loading a source booking's non-member guests would be loading rows the
 * evaluator is guaranteed to ignore. Their own nights are that booking's problem
 * and are judged when that booking is reconciled.
 *
 * SPLIT SIBLINGS ARE EXCLUDED, deliberately. A #738 split pair is one party the
 * database stores as two rows, and the invariant is that such a sibling supplies
 * cover under `SAME_BOOKING` — not as "another booking at the lodge". Loading it
 * here as well would put one person in the participant list twice and would make
 * the same-booking half of the rule reachable through the same-owner half.
 */
async function loadSameBookingOwnerHosts(
  booking: LoadedHostingBooking,
  db: AdultMemberHostingReviewDb,
  excludeBookingIds: readonly string[],
): Promise<HostingParticipant[]> {
  const where = sameBookingOwnerCoverageSourceWhere(booking);
  const sources = (await db.booking.findMany({
    where:
      excludeBookingIds.length > 0
        ? { ...where, id: { not: booking.id, notIn: [...excludeBookingIds] } }
        : where,
    take: SAME_OWNER_COVERAGE_SOURCE_LIMIT,
    select: {
      id: true,
      guests: {
        // Member-linked rows only — see the narrowing note above.
        where: { memberId: { not: null } },
        select: BOOKING_HOSTING_SELECT.guests.select,
      },
    },
  })) as Array<{ id: string; guests: LoadedHostingBooking["guests"] }>;

  return sources
    .filter((source) => Array.isArray(source.guests))
    .flatMap((source) =>
      toHostingParticipants(source, true).map((participant) => ({
        ...participant,
        hostScope: "SAME_BOOKING_OWNER" as const,
      })),
    );
}

/**
 * The ids of the bookings whose hosting answer depends on THIS booking's rows —
 * exactly the set `loadSiblingHosts` borrows from, computed with the same
 * predicate so the two can never drift apart.
 *
 * The dependency is symmetric by construction: if A borrows B's adults, then a
 * change to B's adults changes A's answer. That is why the fan-out below reads
 * the same relation the borrow does.
 */
async function loadHostingSiblingIds(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
): Promise<string[]> {
  const booking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, memberId: true, parentBookingId: true },
  })) as Pick<LoadedHostingBooking, "id" | "memberId" | "parentBookingId"> | null;
  if (!booking) return [];

  const siblings = (await db.booking.findMany({
    where: hostingSiblingWhere(booking),
    select: { id: true },
  })) as Array<{ id: string }>;
  return siblings.map((sibling) => sibling.id);
}

/**
 * Evaluate one PERSISTED booking against the hosting policy in force at its
 * lodge. Returns null when the policy is disabled or every non-member
 * guest-night is covered.
 *
 * `db` follows the same composition rule as `validateMinimumStay`: a caller
 * already inside `prisma.$transaction` MUST pass its own `tx`.
 */
export async function evaluateBookingAdultMemberHosting(
  booking: LoadedHostingBooking,
  db: AdultMemberHostingReviewDb,
): Promise<{
  violation: AdultMemberHostingPolicyExceptionViolation | null;
  resolved: ResolvedAdultMemberHostingPolicy;
}> {
  const resolved = await loadAdultMemberHostingPolicy(booking.lodgeId, db);

  // A booking that is no longer happening has no hosting hazard (#2576).
  //
  // NECESSARY, NOT TIDY, and the cancel path is why. `reconcileAdultMemberHostingReview`
  // refuses an ENFORCED violation by throwing, and a cancelled booking's guest rows
  // survive the cancellation — so without this guard, reconciling a cancellation at
  // an enforcing lodge would evaluate a party that is not coming, find its
  // non-member guests uncovered, and REFUSE THE CANCELLATION. Every cancel at such
  // a lodge would fail. Returning "no hazard" instead also does the right thing to
  // the review row: the reconciler clears it, which is exactly what a cancelled
  // booking's hosting review should be.
  //
  // Deliberately status-based rather than date-based: a stay in the past is still a
  // real historical attendance record (§3), and its review is history, not a
  // hazard to re-open or clear.
  if (bookingAttendanceIsTerminal(booking)) {
    return { violation: null, resolved };
  }

  // Skip the sibling read entirely while the policy is off: it is the only query
  // this evaluation adds to every booking write, and a club that has not turned
  // the rule on should pay nothing for it.
  //
  // The SAME-OWNER read is skipped on that principle and one more: a club with the
  // rule on but `SAME_BOOKING_OWNER` off pays nothing either, which is what keeps
  // the #2569 upgrade a no-op on cost as well as on answers.
  let participants: HostingParticipant[] = [];
  if (hostingModeIsActive(resolved.mode)) {
    const siblings = await loadSiblingHosts(booking, db);
    participants = await withSubscriptionSettlement(
      [
        ...toHostingParticipants(booking),
        ...siblings.participants,
        ...(resolved.hostScopes.sameBookingOwner
          ? await loadSameBookingOwnerHosts(booking, db, siblings.siblingIds)
          : []),
      ],
      db,
      getSeasonYear(booking.checkIn),
    );
  }
  const violation = evaluateAdultMemberHostingWithPolicy(participants, resolved);
  return { violation, resolved };
}


/**
 * Is this booking's attendance over or abandoned?
 *
 * CANCELLED and BUMPED are the two terminal statuses in the booking lifecycle, and
 * `deletedAt` is the soft-delete an archived booking carries. None of the three
 * describes people who are coming to the lodge, so none of them can hold a hosting
 * hazard, supply cover, or need cover.
 *
 * The same three exclusions the eligible-SOURCE filter applies
 * (`hostingCoverageSourceBookingFilter`), stated here for the booking being
 * JUDGED rather than for the bookings supplying evidence — the two questions are
 * different and both need answering.
 */
function bookingAttendanceIsTerminal(
  booking: Pick<LoadedHostingBooking, "status" | "deletedAt">,
): boolean {
  if (booking.deletedAt != null) return true;
  return (
    booking.status === BookingStatus.CANCELLED ||
    booking.status === BookingStatus.BUMPED
  );
}

/**
 * Stamp #2543's `subscriptionSettled` onto participants, so a member the club is
 * charging as a non-member stops counting as a host.
 *
 * A NO-OP outside `NON_MEMBER_PRICING`: `loadUnpaidSubscriptionMemberIds`
 * returns an empty set without querying, the field stays absent, and the
 * hosting answer is byte-identical to pre-#2543 for every club that has not
 * opted in. It also runs only once the policy has already resolved to
 * ADMIN_REVIEW_REQUIRED, so a club with hosting off pays nothing either.
 */
async function withSubscriptionSettlement(
  participants: HostingParticipant[],
  db: SubscriptionLockoutDb,
  seasonYear: number,
): Promise<HostingParticipant[]> {
  const unpaid = await loadUnpaidSubscriptionMemberIds(db, {
    memberIds: participants.map((participant) => participant.member?.id),
    seasonYear,
  });
  if (unpaid.size === 0) return participants;
  return participants.map((participant) => {
    const memberId = participant.member?.id;
    return memberId && unpaid.has(memberId)
      ? { ...participant, subscriptionSettled: false }
      : participant;
  });
}

/**
 * Read a stored snapshot back without trusting it.
 *
 * The column is JSON, so a hand-edited or partially-written value is possible.
 * A value that does not carry the two fields the comparison actually reads is
 * treated as "no snapshot", which reopens the review rather than silently
 * comparing against nonsense.
 */
export function parseStoredHostingReview(
  value: unknown,
): AdultMemberHostingPolicyExceptionViolation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.reasonCode !== "ADULT_MEMBER_HOSTING_REQUIRED") return null;
  if (typeof row.policyId !== "string") return null;
  if (typeof row.policyVersion !== "number") return null;
  const requirements = row.requirements;
  if (!requirements || typeof requirements !== "object") return null;
  const uncovered = (requirements as Record<string, unknown>).uncovered;
  if (!Array.isArray(uncovered)) return null;
  return value as AdultMemberHostingPolicyExceptionViolation;
}

export type HostingReviewOutcome = (
  | /** Nothing was written: no hazard before, no hazard now. */
  { action: "none"; violation: null }
  /** The hazard cleared; any pending hosting review was released. */
  | { action: "cleared"; violation: null }
  /** A hazard is recorded and its review state was left exactly as it was. */
  | { action: "unchanged"; violation: AdultMemberHostingPolicyExceptionViolation }
  /** A hazard appeared on a booking that had none, and now awaits a decision. */
  | { action: "opened"; violation: AdultMemberHostingPolicyExceptionViolation }
  /** A materially different hazard replaced a decided one; it awaits a decision again. */
  | { action: "reopened"; violation: AdultMemberHostingPolicyExceptionViolation }
) & {
  /**
   * The mode the evaluation actually ran under; `null` when there was no
   * booking row to evaluate. Reported so a caller can tell "no hazard" from
   * "the club has not turned this on" without a second policy read — which is
   * what lets the sibling fan-out below stay free for a club that is not using
   * the rule.
   */
  mode: EffectiveAdultMemberHostingMode | null;
};

/**
 * How this caller wants the ENFORCED consequence applied (#2569 §1 and §13).
 *
 * `REFUSE` — the default, and what "stop booking unless corrected or an exception
 * is approved" means: an ENFORCED violation throws
 * `AdultMemberHostingRequiredError` from inside the caller's transaction, so the
 * non-compliant write rolls back and no review row is written for a booking that
 * does not exist. Default rather than opt-in deliberately: a write path added
 * later inherits the club's rule instead of quietly escaping it.
 *
 * `REVIEW_ONLY` — evaluate and record exactly as the review consequence does, and
 * never refuse. Reserved for the SCHOOL AND ORGANISATION workflows, which §13
 * excludes from this expanded enforcement in as many words: those bookings run a
 * separate officer-managed process and may be supervised by teachers, leaders or
 * custodians who do not map onto the adult club-member host rule at all. They keep
 * the pre-#2569 behaviour — the hazard is still recorded and surfaced, so an
 * officer sees it, but the booking is never stopped by this policy.
 */
export type HostingEnforcement = "REFUSE" | "REVIEW_ONLY";

/**
 * How a change that would strand ANOTHER same-owner booking's cover is handled
 * (#2576 §6 versus §7/§8).
 *
 * `BLOCK` — the ordinary member self-service answer. The dependent bookings are
 * re-evaluated against the rows the caller just wrote, and if any of them is left
 * uncovered the change is REFUSED with
 * `SameOwnerCoverageWouldBreakError`, thrown from inside the caller's transaction
 * so the change rolls back and the member is told which of their bookings, which
 * lodge and which nights.
 *
 * `ESCALATE` — the §7 and §8 answer. The change is allowed, and the bounded
 * re-evaluation work it implies is recorded durably in the SAME transaction; after
 * commit the drain re-reads the facts, opens or updates an urgent compliance
 * incident for anything newly uncovered, and notifies the owner and the officer
 * queue. Nothing is cancelled and no beds or payments move.
 *
 * `ESCALATE` IS THE DEFAULT, and that is the opposite choice from `enforcement`
 * above — deliberately, because the failure directions are opposite. A path that
 * inherits `REFUSE` and should not have been enforced merely annoys somebody; a
 * path that inherited `BLOCK` and should not have would ROLL BACK an authoritative
 * change — a membership lapse, an administrative cancellation, a payment-lifecycle
 * transition, a cron sweep — which §8 forbids in as many words and which would
 * wedge the system rather than protect anybody. `ESCALATE` is never silence: it
 * produces a durable incident, an officer-queue entry, an audit trail and an owner
 * notification.
 *
 * The member self-service paths therefore pass `BLOCK` explicitly, and
 * `adult-member-hosting-call-sites.test.ts` pins that set tree-wide so a new
 * member-facing edit route cannot quietly inherit the escalating behaviour.
 */
export type HostingDependentCoverageDisposition = "BLOCK" | "ESCALATE";

/** Who did the escalating change and why, for the incident and the audit trail. */
export interface HostingCoverageChangeContext {
  /**
   * `OFFICER_OVERRIDE` for §7 (an authorised officer deliberately overrode the
   * refusal, with a mandatory reason), `SYSTEM_CHANGE` for §8 (an authoritative
   * change outside the ordinary member edit flow).
   */
  cause: HostingCoverageIncidentCause;
  actorMemberId?: string | null;
  /** Mandatory for `OFFICER_OVERRIDE`; refused without one. */
  reason?: string | null;
}

/**
 * The reconcile options for an ACTOR-DRIVEN booking change (#2576 §6 versus §7/§8).
 *
 * One helper rather than a hand-written pair of fields at every call site, because
 * the distinction it encodes is a policy and not a local judgement, and because a
 * site that got it backwards would either trap a member or silently let cover be
 * removed. `adult-member-hosting-call-sites.test.ts` pins the set of files that use
 * it.
 *
 * THE RULE, straight from the owner's text:
 *
 *  - AN ORDINARY MEMBER'S SELF-SERVICE CHANGE IS BLOCKED (§6). They are told which
 *    of their own bookings, which lodge and which nights, and directed to amend
 *    that booking, restore alternative cover, or contact a Booking Officer.
 *  - AN AUTHORISED OFFICER'S CHANGE IS ALLOWED AND ESCALATED (§7, §8). §8 lists
 *    "authorised officer action" among the changes that cannot reasonably be
 *    blocked, and §7 describes what must happen instead: the affected booking stays
 *    confirmed with its beds and payments, gets an urgent compliance incident, the
 *    owner is notified, and the whole thing is audited. Refusing an officer would
 *    also be circular — they are the authority the member's refusal points to.
 *
 * WHERE THE OFFICER'S REASON COMES FROM. §7 makes a reason mandatory, and the cause
 * recorded on the incident reflects honestly whether one was actually captured: an
 * officer path that supplies a reason records `OFFICER_OVERRIDE` with that reason
 * against their member id, and one that does not records `SYSTEM_CHANGE` with the
 * officer still named as the actor in the audit row. It deliberately does NOT invent
 * a placeholder reason — an unexplained override recorded as though it had been
 * explained is worse than one recorded as what it was.
 */
export function hostingCoverageActorOptions(actor: {
  /** The session role at the acting site; "ADMIN" is the officer case. */
  actorRole?: string | null;
  /** Additionally treat a delegated bookings-edit permission as officer authority. */
  hasBookingsEditAccess?: boolean;
  actorMemberId?: string | null;
  /** The officer's reason for the change, where the surface captured one. */
  reason?: string | null;
}): Pick<HostingReconcileOptions, "dependentCoverage" | "coverageChange"> {
  const isOfficer =
    actor.actorRole === "ADMIN" || actor.hasBookingsEditAccess === true;
  if (!isOfficer) return { dependentCoverage: "BLOCK" };
  const reason = actor.reason?.trim();
  return {
    dependentCoverage: "ESCALATE",
    coverageChange: {
      cause: reason ? "OFFICER_OVERRIDE" : "SYSTEM_CHANGE",
      actorMemberId: actor.actorMemberId ?? null,
      reason: reason ?? null,
    },
  };
}

export interface HostingReconcileOptions {
  /**
   * Status to use when a hazard is opened for the FIRST time on this booking.
   * Defaults to PENDING. `APPROVED` requires `decision`, so an admin path
   * cannot auto-approve without recording who decided and why (D-R4).
   */
  openedStatus?: AdminReviewStatus;
  decision?: { reason: string; byMemberId: string } | null;
  /** See `HostingEnforcement`. Defaults to `REFUSE`. */
  enforcement?: HostingEnforcement;
  /**
   * See `HostingDependentCoverageDisposition`. Defaults to `ESCALATE`. Read only
   * by `reconcileAdultMemberHostingReviewWithSiblings` — the single-id form
   * settles one booking's own review and never reaches across accounts.
   */
  dependentCoverage?: HostingDependentCoverageDisposition;
  /** Required context for an `ESCALATE` change; see `HostingCoverageChangeContext`. */
  coverageChange?: HostingCoverageChangeContext;
}

/**
 * Bring a booking's hosting review into line with its CURRENT authoritative
 * facts, and report what changed.
 *
 * The rules, in the order they are applied:
 *
 *  - **No hazard now.** Clear the snapshot and the review. This is the "if every
 *    night becomes hosted, clear the pending review automatically" requirement,
 *    and it fires for every reason a hazard can end: an adult member was added,
 *    a non-member guest left, the nights moved, the member was reinstated, the
 *    lodge's policy was switched off, or the booking moved to a lodge that never
 *    had the rule. A DECIDED review is cleared too — the thing that was decided
 *    no longer exists, so leaving it would leave the booking permanently
 *    labelled with a hazard nobody can see in its guest list.
 *  - **Hazard, none recorded before.** Open it as PENDING. `openedStatus` lets a
 *    caller that has ALREADY captured an explicit decision (an admin on-behalf
 *    reason, per D-R4) open it as APPROVED instead — but only by supplying that
 *    reason, which is what stops a silent auto-approval.
 *  - **Hazard, and the recorded one is materially different.** Reopen as PENDING
 *    and drop the previous decision: a different set of uncovered guest-nights,
 *    or a different policy revision, is a different question.
 *  - **Hazard, materially identical.** Write nothing. An admin's decision stands
 *    while the hazard it was made about stands, and the guest list shuffling
 *    underneath it does not re-prompt them.
 */
export async function reconcileAdultMemberHostingReview(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
  options: HostingReconcileOptions = {},
): Promise<HostingReviewOutcome> {
  const booking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_HOSTING_SELECT,
  })) as LoadedHostingBooking | null;
  if (!booking) return { action: "none", violation: null, mode: null };
  // A row that came back without its guest relation is a narrowed select or a
  // partially-hydrated row, not a booking with nobody on it. Refuse to evaluate
  // it rather than conclude "no hazard" from absent evidence — that conclusion
  // would CLEAR a live review. Same reasoning as the `!= null` on `recorded`
  // below: when the facts are missing, write nothing.
  if (!Array.isArray(booking.guests)) {
    return { action: "none", violation: null, mode: null };
  }

  const { violation, resolved } = await evaluateBookingAdultMemberHosting(
    booking,
    db,
  );
  const mode = resolved.mode;

  // The ENFORCED consequence (#2569 §1): do not confirm a non-compliant booking.
  //
  // BEFORE any review write, and therefore before the caller's transaction can
  // commit. Throwing here rather than recording a review is the difference the
  // owner asked for: under review the booking exists and waits for an officer,
  // under enforced it never existed, and the member is handed the same
  // exception door instead. The write the caller just made rolls back with the
  // throw, so a modification that would have broken the rule leaves no trace.
  //
  // `REVIEW_ONLY` is the school/organisation carve-out (§13) — see
  // `HostingEnforcement`.
  //
  // AN EXPLICIT DECISION IS AN APPROVAL, so it is not refused. `options.decision`
  // is only ever set by a path that captured an admin's on-behalf reason (D-R4),
  // which is an officer approving this exact party with an attributable reason —
  // the same authority the exception door leads to. Refusing it would mean an
  // officer could approve a hosting exception for a booking they may not make.
  if (
    violation !== null &&
    mode === "ENFORCED" &&
    (options.enforcement ?? "REFUSE") === "REFUSE" &&
    !options.decision
  ) {
    throw new AdultMemberHostingRequiredError(violation);
  }

  const previous = parseStoredHostingReview(booking.adultMemberHostingReview);
  // `!= null` on purpose: a narrowed select, a partially-hydrated row or a test
  // double can leave the field UNDEFINED, and treating that as "a status is
  // recorded" would make this write a clearing UPDATE to a booking that never
  // had a hosting review.
  const recorded = previous !== null || booking.adultMemberHostingReviewStatus != null;

  if (violation === null) {
    if (!recorded) return { action: "none", violation: null, mode };
    await db.booking.update({
      where: { id: bookingId },
      data: {
        // `Prisma.DbNull`, not `null`: on a nullable Json column `null` is
        // ambiguous between the SQL NULL and the JSON value `null`, so Prisma
        // refuses it. SQL NULL is what "no hazard recorded" means here.
        adultMemberHostingReview: Prisma.DbNull,
        adultMemberHostingReviewStatus: null,
        adultMemberHostingReviewReason: null,
        adultMemberHostingReviewedById: null,
        adultMemberHostingReviewedAt: null,
      },
    });
    return { action: "cleared", violation: null, mode };
  }

  if (!recorded) {
    const openedStatus = options.openedStatus ?? AdminReviewStatus.PENDING;
    const decision =
      openedStatus === AdminReviewStatus.PENDING ? null : options.decision ?? null;
    if (openedStatus !== AdminReviewStatus.PENDING && !decision) {
      // D-R4 in code: the only way out of PENDING at open time is an explicit,
      // attributable reason. A caller that wants to auto-approve must have
      // captured one, and a programming error here fails loudly rather than
      // quietly approving.
      throw new Error(
        "Opening an adult-member hosting review as anything but PENDING requires an explicit decision reason",
      );
    }
    await db.booking.update({
      where: { id: bookingId },
      data: {
        adultMemberHostingReview: violation,
        adultMemberHostingReviewStatus: openedStatus,
        adultMemberHostingReviewReason: decision?.reason ?? null,
        adultMemberHostingReviewedById: decision?.byMemberId ?? null,
        adultMemberHostingReviewedAt: decision ? new Date() : null,
      },
    });
    return { action: "opened", violation, mode };
  }

  if (!adultMemberHostingReviewChanged(previous, violation)) {
    return { action: "unchanged", violation, mode };
  }

  await db.booking.update({
    where: { id: bookingId },
    data: {
      adultMemberHostingReview: violation,
      adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
      adultMemberHostingReviewReason: null,
      adultMemberHostingReviewedById: null,
      adultMemberHostingReviewedAt: null,
    },
  });
  return { action: "reopened", violation, mode };
}

/**
 * Reconcile a booking AND the split siblings whose answer depends on it (#2364).
 *
 * THE ENTRY POINT EVERY MUTATION PATH USES. `loadSiblingHosts` lets a #738 split
 * child borrow its parent's adults, which makes the child's answer a function of
 * rows the child does not own: the member shortening their own stay on the
 * parent takes a host away from the child, and extending it gives one back,
 * without touching a single row on the child. Reconciling only the mutated id
 * would leave the other half of the pair asserting facts that are no longer
 * true — no review where the club now has unhosted guest-nights, and a stale
 * PENDING review where it no longer does.
 *
 * The fan-out is ONE LEVEL and that is exact, not a safety margin: the borrow
 * relation is direct-parent / direct-child of the same member, so expanding from
 * a sibling could only ever lead back to the booking just reconciled. Each
 * sibling is reconciled with DEFAULT options — an admin's on-behalf decision
 * belongs to the booking they were making, never to a row reached through it, so
 * a hazard that appears on a sibling always opens PENDING.
 *
 * Costs nothing while the rule is off: the mode reported by the first
 * reconciliation is the same one it evaluated under, so a club that has not
 * turned the policy on pays no extra query on any booking write.
 */
export async function reconcileAdultMemberHostingReviewWithSiblings(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
  options: HostingReconcileOptions = {},
): Promise<HostingReviewOutcome> {
  const outcome = await reconcileAdultMemberHostingReview(bookingId, db, options);
  if (outcome.mode === null || !hostingModeIsActive(outcome.mode)) return outcome;

  for (const siblingId of await loadHostingSiblingIds(bookingId, db)) {
    // DEFAULT options, except that the caller's enforcement choice travels: an
    // admin's on-behalf decision belongs to the booking they were making and
    // never to a row reached through it, but a school booking's §13 carve-out
    // has to reach its split sibling too — otherwise one half of a #738 pair is
    // exempt and the other is refused, for the same party.
    await reconcileAdultMemberHostingReview(siblingId, db, {
      ...(options.enforcement ? { enforcement: options.enforcement } : {}),
    });
  }

  // #2576 §6 to §8: this booking's rows can also decide whether ANOTHER booking on
  // the same account is compliant. Last, and after the siblings, because it is a
  // question about the resulting state of the whole account at this lodge.
  await settleSameOwnerDependentCoverage(bookingId, db, options);
  return outcome;
}

/**
 * Record the hosting review for a booking that has just been created, INSIDE
 * the creating transaction.
 *
 * In the transaction on purpose: a booking that committed without its review
 * evaluated would sit unflagged until something else happened to touch it, and
 * "we would have caught it eventually" is not a policy.
 *
 * `adminReason` is the admin's explicit on-behalf confirmation (D-R4). Supplying
 * it opens the review already APPROVED, attributed to that admin; omitting it
 * opens PENDING. There is no third option — an admin path that wants to approve
 * must say why.
 */
export async function recordAdultMemberHostingReviewForNewBooking(
  bookingId: string,
  tx: AdultMemberHostingReviewDb,
  admin: { reason: string; byMemberId: string } | null,
): Promise<HostingReviewOutcome> {
  return reconcileAdultMemberHostingReview(bookingId, tx, {
    openedStatus: admin ? AdminReviewStatus.APPROVED : AdminReviewStatus.PENDING,
    decision: admin,
  });
}

/**
 * Record an officer's EXPLICIT decision on a hosting review that is already
 * recorded and still PENDING (#2526).
 *
 * `recordAdultMemberHostingReviewForNewBooking` can open a review straight to
 * APPROVED because nothing was recorded yet. A MODIFICATION cannot: the
 * canonical modification service reconciles the hazard from the rows it just
 * wrote, deliberately WITHOUT a decision (an unrelated edit must never
 * auto-approve a hosting exception), so the row lands PENDING. When the edit was
 * itself an approved booking-policy exception, the officer HAS decided — with a
 * reason, on the exact reviewed proposal — and that decision has to be written
 * after the service has reconciled, or the booking carries a pending review that
 * nobody will ever action.
 *
 * Deliberately narrow, and guarded at the database:
 *  - only PENDING → APPROVED. A cleared review (`adultMemberHostingReviewStatus`
 *    NULL, because the executed change resolved the hazard) is left alone, and a
 *    review somebody else already decided is never overwritten.
 *  - a `reason` is required, exactly as D-R4 requires everywhere else — "an
 *    officer clicked approve" is not an answer anybody can audit.
 *
 * Returns whether the guarded update actually moved a row, so the caller can log
 * the truth rather than an assumption.
 */
export async function recordAdultMemberHostingReviewDecision(
  bookingId: string,
  db: Pick<PrismaClient, "booking">,
  decision: { reason: string; byMemberId: string },
): Promise<boolean> {
  const reason = decision.reason.trim();
  if (!reason) {
    throw new Error(
      "Recording an adult-member hosting decision requires an explicit reason",
    );
  }
  const claim = await db.booking.updateMany({
    where: {
      id: bookingId,
      adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
    },
    data: {
      adultMemberHostingReviewStatus: AdminReviewStatus.APPROVED,
      adultMemberHostingReviewReason: reason.slice(0, 500),
      adultMemberHostingReviewedById: decision.byMemberId,
      adultMemberHostingReviewedAt: new Date(),
    },
  });
  return claim.count === 1;
}

/**
 * Evaluate a party that is not persisted yet (the create path).
 *
 * Create has to know BEFORE the transaction whether the rule will trip, because
 * that decides whether a member must supply a justification and whether an admin
 * booking on somebody's behalf must supply an explicit reason. It cannot read
 * guest rows, so it evaluates the submitted party, resolving each member-linked
 * guest against the live Member row.
 *
 * The result is used ONLY for those two decisions. The snapshot that gets stored
 * is always the one the reconciler derives from the persisted rows afterwards,
 * so `guestRef` values in a stored snapshot are always real `BookingGuest` ids
 * and two snapshots of the same booking are always comparable.
 */
export async function evaluateProposedAdultMemberHosting(
  db: Pick<
    PrismaClient,
    // #2543 adds the subscription/membership-type reads the host bridge needs.
    | "member"
    | "adultMemberHostingPolicy"
    | "lodge"
    | "memberSubscription"
    | "seasonalMembershipAssignment"
    | "membershipType"
  >,
  input: {
    lodgeId: string;
    checkIn: Date;
    checkOut: Date;
    guests: ReadonlyArray<{
      firstName: string;
      lastName: string;
      memberId?: string | null;
      stayStart?: Date | null;
      stayEnd?: Date | null;
      nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
    }>;
  },
): Promise<AdultMemberHostingPolicyExceptionViolation | null> {
  const resolved = await loadAdultMemberHostingPolicy(input.lodgeId, db);
  if (!hostingModeIsActive(resolved.mode)) return null;

  const memberIds = [
    ...new Set(
      input.guests
        .map((guest) => guest.memberId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const members = memberIds.length
    ? await db.member.findMany({
        where: { id: { in: memberIds } },
        select: {
          id: true,
          ageTier: true,
          active: true,
          cancelledAt: true,
          archivedAt: true,
        },
      })
    : [];
  const memberById = new Map(members.map((member) => [member.id, member]));

  const participants: HostingParticipant[] = input.guests.map((guest, index) => ({
    guestRef: `guest:${index}`,
    guestName: `${guest.firstName} ${guest.lastName}`.trim(),
    member: guest.memberId ? memberById.get(guest.memberId) ?? null : null,
    nights: proposedGuestNights(guest, input.checkIn, input.checkOut),
  }));

  return evaluateAdultMemberHostingWithPolicy(
    // #2543 — the same bridge the persisted path applies, so a proposed party
    // and the booking it becomes cannot disagree about who may host.
    await withSubscriptionSettlement(
      participants,
      db,
      getSeasonYear(input.checkIn),
    ),
    resolved,
  );
}

function proposedGuestNights(
  guest: {
    stayStart?: Date | null;
    stayEnd?: Date | null;
    nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
  },
  checkIn: Date,
  checkOut: Date,
): string[] {
  if (guest.nights && guest.nights.length > 0) {
    return guest.nights.map((entry) => {
      if (typeof entry === "string") return entry.slice(0, 10);
      if (entry instanceof Date) return formatDateOnly(entry);
      const stayDate = entry.stayDate;
      return typeof stayDate === "string"
        ? stayDate.slice(0, 10)
        : formatDateOnly(stayDate);
    });
  }
  const start = guest.stayStart ?? checkIn;
  const endExclusive = guest.stayEnd ?? checkOut;
  // A zero- or negative-width range yields no nights rather than throwing; the
  // booking's own date validation owns that refusal.
  if (endExclusive <= start) return [];
  return eachDateOnlyInRange(start, endExclusive).map(formatDateOnly);
}


/**
 * The columns the dependent-coverage machinery needs off a booking, without the
 * guest tree. Deliberately narrow: this read runs on booking write paths and only
 * ever decides WHICH bookings to look at.
 */
type CoverageOwnerFacts = {
  id: string;
  memberId: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
};

/**
 * Settle the same-owner bookings whose cover this change may have removed
 * (#2576 §6, §7, §8).
 *
 * Runs at the END of the mutation transaction, after the caller's write and after
 * the split-sibling fan-out, because it is a question about the RESULTING rows:
 * "given what is now true, is another booking on this account left uncovered".
 * Evaluating the pre-change rows would answer a question nobody asked.
 *
 * ONLY UNDER `ENFORCED`, AND ONLY WITH THE SCOPE ENABLED. Both conditions are
 * load-bearing:
 *
 *  - the scope: without `SAME_BOOKING_OWNER` no booking's compliance can depend on
 *    another booking, so there is nothing to strand and nothing to escalate;
 *  - the consequence: under `ADMIN_REVIEW_REQUIRED` an uncovered booking is a
 *    normal, permitted state that already carries a pending officer review.
 *    Refusing a member's edit, or opening a second officer-facing incident, for a
 *    situation the club has explicitly said it merely wants to look at would be a
 *    policy nobody chose.
 *
 * CONCURRENCY (§9). No new advisory-lock family, because the existing discipline
 * already closes the race, and it closes it precisely BECAUSE same-owner coverage
 * is same-lodge by definition (§4). Every path that can confirm a booking and every
 * path that can remove exact-night attendance takes the per-lodge capacity lock —
 * and most take the global `pg_advisory_xact_lock(1)` as well — for the booking's
 * own lodge, before doing either. Two interacting writers here are therefore always
 * contending for the SAME per-lodge key and cannot interleave: the source removal
 * either commits before the dependent's confirm reads (so the confirm sees it and
 * refuses) or after it (so the removal sees the confirmed dependent and is
 * refused or escalated). This function reads through the caller's `tx`, so it sees
 * that transaction's own writes and the committed state of everything else.
 */
async function settleSameOwnerDependentCoverage(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
  options: HostingReconcileOptions,
): Promise<void> {
  const booking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
    },
  })) as CoverageOwnerFacts | null;
  if (!booking) return;

  const resolved = await loadAdultMemberHostingPolicy(booking.lodgeId, db);
  if (resolved.mode !== "ENFORCED") return;
  if (!resolved.hostScopes.sameBookingOwner) return;

  const disposition = options.dependentCoverage ?? "ESCALATE";
  const context = options.coverageChange ?? { cause: "SYSTEM_CHANGE" as const };
  if (
    disposition === "ESCALATE" &&
    context.cause === "OFFICER_OVERRIDE" &&
    !context.reason?.trim()
  ) {
    // §7 makes the reason mandatory, and this is the point at which the override
    // becomes irreversible. Failing here rather than recording an unexplained
    // override is the same rule D-R4 already applies to a hosting decision.
    throw new Error(
      "Overriding same-owner hosting coverage requires an explicit reason",
    );
  }

  const { stranded, dependentsWithOpenIncidents } =
    await inspectSameOwnerDependents(booking, db);

  // REFUSE FIRST. A member self-service change that strands another of their
  // bookings is rolled back with the sentence §6 specifies, naming the affected
  // booking, its lodge and the uncovered nights.
  if (disposition === "BLOCK" && stranded.length > 0) {
    throw new SameOwnerCoverageWouldBreakError(stranded);
  }

  // ENQUEUE only where there is something to settle, which is the difference
  // between a queue and a log. Two conditions, and the SECOND one is the half
  // that is easy to forget:
  //
  //  - something is newly uncovered, so an incident has to be opened (§8);
  //  - or a dependent is carrying an OPEN incident, so the change may have
  //    RESTORED its cover and §7's automatic resolution is owed. This arm fires
  //    under BLOCK as well as ESCALATE: a member who fixes the problem by
  //    amending the booking has made a change that strands nobody, and the
  //    incident must not be left standing because the fix was permitted.
  //
  // A booking write that can affect nothing therefore writes nothing, so a club
  // on this scope does not accumulate a queue row per edit.
  if (stranded.length === 0 && dependentsWithOpenIncidents.length === 0) return;

  await enqueueHostingCoverageReevaluation(
    {
      memberId: booking.memberId,
      lodgeId: booking.lodgeId,
      // The nights this booking covers, and no others (§10). A change to this
      // booking cannot affect a night it never touched, so this IS the bound —
      // not a heuristic narrowing of a wider sweep.
      nights: eachDateOnlyInRange(booking.checkIn, booking.checkOut).map(
        formatDateOnly,
      ),
      cause: context.cause,
      sourceBookingId: booking.id,
      actorMemberId: context.actorMemberId ?? null,
      reason: context.reason ?? null,
    },
    db,
  );
}

/**
 * Record the re-evaluation this booking's OWN nights need, without evaluating and
 * without refusing anything (#2576 §8, §9).
 *
 * FOR THE CONFIRMING PATHS THAT MUST NOT BE REFUSED, and there are exactly two
 * shapes of those: the saved-card auto-charge cron and the group-settlement
 * confirmations. §8 names both — "payment or booking lifecycle failure",
 * "automated status transitions" — among the changes that "cannot reasonably be
 * blocked", and the reason is concrete rather than philosophical: by the time
 * either runs, capacity is claimed and a charge is either in flight or settled, so
 * throwing would leave money and beds pointing at a booking the club just refused.
 * §9's answer for them is the same as §8's: allow the transition, then re-read the
 * facts after commit and escalate to an urgent incident.
 *
 * WHY IT ENQUEUES RATHER THAN EVALUATES. Evaluating here would answer the question
 * against UNCOMMITTED rows, and the confirming transaction is exactly the one whose
 * commit decides the answer. The queue row commits WITH the confirmation — so the
 * obligation to look cannot be lost — and the drain re-reads afterwards. It also
 * keeps a background sweep, not a money transaction, as the thing that sends the
 * owner's email.
 *
 * The item names this booking's owner, lodge and own nights and nothing else, so it
 * is bounded by construction the same way every other item is (§10); the drain will
 * pick up any OTHER booking of the same owner over those nights as a matter of
 * course, which is correct — a confirmation adds attendance, and attendance can
 * RESTORE cover as easily as remove it.
 *
 * Returns the queued item id, or null when nothing was queued: the club is not
 * enforcing, the scope is off, or the booking has gone.
 */
export async function enqueueOwnHostingCoverageReevaluation(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
  context: HostingCoverageChangeContext = { cause: "SYSTEM_CHANGE" },
): Promise<string | null> {
  const booking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
    },
  })) as CoverageOwnerFacts | null;
  if (!booking) return null;

  const resolved = await loadAdultMemberHostingPolicy(booking.lodgeId, db);
  if (resolved.mode !== "ENFORCED") return null;
  if (!resolved.hostScopes.sameBookingOwner) return null;

  return enqueueHostingCoverageReevaluation(
    {
      memberId: booking.memberId,
      lodgeId: booking.lodgeId,
      nights: eachDateOnlyInRange(booking.checkIn, booking.checkOut).map(
        formatDateOnly,
      ),
      cause: context.cause,
      sourceBookingId: booking.id,
      actorMemberId: context.actorMemberId ?? null,
      reason: context.reason ?? null,
    },
    db,
  );
}

/**
 * Look at every same-owner booking this change could have touched, and report two
 * things: which are NEWLY uncovered, and which are already carrying an open
 * incident (#2576 §6, §7, §14).
 *
 * "NEWLY" IS THE WHOLE SUBTLETY, and getting it wrong makes the rule unusable in
 * one direction and useless in the other. A booking that was ALREADY uncovered —
 * because an officer overrode something last week, or a membership lapsed and an
 * incident is open — must not block an unrelated edit the member makes today: they
 * cannot fix that booking by abandoning this change, so refusing would trap them.
 * A booking that is uncovered only BECAUSE of this change must block it.
 *
 * The test is the shared material-identity key (`adultMemberHostingStateKey`, the
 * same definition that decides whether an officer's review decision still applies
 * and whether the owner has already been notified): if the dependent's uncovered
 * state after this change is identical to what its own stored review snapshot or
 * its open incident already records, this change did not cause it. Anything else —
 * a first hazard, or a materially different one — is caused by this change.
 *
 * The SECOND list is what makes automatic resolution work. A dependent with an open
 * incident has to be re-examined after commit whether or not anything is stranded
 * now, because the change may have RESTORED its cover — §14's existential rule and
 * §7's automatic resolution both live on that read.
 *
 * READ-ONLY. It evaluates each dependent rather than reconciling it, on purpose:
 * under `BLOCK` the change is about to be rolled back by the throw, so writing
 * review rows for dependents would either be undone (harmless but pointless) or,
 * worse, would record a hazard derived from rows that never existed.
 */
async function inspectSameOwnerDependents(
  booking: CoverageOwnerFacts,
  db: AdultMemberHostingReviewDb,
): Promise<{
  stranded: StrandedCoverageBooking[];
  dependentsWithOpenIncidents: string[];
}> {
  const dependents = (await db.booking.findMany({
    where: sameOwnerCoverageDependentWhere(booking),
    take: SAME_OWNER_COVERAGE_SOURCE_LIMIT,
    select: BOOKING_HOSTING_SELECT,
  })) as LoadedHostingBooking[];
  if (dependents.length === 0) {
    return { stranded: [], dependentsWithOpenIncidents: [] };
  }

  const openIncidents = await db.hostingCoverageIncident.findMany({
    where: {
      bookingId: { in: dependents.map((dependent) => dependent.id) },
      resolvedAt: null,
    },
    select: { bookingId: true, stateKey: true },
  });
  const incidentKeyByBooking = new Map(
    openIncidents.map((incident) => [incident.bookingId, incident.stateKey]),
  );

  const stranded: StrandedCoverageBooking[] = [];
  let lodgeName: string | null = null;
  for (const dependent of dependents) {
    if (!Array.isArray(dependent.guests)) continue;
    const { violation } = await evaluateBookingAdultMemberHosting(dependent, db);
    if (violation === null) continue;

    const currentKey = adultMemberHostingStateKey(violation);
    const recorded = parseStoredHostingReview(dependent.adultMemberHostingReview);
    if (recorded && adultMemberHostingStateKey(recorded) === currentKey) continue;
    const incidentKey = incidentKeyByBooking.get(dependent.id);
    if (incidentKey && incidentKey === hostingCoverageStateKey(violation)) continue;

    // Read the lodge name only once, and only where a refusal is actually being
    // built: the happy path costs no extra query.
    lodgeName ??= await resolveCoverageLodgeName(booking.lodgeId, db);
    stranded.push({
      bookingId: dependent.id,
      reference: strandedCoverageReference(dependent.id),
      lodgeName,
      nights: violation.affectedNights,
    });
  }

  return {
    stranded,
    dependentsWithOpenIncidents: openIncidents.map(
      (incident) => incident.bookingId,
    ),
  };
}

/**
 * The lodge's display name for the member-facing refusal.
 *
 * Falls back to a neutral word rather than throwing or leaking the id: the refusal
 * is already correct without it, and "your other booking at the lodge on these
 * nights" is a usable sentence where "your other booking at clv8k2p9x0001 …" is
 * not. The lodge is the one being changed, so there is no cross-lodge disclosure
 * to consider.
 */
async function resolveCoverageLodgeName(
  lodgeId: string,
  db: AdultMemberHostingReviewDb,
): Promise<string> {
  const lodge = await db.lodge.findFirst({
    where: { id: lodgeId },
    select: { name: true },
  });
  return lodge?.name ?? "the lodge";
}

/**
 * The dependent bookings one queued re-evaluation item covers (#2576 §10).
 *
 * The drain's entry point into this module, and the reason the bound is a property
 * of the DATA rather than of the caller's discipline: an item names one owner, one
 * lodge and an explicit night list, and this turns that into a booking id list by
 * intersecting the same three things. There is no shape of item that can widen it
 * into the lodge-wide sweep #2575 rejected.
 *
 * The night list bounds the read as a date envelope (earliest to latest night),
 * because the per-night decision belongs to the evaluator, which reads each
 * booking's own `BookingGuestNight` rows.
 */
export async function loadSameOwnerCoverageDependentIds(
  work: { memberId: string; lodgeId: string; nights: readonly string[] },
  db: AdultMemberHostingReviewDb,
): Promise<string[]> {
  const nights = [...new Set(work.nights)].sort();
  if (nights.length === 0) return [];
  const first = parseDateOnly(nights[0]);
  // The night AFTER the last one is the exclusive checkout bound, so a booking
  // arriving on the last night is included and one arriving the morning after is
  // not — the same half-open convention as everywhere else.
  const lastExclusive = addDaysDateOnly(parseDateOnly(nights[nights.length - 1]), 1);

  const dependents = await db.booking.findMany({
    where: sameOwnerCoverageDependentWhere({
      // A synthetic envelope rather than a real booking: the item may outlive the
      // booking that caused it (an administrative cancellation, a hard delete), and
      // the work is still owed. `id` excludes nothing, which is correct — every
      // active booking of this owner at this lodge over these nights is a
      // candidate, including the one that changed if it still exists.
      id: "",
      memberId: work.memberId,
      lodgeId: work.lodgeId,
      checkIn: first,
      checkOut: lastExclusive,
    }),
    take: SAME_OWNER_COVERAGE_SOURCE_LIMIT,
    select: { id: true },
  });
  return dependents.map((dependent) => dependent.id);
}

/**
 * Bring one dependent booking's incident state into line with current facts
 * (#2576 §8, §14, §16). Called by the drain, after commit, per dependent.
 *
 * Four outcomes, all idempotent:
 *
 *  - no hazard, no incident → nothing;
 *  - no hazard, an open incident → resolve it as `COVERAGE_RESTORED`. §14's
 *    existential rule reaches here: another eligible same-owner source keeps the
 *    booking compliant, so an incident opened when the first source went away is
 *    closed rather than left standing, and no loss-of-cover message is sent;
 *  - a hazard, no incident or a materially different one → open or update, and
 *    report the state key so the caller can notify ONCE for that transition;
 *  - a hazard identical to the recorded one → `unchanged`, and no notification.
 *
 * The review snapshot is reconciled first, with `REVIEW_ONLY`. That is not a
 * carve-out from the enforced consequence: the booking already exists and was
 * already confirmed, so there is nothing left to refuse — refusing here would
 * throw inside a background drain and roll back the incident that is the whole
 * point. Recording the hazard keeps the booking's own page and the officer's
 * booking view honest alongside the incident.
 */
export async function reconcileSameOwnerCoverageIncident(
  params: {
    bookingId: string;
    cause: HostingCoverageIncidentCause;
    actorMemberId?: string | null;
    reason?: string | null;
  },
  db: AdultMemberHostingReviewDb,
): Promise<
  // Flat rather than grouped by shape, so a caller narrowing on `action` reaches
  // `incidentId` without a cast.
  { action: "none" } | { action: "resolved" } | HostingCoverageIncidentOutcome
> {
  const outcome = await reconcileAdultMemberHostingReview(params.bookingId, db, {
    enforcement: "REVIEW_ONLY",
  });
  if (outcome.mode !== "ENFORCED") {
    // The club is no longer enforcing (or the booking moved out of scope), so an
    // incident is no longer the right instrument. Resolve rather than leave a row
    // an officer can do nothing useful with.
    const closed = await resolveHostingCoverageIncidents(
      { bookingId: params.bookingId, resolution: "COVERAGE_RESTORED" },
      db,
    );
    return { action: closed > 0 ? "resolved" : "none" };
  }

  if (outcome.violation === null) {
    const closed = await resolveHostingCoverageIncidents(
      {
        bookingId: params.bookingId,
        resolution: "COVERAGE_RESTORED",
        actorMemberId: params.actorMemberId ?? null,
      },
      db,
    );
    return { action: closed > 0 ? "resolved" : "none" };
  }

  const booking = await db.booking.findUnique({
    where: { id: params.bookingId },
    select: { lodgeId: true, status: true, deletedAt: true },
  });
  if (!booking) return { action: "none" };

  // AN INCIDENT IS ONLY EVER OPENED FOR A BOOKING THE CLUB HAS ACCEPTED (§7, §16:
  // "where a booking BECOMES UNCOVERED AFTER CONFIRMATION").
  //
  // NOT TIDINESS — this is the guard that stops a false urgent incident, and the
  // shape that produces one is real. The saved-card auto-charge claims a booking
  // PENDING -> CONFIRMED, queues this re-evaluation with the claim, and RELEASES it
  // back to PENDING if the charge does not complete. Without this test the drain
  // would arrive after the release, find an uncovered PENDING booking, and put a
  // stay nobody has confirmed in front of an officer as an emergency. The same
  // applies to every DRAFT, AWAITING_REVIEW or waitlisted booking the bounded read
  // legitimately returns: uncovered is a normal, permitted state for those, they
  // carry a pending hosting review already, and they will be refused at their own
  // confirmation (§9) if the cover has not come back.
  //
  // It does NOT resolve an incident that is already open. A CONFIRMED booking that
  // regressed to PENDING still holds its beds and its problem, and reporting that as
  // `COVERAGE_RESTORED` would tell an officer cover came back when nothing of the
  // kind happened. The row stays, and the next reconciliation of a re-confirmed
  // booking updates it.
  if (
    booking.deletedAt != null ||
    !isHostingCoverageSourceBookingStatus(String(booking.status))
  ) {
    return { action: "none" };
  }

  return openOrUpdateHostingCoverageIncident(
    {
      bookingId: params.bookingId,
      lodgeId: booking.lodgeId,
      cause: params.cause,
      violation: outcome.violation,
      override:
        params.cause === "OFFICER_OVERRIDE" &&
        params.actorMemberId &&
        params.reason?.trim()
          ? { byMemberId: params.actorMemberId, reason: params.reason }
          : null,
    },
    db,
  );
}

/**
 * The refusal the ENFORCED consequence raises (#2569 §1).
 *
 * DELIBERATELY THE SAME SHAPE AS `PaidUpAdultMemberRequiredError` (#2543/#2560),
 * down to the status code and the reasoning behind it: 409, not 403. A 403 says
 * "you may not do this"; this booking IS permitted, by a Booking Officer, through
 * the #2365 exception-request workflow — the state of the party is what conflicts.
 * It also keeps `ADULT_MEMBER_HOSTING_REQUIRED` out of the
 * `HARD_STOP_BOOKING_FAILURE_CODES` family, which is exactly the set of refusals
 * that may NOT enter exception review.
 *
 * NOT A SECOND REFUSAL PATH. The violation it carries is the same frozen
 * `AdultMemberHostingPolicyExceptionViolation` the review mode records, produced
 * by the same evaluator, aggregated by the same `aggregatePolicyExceptionViolations`
 * and re-derived server-side by `collectProposalPolicyViolations` when the member
 * walks through the exception door. Nothing about the officer queue, the frozen
 * snapshot or the override machinery is forked for the enforced mode — only
 * whether the booking is allowed to exist while it waits.
 *
 * WHY IT IS AN ApiError. It is thrown from inside the mutation transactions that
 * every booking write path already runs, so the throw rolls the non-compliant
 * write back — which is what "do not confirm a non-compliant booking" means in
 * practice — and every route that already handles `ApiError` answers 409 with the
 * message rather than a 500. Routes that want to hand the member the exception
 * door as well add a typed branch and return `buildAdultMemberHostingRefusalBody`.
 */
export class AdultMemberHostingRequiredError extends ApiError {
  readonly code = "ADULT_MEMBER_HOSTING_REQUIRED";
  readonly violation: AdultMemberHostingPolicyExceptionViolation;
  readonly exceptionReview: AggregatedPolicyExceptions;

  constructor(violation: AdultMemberHostingPolicyExceptionViolation) {
    super(violation.message, 409);
    this.name = "AdultMemberHostingRequiredError";
    this.violation = violation;
    this.exceptionReview = aggregatePolicyExceptionViolations([violation]);
  }
}

/**
 * Strip the identities of the adult members whose stays cover each night.
 *
 * REQUIRED, NOT DEFENSIVE (#2576 §11). A member-facing body has no business
 * carrying member ids under any scope: `memberIds` is an internal identity the
 * frozen snapshot keeps in full for validation and audit, and the member-facing
 * answer says only that adult-member cover is or is not present. Under
 * `SAME_BOOKING_OWNER` the covering stay is on the member's OWN account, so the
 * privacy stake is lower than the removed lodge-wide scope's was — but the rule is
 * applied to EVERY scope rather than only where it bites, because a redaction that
 * fires under one setting is a redaction nobody tests.
 *
 * The night list and the per-night scope list are kept: "this night is covered,
 * by an adult member on this booking" is the advice §17 asks for, and neither
 * field names a person.
 */
function withheldHostIdentities(
  violation: AdultMemberHostingPolicyExceptionViolation,
): AdultMemberHostingPolicyExceptionViolation {
  return {
    ...violation,
    requirements: {
      ...violation.requirements,
      qualifyingHostsByNight: violation.requirements.qualifyingHostsByNight.map(
        (night) => ({
          night: night.night,
          memberIds: [],
          ...(night.coveredByScopes
            ? { coveredByScopes: night.coveredByScopes }
            : {}),
        }),
      ),
    },
  };
}

/**
 * The member-facing body for an ENFORCED hosting refusal.
 *
 * Mirrors `buildPaidUpAdultRefusalBody` (#2543) so the two refusals a party can
 * trip at once are described the same way, and so a client can rely on
 * `exceptionReview.capacityMode` to know whether asking for an override keeps the
 * beds. Host identities are withheld — see `withheldHostIdentities`.
 *
 * `exceptionRequestPath` states where the member goes next rather than leaving the
 * client to know: "you were refused but you may ask" is useless advice if the
 * caller cannot find the door. For a NEW booking that door reserves nothing — the
 * request holds no beds and capacity is checked again at approval (#2569 §1) —
 * which is what `exceptionReview.capacityMode` reports honestly.
 */
export function buildAdultMemberHostingRefusalBody(
  violation: AdultMemberHostingPolicyExceptionViolation,
) {
  const redacted = withheldHostIdentities(violation);
  const exceptionReview = aggregatePolicyExceptionViolations([redacted]);
  return {
    error: redacted.message,
    code: "ADULT_MEMBER_HOSTING_REQUIRED" as const,
    details: redacted.message,
    violations: exceptionReview.violations,
    exceptionReview,
    exceptionRequestPath: "/api/bookings/exception-requests",
  };
}
