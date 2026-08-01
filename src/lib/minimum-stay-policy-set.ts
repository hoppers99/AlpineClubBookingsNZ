import type { Prisma } from "@prisma/client";

export const MINIMUM_STAY_POLICY_SET_LOCK_KEY = "minimum-stay-policy-set";

/**
 * Serialise every writer of the small global minimum-stay policy set.
 *
 * The migration's BEFORE STATEMENT trigger takes this exact key before old-
 * colour DML reaches any row. New live/config writers call this helper before
 * reads or planning, then re-enter the transaction lock at DML time.
 */
export async function lockMinimumStayPolicySet(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${MINIMUM_STAY_POLICY_SET_LOCK_KEY}))`;
}
