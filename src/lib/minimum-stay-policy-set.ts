import type { Prisma } from "@prisma/client";

export const MINIMUM_STAY_POLICY_SET_LOCK_KEY = "minimum-stay-policy-set";

/**
 * Refusal an admin reads when a create, rename or reactivate would leave two
 * ACTIVE minimum-stay policies sharing one (scope, name).
 *
 * Configuration transfer identifies a policy by that pair and the table
 * deliberately carries no unique constraint on it, so a duplicate used to be
 * freely creatable and then aborted the whole configuration export. Both admin
 * writers refuse it with this one sentence. Inactive rows are exempt: they are
 * history, and forcing a rename before a name can be reused would be the worse
 * trade — a deactivate-then-recreate pair still collides for the exporter,
 * whose own error says exactly that and how to fix it.
 */
export const DUPLICATE_MINIMUM_STAY_POLICY_NAME_MESSAGE =
  "Another active minimum stay policy in this scope already uses that name. " +
  "Configuration transfer identifies a policy by its scope and name, so give " +
  "this one a different name.";

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
