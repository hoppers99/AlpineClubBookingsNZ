import { AgeTier } from "@prisma/client";

import type {
  AdultMemberHostingPolicyExceptionViolation,
  PolicyExceptionCapacityMode,
  QualifyingHostsForNight,
  ResolvedPolicyScope,
  UncoveredGuestNight,
} from "@/lib/booking-policy-exceptions";

/**
 * The configurable adult-member hosting policy (#2364, epic decision D-R3).
 *
 * A club may require every non-member guest-night to overlap an adult member who
 * is actually staying on the same booking. This module is the pure evaluator:
 * it takes already-loaded policy rows and already-loaded participant facts and
 * returns either nothing or one frozen violation in the shape #2363 registered.
 * It performs no I/O, so it is deterministic and directly testable, and the
 * decision about WHICH client reads the rows belongs to `booking-policies.ts`.
 *
 * Three rules are load-bearing and easy to get wrong:
 *
 *  - **Booking ownership never proves attendance.** The owning member counts
 *    only through a participant row linked to them, and only on the nights that
 *    row actually covers. Nothing in this module is given `Booking.memberId`, so
 *    a caller cannot accidentally credit an owner who is not staying.
 *  - **The member link is the authority, not the `isMember` flag.** A guest row
 *    carries `isMember` as a pricing-time snapshot; whether somebody is a member
 *    ADULT in good standing today is a fact about the Member row. A row whose
 *    member cannot be resolved is treated as a non-member guest — the safe
 *    direction, because that means it needs hosting rather than provides it.
 *  - **A membership that has lapsed is not a membership.** APPLIED PRINCIPLE
 *    (review of #2364; reversible by the owner): the safe direction above is
 *    applied to a member who is resolvable but no longer in good standing.
 *    A participant whose Member row is inactive, cancelled or archived is judged
 *    exactly as a non-member guest: they cannot host, and their own nights need
 *    hosting. Without this they fell between the two predicates and escaped the
 *    rule entirely — the one shape in which the club's own rule protects the
 *    club's guests LESS than it would for a plain non-member. Deliberately keyed
 *    off standing only, never `ageTier`: a member CHILD or YOUTH still does not
 *    need hosting (the minors rule in `booking-review.ts` owns children), and an
 *    active `NOT_APPLICABLE` organisation member is treated exactly as before.
 *    If the club's position is instead that the member LINK alone is the
 *    authority, the reversal is to drop `active`/`cancelledAt`/`archivedAt` from
 *    `participantQualifiesAsHost` — not to narrow the predicate below.
 */

/** Mirrors the Prisma `AdultMemberHostingMode` enum without importing it. */
export type AdultMemberHostingMode =
  | "INHERIT"
  | "DISABLED"
  | "ADMIN_REVIEW_REQUIRED";

/** The mode an evaluation can actually run under: INHERIT always resolves away. */
export type EffectiveAdultMemberHostingMode = "DISABLED" | "ADMIN_REVIEW_REQUIRED";

export interface AdultMemberHostingPolicyLike {
  id: string;
  scopeKey: string;
  lodgeId: string | null;
  mode: AdultMemberHostingMode;
  capacityMode: PolicyExceptionCapacityMode;
  version: number;
}

/**
 * The authoritative Member facts a participant row is judged by. Deliberately
 * the live columns rather than anything cached on the guest row: a member who
 * has since been made inactive, cancelled or archived stops hosting from that
 * moment AND starts needing a host themselves, and one who has aged down stops
 * hosting — which is what makes re-evaluation meaningful.
 */
export interface HostingMemberFacts {
  id: string;
  ageTier: AgeTier | string;
  active: boolean;
  cancelledAt: Date | null;
  archivedAt: Date | null;
}

