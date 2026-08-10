import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { decodeRawRows } from "@/lib/raw-sql-rows";

/**
 * The per-OWNER advisory lock that makes same-owner coverage deterministic
 * (#2576 §9).
 *
 * WHY A NEW LOCK FAMILY, when the review module's first draft argued none was
 * needed. That argument was that "every path that can confirm a booking and every
 * path that can remove exact-night attendance already takes the per-lodge capacity
 * lock", so two interacting writers always contend for the same key. When #2576
 * introduced this key, it was false in both directions, and measurably so:
 *
 *  - `booking-cancel.ts`'s four claim transactions took `pg_advisory_xact_lock(1)`
 *    and not `acquireLodgeCapacityLock`;
 *  - `booking-create.ts` and the guest-add route took `acquireLodgeCapacityLock`
 *    and not `pg_advisory_xact_lock(1)`.
 *
 * Those keys were different at READ COMMITTED over disjoint rows, so the named
 * create-versus-cancel race was open. #2593 later made the allocation-participating
 * confirmed-create and cancellation paths compose global → lodge. That later
 * overlap does not retire the owner key: coverage is a cross-booking, per-owner
 * invariant, and participant/member/queue producers do not all share those tiers.
 * The coverage-owner key remains the authoritative common serialisation point and
 * stays last.
 *
 * THE INVARIANT IS PER-OWNER, SO THE KEY IS THE OWNER. Same-owner coverage is a
 * property of one `Booking.memberId` at one lodge (§1, §4), and the repository
 * already has this precedent for the same reason: `lockBookingMemberNights`
 * (`booking-member-night-conflicts.ts`) exists because per-lodge locks cannot
 * serialise a per-member invariant. This is the same shape with its own namespace,
 * so it never contends with the per-lodge, global, member-night or credit-ledger
 * locks.
 *
 * ACQUISITION ORDER — ALWAYS LAST. Callers take this AFTER any
 * `pg_advisory_xact_lock(1)`, after `acquireLodgeCapacityLock`, after any
 * roster-date locks, and after the applicable member-night and member-credit
 * locks. That gives the full tree one consistent order (global → lodge →
 * roster-date → member-night → member-credit → coverage-owner) that cannot
 * deadlock; paths that do not use a tier simply omit it. Where several owners
 * are involved the keys are taken in sorted order, the same discipline the
 * member-night lock uses.
 *
 * RE-ENTRANT, SO CHEAP TO BE THOROUGH. Postgres advisory locks are per-session
 * and re-entrant, so acquiring the same owner key twice inside one transaction is
 * a no-op. That is what lets the evaluator take it before it reads same-owner
 * sources AND the settle step take it before it reads dependents, without either
 * having to know whether the other already did.
 *
 * TAKEN ONLY WHERE THE SCOPE IS ON. Every caller resolves the lodge policy first
 * and skips the lock unless `SAME_BOOKING_OWNER` is enabled, so a club that is not
 * on this scope pays nothing and no unrelated write is serialised per member.
 */

const HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE = "hosting-coverage-owner";

/**
 * The subset of a client this module needs. `prisma` and any
 * `Prisma.TransactionClient` both satisfy it; the narrow delegate-only picks the
 * hosting modules pass around do not, which is what the runtime guard below is
 * for.
 */
type CoverageOwnerLockClient = {
  $executeRaw: Prisma.TransactionClient["$executeRaw"];
};

type CoverageOwnerTryLockClient = {
  $queryRaw: Prisma.TransactionClient["$queryRaw"];
};

const COVERAGE_OWNER_TRY_LOCK_ROW = z.object({ locked: z.boolean() });

function hasExecuteRaw(db: unknown): db is CoverageOwnerLockClient {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as { $executeRaw?: unknown }).$executeRaw === "function"
  );
}

function hasQueryRaw(db: unknown): db is CoverageOwnerTryLockClient {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as { $queryRaw?: unknown }).$queryRaw === "function"
  );
}

/**
 * Serialise every reader and writer of one owner's same-owner coverage.
 *
 * SILENT NO-OP WITHOUT `$executeRaw`, deliberately, and this is the one judgement
 * in the module. The hosting modules accept a narrow delegate-only client so they
 * can be driven by an in-memory store in tests, and `lockBookingMemberNights`
 * takes the same approach for the same reason. Throwing here would make the
 * policy untestable without a live Postgres; skipping loses only the lock, and
 * every caller still has the status-guarded claims and the idempotent
 * reconciliation that were protecting it before. In production the client is
 * always a real `Prisma.TransactionClient`, so the lock is always taken.
 */
export async function lockHostingCoverageOwners(
  db: unknown,
  memberIds: readonly (string | null | undefined)[],
): Promise<void> {
  if (!hasExecuteRaw(db)) return;
  const keys = Array.from(
    new Set(memberIds.filter((id): id is string => Boolean(id))),
  ).sort();
  for (const memberId of keys) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE}), hashtext(${memberId}))`;
  }
}

/** The single-owner case, which is every caller but the merge path. */
export async function lockHostingCoverageOwner(
  db: unknown,
  memberId: string | null | undefined,
): Promise<void> {
  await lockHostingCoverageOwners(db, [memberId]);
}

/**
 * Fail-fast counterpart used by #2597's per-seam participant protocol.
 *
 * A bulk transaction may call one producer several times. Member KEY SHARE
 * locks are mutually compatible, so their NOWAIT clause cannot by itself stop
 * two transactions that already hold different coverage-owner keys from
 * waiting on one another's later key. Trying each sorted owner key closes that
 * remaining hold-and-wait edge: false makes the caller roll its WHOLE outer
 * transaction back. Any later blocking acquisition of the same key is
 * re-entrant on the same PostgreSQL session.
 */
export async function tryLockHostingCoverageOwners(
  db: unknown,
  memberIds: readonly (string | null | undefined)[],
): Promise<boolean> {
  if (!hasQueryRaw(db)) return true;
  const keys = Array.from(
    new Set(memberIds.filter((id): id is string => Boolean(id))),
  ).sort();
  for (const memberId of keys) {
    const returned = await db.$queryRaw`
      SELECT pg_try_advisory_xact_lock(
        hashtext(${HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE}),
        hashtext(${memberId})
      ) AS "locked"
    `;
    const rows = decodeRawRows(
      returned,
      COVERAGE_OWNER_TRY_LOCK_ROW,
      "hosting coverage owner try-lock",
    );
    if (rows[0]?.locked !== true) return false;
  }
  return true;
}

export async function tryLockHostingCoverageOwner(
  db: unknown,
  memberId: string | null | undefined,
): Promise<boolean> {
  return tryLockHostingCoverageOwners(db, [memberId]);
}

/** Exported for the concurrency test that pins the namespace and the SQL shape. */
export const HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS =
  HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE;
