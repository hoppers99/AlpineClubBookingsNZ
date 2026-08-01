import { getStayNights } from "./pricing";
import {
  aggregatePolicyExceptionViolations,
  canonicalAffectedNights,
  type MinimumStayPolicyExceptionViolation,
  type PolicyExceptionCapacityMode,
} from "@/lib/booking-policy-exceptions";

export type MinimumStayViolation = MinimumStayPolicyExceptionViolation;

export interface MinimumStayPolicyLike {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  triggerDays: number[];
  minimumNights: number;
  lodgeId: string | null;
  version: number;
  capacityMode: PolicyExceptionCapacityMode;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayName(day: number): string {
  return DAY_NAMES[day] ?? `Day ${day}`;
}

/**
 * Check if two date ranges overlap.
 * Range A: [aStart, aEnd], Range B: [bStart, bEnd] (all inclusive).
 */
function dateRangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function getMinimumStayViolations(
  checkIn: Date,
  checkOut: Date,
  policies: MinimumStayPolicyLike[],
  effectiveLodgeId: string,
): MinimumStayViolation[] {
  const nights = getStayNights(checkIn, checkOut);
  const nightCount = nights.length;

  if (nightCount === 0 || policies.length === 0) {
    return [];
  }

  const violations: MinimumStayViolation[] = [];

  for (const policy of policies) {
    // Date-only values are UTC midnight by contract. getUTCDay prevents the
    // host machine's timezone from changing which weekday activates a policy.
    const affected = nights.filter((night) => {
      const dow = night.getUTCDay();
      return (
        policy.triggerDays.includes(dow) &&
        dateRangesOverlap(night, night, policy.startDate, policy.endDate)
      );
    });

    if (affected.length > 0 && nightCount < policy.minimumNights) {
      // Find the first triggering day name for the message
      const triggerDayNames = [...new Set(
        policy.triggerDays
          .filter((d) => affected.some((n) => n.getUTCDay() === d))
          .map(dayName)
      )];

      const triggerDay = triggerDayNames.join(", ");
      const message = `Bookings including a ${triggerDay} night require a minimum stay of ${policy.minimumNights} nights (${policy.name}). Your booking is ${nightCount} night${nightCount === 1 ? "" : "s"}.`;

      violations.push({
        reasonCode: "MINIMUM_STAY",
        policyId: policy.id,
        policyVersion: policy.version,
        policyName: policy.name,
        resolvedScope: policy.lodgeId
          ? {
              kind: "LODGE",
              lodgeId: policy.lodgeId,
              effectiveLodgeId,
            }
          : {
              kind: "CLUB_WIDE",
              lodgeId: null,
              effectiveLodgeId,
            },
        affectedNights: canonicalAffectedNights(affected),
        requirements: {
          kind: "MINIMUM_STAY",
          minimumNights: policy.minimumNights,
          actualNights: nightCount,
          triggerDays: [...new Set(policy.triggerDays)].sort((a, b) => a - b),
        },
        exceptionEligible: true,
        capacityMode: policy.capacityMode,
        message,
        triggerDay,
        minimumNights: policy.minimumNights,
        actualNights: nightCount,
      });
    }
  }

  return aggregatePolicyExceptionViolations(violations).violations as MinimumStayViolation[];
}

export function validateMinimumStayWithPolicies(
  checkIn: Date,
  checkOut: Date,
  policies: MinimumStayPolicyLike[],
  effectiveLodgeId: string,
): { valid: boolean; violations: MinimumStayViolation[] } {
  const violations = getMinimumStayViolations(
    checkIn,
    checkOut,
    policies,
    effectiveLodgeId,
  );
  return { valid: violations.length === 0, violations };
}

// test seam
/**
 * Format a violation into a user-friendly error message.
 */
export function formatViolationMessage(violation: MinimumStayViolation): string {
  return violation.message;
}

/**
 * Format all violations into a single details string for API responses.
 */
export function formatViolationsDetail(violations: MinimumStayViolation[]): string {
  return violations.map(formatViolationMessage).join(" ");
}