export interface HostingParticipant {
  /** `BookingGuest.id`, or `guest:<index>` for a party that has no rows yet. */
  guestRef: string;
  guestName: string;
  /** Resolved Member row for a member-linked participant; null otherwise. */
  member: HostingMemberFacts | null;
  /** NZ lodge nights (YYYY-MM-DD) this participant's row actually covers. */
  nights: string[];
  /**
   * Whether this row is operationally present at the lodge (D-12). A member
   * guest whose invite is still `PENDING` is not: the kiosk, the arrival roster,
   * bed allocation and the arrival emails all leave them out, so they cannot be
   * the responsible adult either. Absent means present — the pre-persist create
   * path has no consent facts yet, and every other participant is a row that
   * really is coming.
   */
  operationallyPresent?: boolean;
  /**
   * Whether this member's season subscription is settled — PAID, or the season
   * gate says one is not required for them (#2543).
   *
   * ABSENT MEANS SETTLED, and that default is load-bearing: under the two modes
   * that are not `NON_MEMBER_PRICING` nobody is repriced, so nothing about
   * hosting changes and every existing caller keeps its pre-#2543 answer without
   * being touched. Only the booking-side loader that knows the club is in
   * `NON_MEMBER_PRICING` populates it, and only then can it be `false`.
   *
   * WHY IT DISQUALIFIES A HOST (owner decision, 2 Aug 2026, #2543): under
   * `NON_MEMBER_PRICING` an unpaid member is being CHARGED as a non-member, and
   * the club's position is that somebody the club is charging as a non-member is
   * not the responsible member the hosting rule asks for. Their non-member guests
   * therefore need a genuinely paid-up adult member present.
   *
   * WHY IT DOES NOT MAKE THEM A GUEST NEEDING HOSTING: deliberately asymmetric,
   * and narrower than the lapsed-member rule above. A lapsed membership is gone;
   * an unpaid subscription is a membership in good standing with a bill
   * outstanding. The owner's rule moves them on the money axis and on the
   * "counts as the responsible adult" axis only. `participantIsNonMemberGuest`
   * therefore does NOT read this field, so an unpaid member's own nights are not
   * suddenly uncovered guest-nights needing admin review — the paid-up-adult
   * requirement in `subscription-lockout-pricing.ts` is what covers the party.
   */
  subscriptionSettled?: boolean;
  /**
   * True for somebody who is staying with this party but is carried on a
   * SIBLING booking row — they can host, but their own nights are not this
   * booking's responsibility.
   *
   * This exists for the split-booking shape (#738): a mixed member/non-member
   * party awaiting payment is stored as a member booking plus a linked
   * non-member child. Judged in isolation the child contains no member at all,
   * so a rule about "an adult member on the same booking" would fire on every
   * single one of them while the member is demonstrably staying. The member is
   * therefore fed in as a host-only participant, and the child's own non-member
   * guests remain the ones that need covering. The parent, whose own guests are
   * all members, has nothing to cover and produces no violation — so one party
   * yields one hazard, not two.
   *
   * It is deliberately NOT how a group booking works: a group joiner's booking
   * belongs to a different member, so the organiser's adults never leak in and
   * "the same booking" keeps meaning what it says.
   */
  hostOnly?: boolean;
}

export interface ResolvedAdultMemberHostingPolicy {
  mode: EffectiveAdultMemberHostingMode;
  capacityMode: PolicyExceptionCapacityMode;
  /** Null only for the synthesised "no row configured" default. */
  policyId: string | null;
  policyVersion: number;
  resolvedScope: ResolvedPolicyScope;
}

/** Frozen onto every violation so a snapshot names the rule it came from. */
export const ADULT_MEMBER_HOSTING_POLICY_NAME = "Adult member hosting requirement";

/**
 * Identity used when no policy row exists for a scope at all. It can only ever
 * appear with `mode: "DISABLED"`, so it never reaches a violation snapshot; it
 * exists so `resolveAdultMemberHostingPolicy` always returns a total answer.
 */
export const UNCONFIGURED_ADULT_MEMBER_HOSTING_POLICY_ID = null;

