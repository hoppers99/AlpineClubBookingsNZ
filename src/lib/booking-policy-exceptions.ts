import { formatDateOnly } from "@/lib/date-only";

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
  "FULL_LODGE",
  "INVALID_DATES",
  "PAST_DATES",
  "AUTHENTICATION_REQUIRED",
  "SUBSCRIPTION_INELIGIBLE",
  "MEMBERSHIP_INELIGIBLE",
  "DUPLICATE_MEMBER_NIGHT",
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
 * Contract reserved for #2364's evaluator. Defining it here makes the registry
 * closed and reviewable without implementing hosting policy early.
 */
export type AdultMemberHostingPolicyExceptionViolation = FrozenExceptionFacts & {
  reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED";
  requirements: {
    kind: "ADULT_MEMBER_HOSTING";
    requiredAdultMemberParticipantsPerGuestNight: 1;
    uncoveredNonMemberGuestNights: number;
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
