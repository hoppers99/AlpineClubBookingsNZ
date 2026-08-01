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
 * Two rules are load-bearing and easy to get wrong:
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
 * has since been made inactive, cancelled, archived or aged down stops hosting
 * from that moment, which is what makes re-evaluation meaningful.
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
 * Whether this participant's row lets them host a non-member guest tonight.
 *
 * Every clause is a live Member fact. `NOT_APPLICABLE` (organisations/schools,
 * #1440) is not an adult and deliberately does not qualify: the rule is about a
 * responsible adult being present, and an organisation is not a person.
 */
export function participantQualifiesAsHost(
  participant: Pick<HostingParticipant, "member">,
): boolean {
  const member = participant.member;
  if (!member) return false;
  return (
    member.ageTier === AgeTier.ADULT &&
    member.active === true &&
    member.cancelledAt === null &&
    member.archivedAt === null
  );
}

/** A participant with no resolvable Member row is a non-member guest. */
export function participantIsNonMemberGuest(
  participant: Pick<HostingParticipant, "member">,
): boolean {
  return participant.member === null;
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
 * The one sentence an UNAUTHENTICATED surface answers with, for the same reason
 * `PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE` exists (#2363): a non-member holding
 * a join code must not be able to read the club's policy configuration, or how
 * many people are on somebody else's booking, out of a refusal body.
 */
export const PUBLIC_ADULT_MEMBER_HOSTING_MESSAGE =
  "This club asks that an adult member stays alongside non-member guests, so " +
  "this sign-up needs to be checked by the club. Please contact the organiser.";

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