/**
 * A scope that cannot be resolved is refused, never silently treated as
 * "disabled". Failing closed here means failing LOUDLY: the caller cannot tell
 * an unconfigured club (a real, permissive answer) from a lodge it could not
 * identify, and quietly picking the permissive one would drop a club's rule.
 */
export class UnknownAdultMemberHostingScopeError extends Error {
  constructor(readonly detail: string) {
    super(`Cannot resolve the adult-member hosting policy scope: ${detail}`);
    this.name = "UnknownAdultMemberHostingScopeError";
  }
}

/**
 * Club-wide default with per-lodge override (ADR-001 resolved question 3), with
 * one difference from the minimum-stay policy SET: this policy is a single row
 * per scope, so a lodge overrides by holding a row whose mode is not INHERIT,
 * and says "use the club default" by holding an INHERIT row (or no row at all).
 *
 * `rows` may contain rows for other lodges; they are ignored. Order is
 * irrelevant — the club row and this lodge's row are each unique in the
 * database, and a duplicate reaching here is refused rather than picked between.
 */
export function resolveAdultMemberHostingPolicy(
  rows: readonly AdultMemberHostingPolicyLike[],
  effectiveLodgeId: string,
): ResolvedAdultMemberHostingPolicy {
  if (!effectiveLodgeId) {
    throw new UnknownAdultMemberHostingScopeError("no lodge was resolved");
  }

  const lodgeRows = rows.filter((row) => row.lodgeId === effectiveLodgeId);
  if (lodgeRows.length > 1) {
    throw new UnknownAdultMemberHostingScopeError(
      `lodge ${effectiveLodgeId} has ${lodgeRows.length} rows`,
    );
  }
  const clubRows = rows.filter((row) => row.lodgeId === null);
  if (clubRows.length > 1) {
    throw new UnknownAdultMemberHostingScopeError(
      `the club has ${clubRows.length} club-wide rows`,
    );
  }

  const lodgeRow = lodgeRows[0] ?? null;
  if (lodgeRow && lodgeRow.mode !== "INHERIT") {
    return {
      mode: lodgeRow.mode,
      capacityMode: lodgeRow.capacityMode,
      policyId: lodgeRow.id,
      policyVersion: lodgeRow.version,
      resolvedScope: {
        kind: "LODGE",
        lodgeId: effectiveLodgeId,
        effectiveLodgeId,
      },
    };
  }

  const clubRow = clubRows[0] ?? null;
  if (clubRow) {
    if (clubRow.mode === "INHERIT") {
      // The migration's CHECK constraint forbids this, so reaching it means the
      // constraint is gone or the row came from somewhere that is not the
      // database. Refuse rather than loop or guess.
      throw new UnknownAdultMemberHostingScopeError(
        "the club-wide row is INHERIT, which has nothing to inherit from",
      );
    }
    return {
      mode: clubRow.mode,
      capacityMode: clubRow.capacityMode,
      policyId: clubRow.id,
      policyVersion: clubRow.version,
      resolvedScope: {
        kind: "CLUB_WIDE",
        lodgeId: null,
        effectiveLodgeId,
      },
    };
  }

  // Nothing configured anywhere. That is a real, deterministic answer — the
  // club has not turned the requirement on — and NOT the unknown-scope case
  // above. Capacity mode is meaningless while disabled; NO_HOLD is stated
  // rather than left undefined so the shape stays total.
  return {
    mode: "DISABLED",
    capacityMode: "NO_HOLD",
    policyId: UNCONFIGURED_ADULT_MEMBER_HOSTING_POLICY_ID,
    policyVersion: 0,
    resolvedScope: {
      kind: "CLUB_WIDE",
      lodgeId: null,
      effectiveLodgeId,
    },
  };
}

/**
 * Whether the club still recognises this participant as a member in good
 * standing. The single fact both predicates below are built from, so the two can
 * never disagree about the same row and let somebody fall between them.
 */
