import type { Prisma } from "@prisma/client";

/**
 * The per-OWNER advisory lock that makes same-owner coverage deterministic
 * (#2576 §9).
 *
 * WHY A NEW LOCK FAMILY, when the review module's first draft argued none was
 * needed. That argument was that "every path that can confirm a booking and every
 * path that can remove exact-night attendance already takes the per-lodge capacity
 * lock", so two interacting writers always contend for the same key. It is false
 * in both directions, and measurably so:
 *
 *  - `booking-cancel.ts`'s four claim transactions take `pg_advisory_xact_lock(1)`
 *    and never `acquireLodgeCapacityLock`;
 *  - `booking-create.ts` and the guest-add route take `acquireLodgeCapacityLock`
 *    and never `pg_advisory_xact_lock(1)`.
 *
 * `pg_advisory_xact_lock(1)` and `pg_advisory_xact_lock(hashtextextended(lodgeId, 0))`
 * are DIFFERENT KEYS, these transactions run at READ COMMITTED, and the two
 * writers touch no row in common. So nothing serialised them, and §9's named race
 * was open: a cancel that removes the last qualifying adult could commit
 * concurrently with a create that had just read that adult as cover, and neither
 * side could see the other. Which booking won depended on commit order — exactly
 * the non-determinism §9 forbids.
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

function hasExecuteRaw(db: unknown): db is CoverageOwnerLockClient {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as { $executeRaw?: unknown }).$executeRaw === "function"
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

/** Exported for the concurrency test that pins the namespace and the SQL shape. */
export const HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS =
  HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE;
