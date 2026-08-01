import { formatDateOnly } from "@/lib/date-only";
import { ApiError } from "@/lib/api-error";

/**
 * The complete, explicit soft-policy allowlist (#2363).
 *
 * A code not present here is structurally unable to enter exception review.
 * In particular capacity/full-lodge, invalid/past dates, authentication,
 * subscription/membership eligibility, duplicate member-night, payment,
 * privacy and data-integrity failures remain hard stops.
 */
export const POLICY_EXCEPTION_REASON_CODES = [
  "MINIMUM_STAY",
  "ADULT_MEMBER_HOSTING_REQUIRED",
] as const;

export type PolicyExceptionReasonCode =
  (typeof POLICY_EXCEPTION_REASON_CODES)[number];

export const HARD_STOP_BOOKING_FAILURE_CODES = [
  "CAPACITY_EXCEEDED",
  "INVALID_DATES",
  "PAST_DATES",
  "AUTHENTICATION_REQUIRED",
  "SUBSCRIPTION_REQUIRED",
  "GUEST_SUBSCRIPTION_REQUIRED",
  "MEMBERSHIP_TYPE_BLOCKS_BOOKING",
  "MEMBER_GUEST_NOT_ADDABLE",
  "BOOKING_MEMBER_NIGHT_CONFLICT",
  "PAYMENT_REQUIRED",
  "PRIVACY_RESTRICTION",
  "DATA_INTEGRITY_FAILURE",
] as const;

export type HardStopBookingFailureCode =
  (typeof HARD_STOP_BOOKING_FAILURE_CODES)[number];

export const POLICY_EXCEPTION_CAPACITY_MODES = ["HOLD", "NO_HOLD"] as const;
export type PolicyExceptionCapacityMode =
  (typeof POLICY_EXCEPTION_CAPACITY_MODES)[number];

export type ResolvedPolicyScope =
  | {
      kind: "CLUB_WIDE";
      /** The policy row itself is club-wide. */
      lodgeId: null;
      /** The lodge for which this club-wide row was resolved. */
      effectiveLodgeId: string;
    }
  | {
      kind: "LODGE";
      /** The lodge-specific override row and effective lodge are identical. */
      lodgeId: string;
      effectiveLodgeId: string;
    };

type PolicyIdentity = {
  policyId: string;
  policyVersion: number;
  policyName: string;
};

type FrozenExceptionFacts = PolicyIdentity & {
  resolvedScope: ResolvedPolicyScope;
  /** Sorted, unique New Zealand lodge-night values (YYYY-MM-DD). */
  affectedNights: string[];
  exceptionEligible: true;
  capacityMode: PolicyExceptionCapacityMode;
  /** Plain-language rendering; structured fields remain authoritative. */
  message: string;
};

export type MinimumStayPolicyExceptionViolation = FrozenExceptionFacts & {
  reasonCode: "MINIMUM_STAY";
  /** Compatibility display fields; requirements remains the canonical shape. */
  triggerDay: string;
  minimumNights: number;
  actualNights: number;
  requirements: {
    kind: "MINIMUM_STAY";
    minimumNights: number;
    actualNights: number;
    /** Sorted numeric weekdays, 0=Sunday ... 6=Saturday. */
    triggerDays: number[];
  };
};

/**
 * One non-member guest on one NZ lodge night that no adult member covers.
 *
 * `guestRef` identifies the guest ROW where one exists (`BookingGuest.id`) and
 * falls back to the pre-persist position `guest:<index>` on the create path,
 * which evaluates a party that has no rows yet. Both forms are stable within one
 * snapshot, which is all the comparison in `adultMemberHostingReviewChanged`
 * needs; neither is a durable handle to be dereferenced later.
 */
export type UncoveredGuestNight = {
  guestRef: string;
  guestName: string;
  /** NZ lodge night, YYYY-MM-DD. */
  night: string;
};

/** The adult members whose participant rows cover one night, if any. */
export type QualifyingHostsForNight = {
  night: string;
  /** Sorted Member ids. Empty means the night has no qualifying host. */
  memberIds: string[];
};