function memberIsInGoodStanding(
  member: HostingMemberFacts | null,
): member is HostingMemberFacts {
  return (
    member !== null &&
    member.active === true &&
    member.cancelledAt === null &&
    member.archivedAt === null
  );
}

/**
 * Whether this participant's row lets them host a non-member guest tonight.
 *
 * Every clause is a live Member fact. `NOT_APPLICABLE` (organisations/schools,
 * #1440) is not an adult and deliberately does not qualify: the rule is about a
 * responsible adult being present, and an organisation is not a person. Nor does
 * a row that is not operationally present (D-12) — an unaccepted member-guest
 * invite is not a responsible adult at the lodge, and the arrival roster,
 * the kiosk and bed allocation all already agree. Nor does a member the club is
 * currently charging as a non-member because their subscription is unpaid
 * (#2543) — see `HostingParticipant.subscriptionSettled`, which is absent (and
 * so treated as settled) everywhere except under `NON_MEMBER_PRICING`.
 */
export function participantQualifiesAsHost(
  participant: Pick<
    HostingParticipant,
    "member" | "operationallyPresent" | "subscriptionSettled"
  >,
): boolean {
  if (participant.operationallyPresent === false) return false;
  if (participant.subscriptionSettled === false) return false;
  const member = participant.member;
  if (!memberIsInGoodStanding(member)) return false;
  return member.ageTier === AgeTier.ADULT;
}

/**
 * A participant the rule treats as a non-member guest: no resolvable Member row,
 * or one the club no longer recognises (inactive, cancelled or archived). See
 * the third load-bearing rule in the module header — this is the exact
 * complement of the standing test in `participantQualifiesAsHost`, so a lapsed
 * member cannot escape by being neither.
 *
 * `ageTier` is deliberately absent: a member CHILD or YOUTH in good standing
 * does not need hosting under THIS rule (the minors rule owns them), and an
 * active `NOT_APPLICABLE` organisation member is unchanged by this predicate.
 */
export function participantIsNonMemberGuest(
  participant: Pick<HostingParticipant, "member">,
): boolean {
  return !memberIsInGoodStanding(participant.member);
}

function uniqueSortedNights(nights: readonly string[]): string[] {
  return [...new Set(nights)].sort();
}

/**
 * The member-facing sentence. Names the rule and the size of the problem, never
 * a guest — the guest/night evidence is in `requirements` for the admin screen
 * and the server log, and this string is rendered straight into a booking
 * response.
 */
export function formatAdultMemberHostingMessage(
  uncoveredCount: number,
  affectedNightCount: number,
): string {
  const nights = `${affectedNightCount} night${affectedNightCount === 1 ? "" : "s"}`;
  const guestNights = `${uncoveredCount} guest night${uncoveredCount === 1 ? "" : "s"}`;
  return (
    "This club asks that an adult member stays on the same booking as any " +
    `non-member guest. On ${nights} of this booking, ${guestNights} have no ` +
    "adult member staying, so an admin needs to look at it."
  );
}

/**
 * Evaluate one booking's participants against an already-resolved policy.
 *
 * Returns `null` when the policy is disabled, when the party has no non-member
 * guest-nights, or when every such night is already covered. Otherwise the
 * frozen violation: policy identity and version, resolved scope, the affected
 * NZ nights, the exact uncovered guest+night pairs, the qualifying member ids
 * for every candidate night, eligibility and the policy's capacity mode.
 *
 * Determinism is a contract, not a nicety: `adultMemberHostingReviewChanged`
 * compares two snapshots to decide whether a pending review reopens, so an
 * unstable order would reopen reviews for no reason. Every list is sorted and
 * de-duplicated here rather than at the call sites.
 */
