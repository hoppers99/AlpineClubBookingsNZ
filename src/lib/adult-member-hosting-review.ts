import {
  AdminReviewStatus,
  BookingStatus,
  Prisma,
  type MemberGuestConsentStatus,
  type PrismaClient,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import type {
  AdultMemberHostingPolicyExceptionViolation,
  AggregatedPolicyExceptions,
} from "@/lib/booking-policy-exceptions";
import { aggregatePolicyExceptionViolations } from "@/lib/booking-policy-exceptions";
import { eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";
import { getDefaultLodgeId } from "@/lib/lodges";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import { prisma } from "@/lib/prisma";
import {
  adultMemberHostingReviewChanged,
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
      // narrowed: omitting them would hand the resolver three `undefined`s,
      // which it reads as "this row did not decide" — so a lodge with a custom
      // scope set would silently fall back to the club's, or to the built-in
      // default, and the club's rule would be quietly widened or narrowed.
      hostScopeSameBooking: true,
      hostScopeAnyMemberAtLodge: true,
      hostScopeNominatedHost: true,
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
): Promise<HostingParticipant[]> {
  const siblings = (await db.booking.findMany({
    where: hostingSiblingWhere(booking),
    select: BOOKING_HOSTING_SELECT,
  })) as LoadedHostingBooking[];

  return siblings
    // A sibling that arrived without its guest relation contributes no hosts.
    // Dropping it is the safe direction here: fewer borrowed hosts can only
    // OPEN a review for an admin to look at, never suppress one.
    .filter((sibling) => Array.isArray(sibling.guests))
    .flatMap((sibling) => toHostingParticipants(sibling, true));
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
  // Skip the sibling read entirely while the policy is off: it is the only
  // query this evaluation adds to every booking write, and a club that has not
  // turned the rule on should pay nothing for it.
  const participants = hostingModeIsActive(resolved.mode)
    ? await withSubscriptionSettlement(
        [
          ...toHostingParticipants(booking),
          ...(await loadSiblingHosts(booking, db)),
        ],
        db,
        getSeasonYear(booking.checkIn),
      )
    : [];
  const violation = evaluateAdultMemberHostingWithPolicy(participants, resolved);
  return { violation, resolved };
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
 * REQUIRED, NOT DEFENSIVE (#2569 §5). Under the `ANY_MEMBER_AT_LODGE` scope a
 * night can be covered by an adult member on somebody else's booking, who has not
 * been nominated, is not related to the booking owner and is not taking
 * responsibility for anybody. The owner's decision is explicit that such a
 * member's identity is never disclosed to the booking owner: the member-facing
 * answer says only that adult-member cover is or is not present. `memberIds` is
 * exactly that identity, so it is dropped from every member-facing body while the
 * frozen snapshot the officer reviews keeps it in full for validation, dependency
 * tracking and audit.
 *
 * Applied to EVERY scope rather than only to the wide one, because a member-facing
 * body has no business carrying member ids under any scope, and a redaction that
 * only fires under one setting is a redaction nobody tests.
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
