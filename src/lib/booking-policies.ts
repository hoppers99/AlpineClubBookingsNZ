import type { PrismaClient } from "@prisma/client";

import { getDefaultLodgeId, resolvePolicyRowsForLodge } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { getStayNights } from "@/lib/pricing";
import {
  validateMinimumStayWithPolicies,
  type MinimumStayViolation,
} from "@/lib/policies/minimum-stay";
import {
  resolveAdultMemberHostingPolicy,
  type ResolvedAdultMemberHostingPolicy,
} from "@/lib/policies/adult-member-hosting";
import { aggregatePolicyExceptionViolations } from "@/lib/booking-policy-exceptions";

export {
  // test seam
  formatViolationMessage,
  formatViolationsDetail,
} from "@/lib/policies/minimum-stay";
export type { MinimumStayViolation } from "@/lib/policies/minimum-stay";

/**
 * The narrow client this evaluator needs. A `Prisma.TransactionClient` satisfies
 * it, which is the whole point of the parameter below.
 */
export type MinimumStayPolicyDb = Pick<
  PrismaClient,
  "minimumStayPolicy" | "lodge"
>;

/**
 * Validate booking dates against the minimum stay policies that apply at one
 * lodge. Policy resolution follows the club-wide-with-override rule: a lodge
 * with its own minimum-stay rows uses them instead of the club-wide set
 * (ADR-001 resolved question 3), so the whole active policy type is fetched
 * and resolved before date filtering. Callers without lodge context omit
 * lodgeId and get the club's default lodge.
 *
 * COMPOSITION RULE — `db`. Out-of-transaction callers omit it and read through
 * the module-level pool client, which is the common case (booking create, both
 * group-join stages, the advisory quote and policy-check surfaces). A caller
 * that is ALREADY INSIDE `prisma.$transaction` must pass its own `tx`: the two
 * modify services run this check while holding `pg_advisory_xact_lock(1)` and
 * the per-lodge capacity lock, and reaching for the module client there would
 * check out a SECOND pool connection underneath both locks — the pool-starvation
 * shape the ordering rule at the top of `member-guest-add-policy.ts` exists to
 * forbid. Passing `tx` also makes the read see the transaction's own snapshot
 * rather than a second, later one. See docs/CONCURRENCY_AND_LOCKING.md →
 * "Composition: minimum-stay policy set".
 */
export async function validateMinimumStay(
  checkIn: Date,
  checkOut: Date,
  lodgeId?: string | null,
  db: MinimumStayPolicyDb = prisma
): Promise<{ valid: boolean; violations: MinimumStayViolation[] }> {
  const nights = getStayNights(checkIn, checkOut);
  const nightCount = nights.length;

  if (nightCount === 0) {
    return { valid: true, violations: [] };
  }

  const firstNight = nights[0];
  const lastNight = nights[nights.length - 1];

  const effectiveLodgeId = lodgeId ?? (await getDefaultLodgeId(db));

  // Fetch the whole active policy type for this lodge plus club-wide rows
  // (the table is small), resolve the override set, then date-filter.
  const allPolicies = await db.minimumStayPolicy.findMany({
    where: {
      active: true,
      OR: [{ lodgeId: effectiveLodgeId }, { lodgeId: null }],
    },
  });

  const policies = resolvePolicyRowsForLodge(allPolicies, effectiveLodgeId).filter(
    (policy) => policy.startDate <= lastNight && policy.endDate >= firstNight
  );

  if (policies.length === 0) {
    return { valid: true, violations: [] };
  }

  return validateMinimumStayWithPolicies(
    checkIn,
    checkOut,
    policies,
    effectiveLodgeId,
  );
}

/** The narrow client the hosting-policy read needs (#2364). */
export type AdultMemberHostingPolicyDb = Pick<
  PrismaClient,
  "adultMemberHostingPolicy" | "lodge"
>;

/**
 * Resolve the adult-member hosting policy in force at one lodge (#2364).
 *
 * The table holds at most one club-wide row plus one row per lodge, so both
 * candidate rows are fetched in a single query and
 * `resolveAdultMemberHostingPolicy` decides between them. A lodge with no row,
 * or an INHERIT row, falls through to the club default; a club with no row at
 * all resolves DISABLED.
 *
 * COMPOSITION RULE — `db`. Identical to `validateMinimumStay` above and binding
 * for the same reason: **a caller already inside `prisma.$transaction` MUST
 * pass its own `tx`.** Reaching for the module-level client while the caller
 * holds `pg_advisory_xact_lock(1)` and a per-lodge capacity lock checks out a
 * SECOND pool connection underneath both, which is the pool-starvation shape
 * the ordering rule at the top of `member-guest-add-policy.ts` forbids. Passing
 * `tx` also makes the read see the transaction's own snapshot. Callers that are
 * genuinely outside a transaction keep the default.
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
    },
  });
  return resolveAdultMemberHostingPolicy(rows, effectiveLodgeId);
}

export { aggregatePolicyExceptionViolations };