export function evaluateAdultMemberHostingWithPolicy(
  participants: readonly HostingParticipant[],
  resolved: ResolvedAdultMemberHostingPolicy,
): AdultMemberHostingPolicyExceptionViolation | null {
  if (resolved.mode !== "ADMIN_REVIEW_REQUIRED") return null;

  // Nights on which at least one qualifying adult member is staying.
  const hostsByNight = new Map<string, Set<string>>();
  for (const participant of participants) {
    if (!participantQualifiesAsHost(participant)) continue;
    const memberId = participant.member?.id;
    if (!memberId) continue;
    for (const night of uniqueSortedNights(participant.nights)) {
      const hosts = hostsByNight.get(night) ?? new Set<string>();
      hosts.add(memberId);
      hostsByNight.set(night, hosts);
    }
  }

  const uncovered: UncoveredGuestNight[] = [];
  const candidateNights = new Set<string>();
  for (const participant of participants) {
    if (participant.hostOnly === true) continue;
    if (!participantIsNonMemberGuest(participant)) continue;
    for (const night of uniqueSortedNights(participant.nights)) {
      candidateNights.add(night);
      if ((hostsByNight.get(night)?.size ?? 0) > 0) continue;
      uncovered.push({
        guestRef: participant.guestRef,
        guestName: participant.guestName,
        night,
      });
    }
  }

  if (uncovered.length === 0) return null;

  uncovered.sort(
    (a, b) =>
      a.night.localeCompare(b.night) || a.guestRef.localeCompare(b.guestRef),
  );

  const affectedNights = uniqueSortedNights(uncovered.map((row) => row.night));

  // Every night a non-member guest stays, covered or not: an admin reading the
  // snapshot needs to see which nights ARE hosted and by whom, and the uncovered
  // nights alone would always report an empty host list by construction.
  const qualifyingHostsByNight: QualifyingHostsForNight[] = [
    ...candidateNights,
  ]
    .sort()
    .map((night) => ({
      night,
      memberIds: [...(hostsByNight.get(night) ?? [])].sort(),
    }));

  return {
    reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
    // A resolved ADMIN_REVIEW_REQUIRED mode always came from a real row, so the
    // synthesised null id is unreachable here; the fallback keeps the frozen
    // shape total rather than leaving a `null` where a string is promised.
    policyId: resolved.policyId ?? "unconfigured",
    policyVersion: resolved.policyVersion,
    policyName: ADULT_MEMBER_HOSTING_POLICY_NAME,
    resolvedScope: resolved.resolvedScope,
    affectedNights,
    requirements: {
      kind: "ADULT_MEMBER_HOSTING",
      requiredAdultMemberParticipantsPerGuestNight: 1,
      uncoveredNonMemberGuestNights: uncovered.length,
      uncovered,
      qualifyingHostsByNight,
    },
    exceptionEligible: true,
    capacityMode: resolved.capacityMode,
    message: formatAdultMemberHostingMessage(
      uncovered.length,
      affectedNights.length,
    ),
  };
}

/**
 * Has the hazard materially changed between two snapshots?
 *
 * "Materially" is exactly: a different policy row or revision, or a different
 * set of uncovered guest-nights. Everything else — a renamed guest, a night
 * that gained a second host, the qualifying-host lists — is evidence about the
 * same hazard and must not reopen a review an admin already decided.
 *
 * `null` means "no hazard". null -> violation is a change (a new hazard
 * appeared); violation -> null is a change (it cleared).
 */
export function adultMemberHostingReviewChanged(
  previous: AdultMemberHostingPolicyExceptionViolation | null,
  next: AdultMemberHostingPolicyExceptionViolation | null,
): boolean {
  if (previous === null || next === null) return previous !== next;
  if (previous.policyId !== next.policyId) return true;
  if (previous.policyVersion !== next.policyVersion) return true;
  const key = (violation: AdultMemberHostingPolicyExceptionViolation) =>
    violation.requirements.uncovered
      .map((row) => `${row.night} ${row.guestRef}`)
      .join("|");
  return key(previous) !== key(next);
}
