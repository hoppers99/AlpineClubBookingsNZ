import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { decodeRawRows } from "@/lib/raw-sql-rows";

export const ADULT_MEMBER_HOSTING_POLICY_SET_LOCK_KEY =
  "adult-member-hosting-policy-set";

/** Refusal an admin reads when their open editor lost a compare-and-swap. */
export const STALE_ADULT_MEMBER_HOSTING_POLICY_MESSAGE =
  "This hosting policy changed since you opened it, so nothing was saved. " +
  "The latest settings are shown below — check them and try again.";

const POLICY_SET_TRY_LOCK_ROW = z.object({ acquired: z.boolean() });

/**
 * Refusal when a lodge override is asked for on a lodge that is gone or
 * inactive. Stated rather than silently coerced to club-wide: a policy row
 * pointing at an inactive lodge would be invisible in the admin screen and
 * would still be resolved for any booking that lodge somehow accepted.
 */
export const INACTIVE_ADULT_MEMBER_HOSTING_LODGE_MESSAGE =
  "That lodge was not found or is not active, so a hosting policy cannot be " +
  "saved for it.";

/**
 * Serialise every writer of the tiny global hosting-policy set (one club row
 * plus at most one row per lodge).
 *
 * The migration's BEFORE STATEMENT trigger takes this exact key before any DML
 * reaches a row, so the order is advisory-then-tuple for every writer including
 * operator psql. Live admin writers and the configuration importer call this
 * helper BEFORE their first read, then re-enter the same transaction lock when
 * their DML fires.
 *
 * Composition (docs/CONCURRENCY_AND_LOCKING.md): the configuration importer
 * takes `config-transfer-import`, then `minimum-stay-policy-set`, then this key.
 * Live CRUD takes only this key. No writer ever takes them in another order, so
 * the three cannot form a cycle.
 */
export async function lockAdultMemberHostingPolicySet(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ADULT_MEMBER_HOSTING_POLICY_SET_LOCK_KEY}))`;
}

/**
 * Attempt the same transaction lock without waiting behind a policy writer or
 * member merge.
 *
 * Queue workers use this before any reconciliation effect. A false result lets
 * them end the short transaction and release the exact queue claim without
 * spending an attempt; request-path drains therefore never consume Prisma's
 * interactive-transaction timeout waiting behind the deliberately longer member
 * merge transaction.
 */
export async function tryLockAdultMemberHostingPolicySet(
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const returned = await tx.$queryRaw`
    SELECT pg_try_advisory_xact_lock(
      hashtext(${ADULT_MEMBER_HOSTING_POLICY_SET_LOCK_KEY})
    ) AS "acquired"
  `;
  const [result] = decodeRawRows(
    returned,
    POLICY_SET_TRY_LOCK_ROW,
    "adult-member hosting policy-set try-lock",
  );
  return result?.acquired === true;
}