/**
 * Contract reserved by #2363 for #2364's evaluator, now implemented by
 * `evaluateAdultMemberHostingWithPolicy` (`policies/adult-member-hosting.ts`).
 *
 * `requirements` carries the EVIDENCE as well as the rule, because the whole
 * point of this violation is that it names which guest is uncovered on which
 * night — a bare count would leave an admin unable to see what to fix, and would
 * leave the reconciler unable to tell "the same hazard" from "a materially
 * different one". Every list is sorted so two evaluations of the same facts
 * produce byte-identical snapshots.
 */
export type AdultMemberHostingPolicyExceptionViolation = FrozenExceptionFacts & {
  reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED";
  requirements: {
    kind: "ADULT_MEMBER_HOSTING";
    requiredAdultMemberParticipantsPerGuestNight: 1;
    uncoveredNonMemberGuestNights: number;
    /** Sorted by night then guestRef. */
    uncovered: UncoveredGuestNight[];
    /** One entry per affected night, in night order. */
    qualifyingHostsByNight: QualifyingHostsForNight[];
  };
};

export type PolicyExceptionViolation =
  | MinimumStayPolicyExceptionViolation
  | AdultMemberHostingPolicyExceptionViolation;

export interface AggregatedPolicyExceptions {
  violations: PolicyExceptionViolation[];
  /** Null when there is nothing to review; otherwise HOLD wins if any row holds. */
  capacityMode: PolicyExceptionCapacityMode | null;
}

/**
 * Typed transport for mutation paths that still hard-block minimum-stay
 * violations. #2365 may add durable review; #2363 only preserves the frozen
 * snapshot and aggregate alongside the legacy prose and HTTP 400.
 */
export class MinimumStayPolicyViolationError extends ApiError {
  readonly code = "MINIMUM_STAY_VIOLATION";
  readonly violations: MinimumStayPolicyExceptionViolation[];
  readonly exceptionReview: AggregatedPolicyExceptions;

  constructor(
    public readonly details: string,
    violations: MinimumStayPolicyExceptionViolation[],
  ) {
    super(details, 400);
    this.name = "MinimumStayPolicyViolationError";
    this.exceptionReview = aggregatePolicyExceptionViolations(violations);
    this.violations = this.exceptionReview
      .violations as MinimumStayPolicyExceptionViolation[];
  }
}

export function isPolicyExceptionReasonCode(
  value: string,
): value is PolicyExceptionReasonCode {
  return (POLICY_EXCEPTION_REASON_CODES as readonly string[]).includes(value);
}

export function isHardStopBookingFailureCode(
  value: string,
): value is HardStopBookingFailureCode {
  return (HARD_STOP_BOOKING_FAILURE_CODES as readonly string[]).includes(value);
}

/** Canonicalise date-only nights once, at the policy boundary. */
export function canonicalAffectedNights(nights: Date[]): string[] {
  return [...new Set(nights.map(formatDateOnly))].sort();
}

/** Deterministic order makes API snapshots, review fingerprints and tests stable. */
export function sortPolicyExceptionViolations(
  violations: PolicyExceptionViolation[],
): PolicyExceptionViolation[] {
  return [...violations].sort((a, b) =>
    a.reasonCode.localeCompare(b.reasonCode) ||
    a.policyId.localeCompare(b.policyId) ||
    a.policyVersion - b.policyVersion ||
    a.affectedNights.join(",").localeCompare(b.affectedNights.join(",")),
  );
}

export function aggregatePolicyExceptionViolations(
  violations: PolicyExceptionViolation[],
): AggregatedPolicyExceptions {
  for (const violation of violations) {
    if (!isPolicyExceptionReasonCode(violation.reasonCode)) {
      throw new Error(
        `Non-allowlisted booking failure cannot enter policy exception review: ${violation.reasonCode}`,
      );
    }
  }
  const ordered = sortPolicyExceptionViolations(violations);
  return {
    violations: ordered,
    capacityMode:
      ordered.length === 0
        ? null
        : ordered.some((violation) => violation.capacityMode === "HOLD")
          ? "HOLD"
          : "NO_HOLD",
  };
}
