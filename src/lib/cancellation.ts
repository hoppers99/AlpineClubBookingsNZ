import { normalizeCancellationRule } from "./cancellation-rules";
import { getDefaultLodgeId, resolvePolicyRowsForLodge } from "./lodges";
import { prisma } from "./prisma";
import { type CancellationRule } from "./policies/cancellation";

export {
  calculateAppliedCreditRestore,
  calculateDualRefundAmounts,
  calculateRefundAmount,
  daysUntilDate,
  // test seam
  getRefundTier,
} from "./policies/cancellation";
export type { CancellationRule } from "./policies/cancellation";

/**
 * Find the active BookingPeriod that covers a given check-in date at one
 * lodge, if any. Periods follow the club-wide-with-override rule (ADR-001
 * resolved question 3): a lodge with its own period rows uses them instead of
 * the club-wide set, so the whole active type is fetched and resolved before
 * the date is matched. Callers without lodge context omit lodgeId and get the
 * club's default lodge.
 */
export async function getBookingPeriodForDate(
  checkIn: Date,
  lodgeId?: string | null
) {
  const effectiveLodgeId = lodgeId ?? (await getDefaultLodgeId(prisma));
  const allPeriods = await prisma.bookingPeriod.findMany({
    where: {
      active: true,
      OR: [{ lodgeId: effectiveLodgeId }, { lodgeId: null }],
    },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });

  return (
    resolvePolicyRowsForLodge(allPeriods, effectiveLodgeId).find(
      (period) => period.startDate <= checkIn && period.endDate >= checkIn
    ) ?? null
  );
}

/**
 * Get the non-member hold days for a given check-in date.
 * Uses period-specific value if check-in falls in a BookingPeriod,
 * otherwise uses the global default from BookingDefaults.
 */
export async function getNonMemberHoldDays(
  checkIn: Date,
  lodgeId?: string | null
): Promise<number> {
  const period = await getBookingPeriodForDate(checkIn, lodgeId);
  if (period) {
    return period.nonMemberHoldDays;
  }

  const defaults = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
  });
  return defaults?.nonMemberHoldDays ?? 7;
}

/**
 * Load the cancellation policy for a given check-in date.
 * If the check-in falls within an active BookingPeriod, uses that period's rules.
 * Otherwise falls back to the default CancellationPolicy table.
 */
export async function loadCancellationPolicy(
  checkIn?: Date,
  lodgeId?: string | null
): Promise<CancellationRule[]> {
  const effectiveLodgeId = lodgeId ?? (await getDefaultLodgeId(prisma));
  if (checkIn) {
    const period = await getBookingPeriodForDate(checkIn, effectiveLodgeId);
    if (period) {
      const rawRules = period.cancellationRules as unknown as Array<{
        daysBeforeStay: number;
        refundPercentage: number;
        creditRefundPercentage?: number;
        fixedFeeCents?: number;
        creditFixedFeeCents?: number;
      }>;
      return rawRules
        .map(normalizeCancellationRule)
        .sort((a, b) => b.daysBeforeStay - a.daysBeforeStay);
    }
  }

  const allRules = await prisma.cancellationPolicy.findMany({
    where: { OR: [{ lodgeId: effectiveLodgeId }, { lodgeId: null }] },
    orderBy: { daysBeforeStay: "desc" },
  });

  return resolvePolicyRowsForLodge(allRules, effectiveLodgeId).map(
    normalizeCancellationRule
  );
}
