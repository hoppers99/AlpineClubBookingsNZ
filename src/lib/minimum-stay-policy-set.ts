import type { Prisma } from "@prisma/client";

const POLICY_SET_LOCK_PREFIX = "minimum-stay-policy-set:";
const CLUB_WIDE_SCOPE = "club-wide";

/** Stable scope token shared by live CRUD and configuration import. */
export function minimumStayPolicyScopeKey(lodgeId: string | null): string {
  return lodgeId === null ? CLUB_WIDE_SCOPE : `lodge:${lodgeId}`;
}

/**
 * Serialise every writer of one minimum-stay policy partition.
 * Read-only evaluation deliberately takes no lock.
 */
export async function lockMinimumStayPolicyScope(
  tx: Prisma.TransactionClient,
  lodgeId: string | null,
): Promise<void> {
  const key = `${POLICY_SET_LOCK_PREFIX}${minimumStayPolicyScopeKey(lodgeId)}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** Config import locks each touched partition in a fixed order after its own lock. */
export async function lockMinimumStayPolicyScopes(
  tx: Prisma.TransactionClient,
  lodgeIds: Array<string | null>,
): Promise<void> {
  const unique = new Map(
    lodgeIds.map((lodgeId) => [minimumStayPolicyScopeKey(lodgeId), lodgeId]),
  );
  for (const [, lodgeId] of [...unique.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    await lockMinimumStayPolicyScope(tx, lodgeId);
  }
}
