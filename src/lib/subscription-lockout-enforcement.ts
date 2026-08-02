import type {
  AgeTier,
  MemberGuestConsentStatus,
  PrismaClient,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import {
  aggregatePolicyExceptionViolations,
  type AggregatedPolicyExceptions,
  type PaidUpAdultMemberPolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import { peekSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import { resolveMembershipTypePoliciesForMembers } from "@/lib/membership-type-policy";
import type { HostingMemberFacts } from "@/lib/policies/adult-member-hosting";
import {
  buildPaidUpAdultMemberViolation,
  evaluatePaidUpAdultPresence,
  formatUnpaidSubscriptionRateReason,
  memberUnpaidSubscriptionForcesNonMemberRate,
  type PaidUpAdultParticipant,
} from "@/lib/policies/subscription-lockout-pricing";
import {
  loadMemberSubscriptionSettlements,
  subscriptionIsSettled,
  type MemberSubscriptionSettlement,
} from "@/lib/subscription-lockout-facts";
import { getSeasonYear } from "@/lib/utils";

/**
 * The ONE place the five booking write paths ask "what does this club's
 * subscription-lockout policy say about this party?" (#2543).
 *
 * The five paths are `POST /api/bookings`, `POST /api/bookings/[id]/confirm-draft`,
 * `POST /api/bookings/[id]/modify-quote`, `POST /api/bookings/[id]/guests`, and
 * the group-booking join in `group-booking.ts`. Each keeps its own
 * already-reviewed HARD_BLOCK refusal (they differ in shape — one returns a
 * `NextResponse`, one throws `ApiError`, one throws `GroupBookingError` — and
 * rewriting four working refusals to share a fifth shape would be churn with
 * risk and no gain). What they must NOT each own is the NEW behaviour, so
 * everything `NON_MEMBER_PRICING` adds lives here and is called identically from
 * all five.
 *
 * Division of labour with the rest of the #2543 stack:
 *
 *  - `member-subscription-eligibility.ts` resolves the club's MODE;
 *  - `subscription-lockout-facts.ts` answers "does this member owe?";
 *  - `policies/subscription-lockout-pricing.ts` is the pure RULE and the
 *    member-facing wording;
 *  - `membership-type-policy.ts` applies the reprice at the single pricing gate;
 *  - THIS module loads the party's live facts and turns the rule into the
 *    refusal, the notice, and the exception-eligible violation.
 *
 * It deliberately performs the paid-up-adult test and nothing about pricing: the
 * price is already guaranteed by the pricing gate, and a second, parallel
 * computation of the same money here is exactly the drift #2543 removes.
 */

/** The narrow client this module needs; a `Prisma.TransactionClient` satisfies it. */
export type SubscriptionLockoutDb = Pick<
  PrismaClient,
  "member" | "memberSubscription" | "seasonalMembershipAssignment" | "membershipType"
>;

/**
 * One participant of the proposed or live party, in the shape every caller can
 * cheaply produce.
 *
 * Nights are optional: `nights` wins when the caller holds per-night rows,
 * otherwise the guest's own `stayStart`/`stayEnd` window, otherwise the booking
 * envelope. Only `affectedNights` on the violation depends on them, so a caller
 * that legitimately has no per-guest detail still gets a correct refusal.
 */
export interface SubscriptionLockoutParticipant {
  /** Pricing-time snapshot. A false `isMember` row is never repriced. */
  isMember: boolean;
  memberId?: string | null;
  /** D-12 operational presence; absent means present, as in #2364. */
  operationallyPresent?: boolean;
  /**
   * NZ date-only lodge nights. A string is accepted (and read as `YYYY-MM-DD`)
   * because the create and group-join paths carry the member's raw request
   * values this far; parsing it here rather than making five callers convert is
   * what keeps them from each inventing their own conversion.
   */
  stayStart?: Date | string | null;
  stayEnd?: Date | string | null;
  nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
}

export interface NonMemberPricingRequirements {
  /**
   * Members whose own nights this booking prices at the built-in NON_MEMBER
   * rate because their season subscription is required and unpaid. Sorted, so
   * two evaluations of one party produce the same list.
   */
  repricedMemberIds: string[];
  /** At least one paid-up adult member is staying on this booking. */
  hasPaidUpAdultMember: boolean;
  /**
   * Whether the paid-up-adult requirement applies to this party at all.
   *
   * TRUE only when the club is in `NON_MEMBER_PRICING` *and* this party actually
   * contains somebody being repriced for an unpaid subscription. See the
   * `violation` note below for why the requirement is conditional.
   */
  paidUpAdultMemberRequired: boolean;
  /**
   * The "told why" sentence to show the member, or null when nobody is
   * repriced. Names no one and no amount — it is rendered straight into booking
   * and quote responses that a family member may be reading.
   */
  memberRateNotice: string | null;
  /**
   * The frozen, exception-eligible violation when this party owes a paid-up adult
   * member and has none; null otherwise. A caller that receives one MUST refuse
   * the booking and offer the override-request path.
   *
   * THE REQUIREMENT IS CONDITIONAL ON A REPRICE, and that scoping is load-bearing.
   * The owner's rule is about the unpaid member: "they get charged non-member
   * rates, and there still has to be at least one paid-up adult member on the
   * booking". Applied unconditionally to every booking instead, switching a club
   * to `NON_MEMBER_PRICING` — which is a RELAXATION of the hard block — would
   * newly refuse whole classes of booking that are legal today and have nothing
   * to do with subscriptions: a paid-up Youth member booking their own bed, a
   * family booking whose only member row is a child, an all-non-member party. The
   * club asked to stop turning unpaid members away, not to start turning those
   * away. "Is there a responsible adult member present?" in the general case is
   * already the adult-member-hosting policy's question (#2364), which a club
   * configures separately and which composes with this one.
   */
  violation: PaidUpAdultMemberPolicyExceptionViolation | null;
}

/**
 * The refusal a booking path raises when the party has no paid-up adult member.
 *
 * 409, not 403. A 403 says "you may not do this"; this booking IS permitted, by
 * a Booking Officer, through the #2365 exception-request workflow — the state of
 * the party is what conflicts. It also keeps the code out of the
 * `HARD_STOP_BOOKING_FAILURE_CODES` family, which is precisely the set of
 * refusals that may NOT enter exception review.
 */
export class PaidUpAdultMemberRequiredError extends ApiError {
  readonly code = "PAID_UP_ADULT_MEMBER_REQUIRED";
  readonly violation: PaidUpAdultMemberPolicyExceptionViolation;
  readonly exceptionReview: AggregatedPolicyExceptions;

  constructor(violation: PaidUpAdultMemberPolicyExceptionViolation) {
    super(violation.message, 409);
    this.name = "PaidUpAdultMemberRequiredError";
    this.violation = violation;
    this.exceptionReview = aggregatePolicyExceptionViolations([violation]);
  }
}

/**
 * The response body every path returns for this refusal.
 *
 * Shared so the five paths cannot describe the same refusal five ways — and so
 * the member-facing client can rely on `exceptionReview.capacityMode === "HOLD"`
 * to promise that requesting an override keeps the beds.
 */
export function buildPaidUpAdultRefusalBody(
  violation: PaidUpAdultMemberPolicyExceptionViolation,
) {
  const exceptionReview = aggregatePolicyExceptionViolations([violation]);
  return {
    error: violation.message,
    code: "PAID_UP_ADULT_MEMBER_REQUIRED" as const,
    details: violation.message,
    violations: exceptionReview.violations,
    exceptionReview,
    /**
     * Where the member goes next. Stated in the payload rather than assumed by
     * the client, because "you were refused but you may ask" is useless advice
     * if the caller cannot find the door.
     */
    exceptionRequestPath: "/api/bookings/exception-requests",
  };
}

/**
 * Turn persisted `BookingGuest` rows (or anything shaped like them) into
 * participants.
 *
 * The one thing worth centralising: a member guest whose invite is still
 * PENDING is NOT operationally present (D-12), so they cannot be the party's
 * paid-up adult — the kiosk, the arrival roster and bed allocation all already
 * leave them out, and a "responsible adult" who may never turn up is not one.
 * A pre-persist party (the create path) has no consent facts yet and passes its
 * inputs straight through, where absent means present, exactly as #2364 does.
 */
export function toSubscriptionLockoutParticipants<
  Guest extends {
    isMember: boolean;
    memberId?: string | null;
    stayStart?: Date | null;
    stayEnd?: Date | null;
    memberGuestConsentStatus?: MemberGuestConsentStatus | null;
  },
>(guests: ReadonlyArray<Guest>): SubscriptionLockoutParticipant[] {
  return guests.map((guest) => ({
    isMember: guest.isMember,
    memberId: guest.memberId ?? null,
    stayStart: guest.stayStart ?? null,
    stayEnd: guest.stayEnd ?? null,
    operationallyPresent: isOperationallyPresentConsent(
      guest.memberGuestConsentStatus,
    ),
  }));
}

/** Accept the date-only shapes the five paths already carry; reject nothing. */
function toDateOnly(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const parsed = parseDateOnly(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function participantNights(
  participant: SubscriptionLockoutParticipant,
  checkIn: Date,
  checkOut: Date,
): string[] {
  if (participant.nights && participant.nights.length > 0) {
    return participant.nights.map((entry) => {
      if (typeof entry === "string") return entry.slice(0, 10);
      if (entry instanceof Date) return formatDateOnly(entry);
      const stayDate = entry.stayDate;
      return typeof stayDate === "string"
        ? stayDate.slice(0, 10)
        : formatDateOnly(stayDate);
    });
  }
  const start = toDateOnly(participant.stayStart) ?? checkIn;
  const endExclusive = toDateOnly(participant.stayEnd) ?? checkOut;
  // A zero- or negative-width range yields no nights rather than throwing; the
  // booking's own date validation owns that refusal.
  if (endExclusive <= start) return [];
  return eachDateOnlyInRange(start, endExclusive).map(formatDateOnly);
}

type LiveMemberFacts = HostingMemberFacts & { ageTier: AgeTier };

/**
 * Evaluate everything `NON_MEMBER_PRICING` adds, for one party.
 *
 * Returns `null` — cheaply, before any query — when the club is not in
 * `NON_MEMBER_PRICING`. Every caller treats a `null` as "nothing new applies",
 * which is what keeps HARD_BLOCK and NO_BLOCK byte-identical to pre-#2543.
 *
 * `mode` may be passed by a caller that has already resolved it (all five write
 * paths have, to decide whether to run their HARD_BLOCK refusal), so the party
 * is judged against exactly the mode the gate branched on. Resolving it twice
 * inside one request would let an admin's mid-request settings change refuse
 * under one regime and price under the other.
 */
export async function evaluateNonMemberPricingRequirements(
  db: SubscriptionLockoutDb,
  input: {
    mode?: SubscriptionLockoutMode;
    lodgeId: string;
    seasonYear: number;
    checkIn: Date;
    checkOut: Date;
    participants: ReadonlyArray<SubscriptionLockoutParticipant>;
  },
): Promise<NonMemberPricingRequirements | null> {
  const mode = input.mode ?? (await peekSubscriptionLockoutMode());
  if (mode !== "NON_MEMBER_PRICING") return null;

  const memberIds = [
    ...new Set(
      input.participants
        .filter((participant) => participant.isMember)
        .map((participant) => participant.memberId?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds,
    seasonYear: input.seasonYear,
  });
  const members: LiveMemberFacts[] = memberIds.length
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
  const memberById = new Map<string, LiveMemberFacts>(
    members.map((member) => [member.id, member]),
  );

  const settlements = await loadMemberSubscriptionSettlements(db, {
    memberIds,
    seasonYear: input.seasonYear,
    subscriptionBehaviorByMember: new Map(
      [...policies].map(([memberId, policy]) => [
        memberId,
        policy.subscriptionBehavior,
      ]),
    ),
  });

  const settlementFor = (
    memberId: string,
  ): MemberSubscriptionSettlement | undefined => settlements.get(memberId);

  const repricedMemberIds = memberIds
    .filter((memberId) =>
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: true,
        subscriptionRequired:
          settlementFor(memberId)?.subscriptionRequired ?? false,
        subscriptionPaid: settlementFor(memberId)?.subscriptionPaid ?? false,
      }),
    )
    .sort();

  const paidUpParticipants: PaidUpAdultParticipant[] = input.participants.map(
    (participant) => {
      const memberId = participant.isMember
        ? participant.memberId?.trim() || null
        : null;
      return {
        member: memberId ? (memberById.get(memberId) ?? null) : null,
        operationallyPresent: participant.operationallyPresent,
        // A non-member (or an unresolvable member link) is already excluded by
        // `member: null` inside the predicate; `false` is the safe filler for a
        // fact nobody asked about, and stays safe if the predicate is ever
        // reordered.
        subscriptionSettled: memberId
          ? subscriptionIsSettled(settlementFor(memberId))
          : false,
      };
    },
  );

  const presence = evaluatePaidUpAdultPresence(paidUpParticipants);

  // The requirement only bites on a party this mode is actually repricing — see
  // `NonMemberPricingRequirements.violation`.
  const paidUpAdultMemberRequired = repricedMemberIds.length > 0;
  const violated = paidUpAdultMemberRequired && !presence.hasPaidUpAdult;

  const affectedNights = violated
    ? [
        ...new Set(
          input.participants.flatMap((participant) =>
            participantNights(participant, input.checkIn, input.checkOut),
          ),
        ),
      ].sort()
    : [];

  return {
    repricedMemberIds,
    hasPaidUpAdultMember: presence.hasPaidUpAdult,
    paidUpAdultMemberRequired,
    memberRateNotice: paidUpAdultMemberRequired
      ? formatUnpaidSubscriptionRateReason(
          `${input.seasonYear}/${input.seasonYear + 1}`,
        )
      : null,
    violation: violated
      ? buildPaidUpAdultMemberViolation({
          affectedNights,
          effectiveLodgeId: input.lodgeId,
          repricedUnpaidMemberCount: repricedMemberIds.length,
          participantCount: input.participants.length,
        })
      : null,
  };
}

/**
 * The proposed-party form of the same rule, for the #2365 exception-request
 * machinery.
 *
 * Mirrors `evaluateProposedAdultMemberHosting` deliberately, down to the guest
 * shape, so a member who is refused by a booking path and then submits the same
 * party as an override request gets the SAME answer from the SAME rule. Returns
 * null when the club is not in `NON_MEMBER_PRICING`, or when the party already
 * has a paid-up adult member — in which case there is nothing to review and the
 * request machinery correctly refuses to create one.
 */
export async function evaluateProposedPaidUpAdultPresence(
  db: SubscriptionLockoutDb,
  input: {
    lodgeId: string;
    checkIn: Date;
    checkOut: Date;
    guests: ReadonlyArray<{
      isMember: boolean;
      memberId?: string | null;
      nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
    }>;
  },
): Promise<PaidUpAdultMemberPolicyExceptionViolation | null> {
  const requirements = await evaluateNonMemberPricingRequirements(db, {
    lodgeId: input.lodgeId,
    seasonYear: getSeasonYear(input.checkIn),
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    participants: input.guests.map((guest) => ({
      isMember: guest.isMember,
      memberId: guest.memberId ?? null,
      nights: guest.nights ?? null,
    })),
  });
  return requirements?.violation ?? null;
}

/**
 * Which of these members the club is currently repricing as non-members, for
 * the hosting bridge (#2543 ↔ #2364).
 *
 * Returns an EMPTY set outside `NON_MEMBER_PRICING`, so the hosting evaluator's
 * `subscriptionSettled` stays absent — and therefore its answer byte-identical —
 * for every club that has not opted in.
 */
export async function loadUnpaidSubscriptionMemberIds(
  db: SubscriptionLockoutDb,
  params: {
    memberIds: ReadonlyArray<string | null | undefined>;
    seasonYear: number;
    mode?: SubscriptionLockoutMode;
  },
): Promise<ReadonlySet<string>> {
  const empty: ReadonlySet<string> = new Set<string>();
  const memberIds = [
    ...new Set(
      params.memberIds
        .map((id) => id?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (memberIds.length === 0) return empty;

  const mode = params.mode ?? (await peekSubscriptionLockoutMode());
  if (mode !== "NON_MEMBER_PRICING") return empty;

  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds,
    seasonYear: params.seasonYear,
  });
  const settlements = await loadMemberSubscriptionSettlements(db, {
    memberIds,
    seasonYear: params.seasonYear,
    subscriptionBehaviorByMember: new Map(
      [...policies].map(([memberId, policy]) => [
        memberId,
        policy.subscriptionBehavior,
      ]),
    ),
  });

  const unpaid = new Set<string>();
  for (const memberId of memberIds) {
    if (!subscriptionIsSettled(settlements.get(memberId))) {
      unpaid.add(memberId);
    }
  }
  return unpaid;
}
