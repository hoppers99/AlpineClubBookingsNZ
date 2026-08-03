import type { Prisma, PrismaClient } from "@prisma/client";

import type { HostingCoverageIncidentCause } from "@/lib/adult-member-hosting-coverage-incidents";

/**
 * The durable queue of BOUNDED same-owner re-evaluation work (#2576 §8).
 *
 * Storage mechanics only — enqueue, claim, complete. The policy that decides what
 * an item MEANS lives in `adult-member-hosting-coverage-drain.ts`, and the split
 * is what keeps the import graph acyclic: the hosting reconciler enqueues (so it
 * imports this), and the drain reconciles (so it imports the reconciler).
 *
 * WHY A QUEUE AT ALL. §8 lists the changes that cannot reasonably be blocked — a
 * membership lapsing, an administrative cancellation, a payment or lifecycle
 * failure, an automated transition, a data correction, an authorised officer
 * action — and requires that the re-evaluation they imply is "durably recorded in
 * the same transaction or equivalent reliable outbox mechanism", then run against
 * facts RE-READ AFTER COMMIT. Doing that work inline inside the authoritative
 * transaction would fail all three parts: it would read uncommitted facts, it
 * would extend a money/status transaction across several other bookings, and a
 * failure in it would roll back a change the club had already authorised.
 *
 * AT-LEAST-ONCE, NEVER AT-MOST-ONCE. An item is claimed, processed and completed;
 * a crash between claim and completion leaves it unprocessed and the general cron
 * sweep re-runs it. Every downstream effect is therefore built to be idempotent —
 * see `openOrUpdateHostingCoverageIncident` and
 * `claimHostingCoverageOwnerNotification`.
 */

export type HostingCoverageQueueDb = Pick<
  PrismaClient,
  "hostingCoverageReevaluation"
>;

export interface HostingCoverageReevaluationInput {
  /** The booking OWNER whose same-owner bookings need re-evaluating (§1, §10). */
  memberId: string;
  /** The affected lodge — exact, never a fan-out (§4, §10). */
  lodgeId: string;
  /** The affected NZ lodge-nights (YYYY-MM-DD). Sorted and de-duplicated here. */
  nights: readonly string[];
  cause: HostingCoverageIncidentCause;
  sourceBookingId?: string | null;
  actorMemberId?: string | null;
  reason?: string | null;
}

export interface HostingCoverageReevaluationItem {
  id: string;
  memberId: string;
  lodgeId: string;
  nights: string[];
  cause: HostingCoverageIncidentCause;
  sourceBookingId: string | null;
  actorMemberId: string | null;
  reason: string | null;
  attempts: number;
}

/**
 * Record one bounded unit of re-evaluation work, INSIDE the caller's transaction.
 *
 * In the transaction on purpose, and it is the whole reliability argument: the
 * authoritative change and the obligation to look at its consequences commit or
 * roll back together. There is no window in which a membership lapse is committed
 * and the club has no record that somebody has to check what it broke.
 *
 * Returns null when there is nothing to record — no nights, which happens for a
 * change that touched no lodge-night at all — rather than writing an item the
 * drain would have to recognise as empty.
 */
export async function enqueueHostingCoverageReevaluation(
  input: HostingCoverageReevaluationInput,
  db: HostingCoverageQueueDb,
): Promise<string | null> {
  const nights = [...new Set(input.nights)].sort();
  if (nights.length === 0) return null;
  const row = await db.hostingCoverageReevaluation.create({
    data: {
      memberId: input.memberId,
      lodgeId: input.lodgeId,
      nights: nights as unknown as Prisma.InputJsonValue,
      cause: input.cause,
      sourceBookingId: input.sourceBookingId ?? null,
      actorMemberId: input.actorMemberId ?? null,
      reason: input.reason ? input.reason.trim().slice(0, 500) : null,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Claim up to `limit` unprocessed items, oldest first.
 *
 * A GUARDED CLAIM per row rather than a `SELECT ... FOR UPDATE SKIP LOCKED`
 * batch, because the cost model does not need the latter: this queue carries a
 * handful of items after a membership-lapse sweep, not thousands, and a guarded
 * `updateMany` on `processedAt: null` is the pattern the rest of this repository
 * uses for exactly-one-claimant. Two concurrent drains simply split the work.
 *
 * `attempts` is incremented AT CLAIM TIME, not on failure. A poison item that
 * throws every time therefore still counts up, and `maxAttempts` retires it —
 * whereas incrementing on failure loses the count whenever the process dies mid
 * item, which is the failure mode most likely to be repeated.
 */
export async function claimHostingCoverageReevaluations(
  options: { limit?: number; maxAttempts?: number } = {},
  db: HostingCoverageQueueDb,
): Promise<HostingCoverageReevaluationItem[]> {
  const limit = options.limit ?? 25;
  const maxAttempts = options.maxAttempts ?? 5;
  const candidates = await db.hostingCoverageReevaluation.findMany({
    where: { processedAt: null, attempts: { lt: maxAttempts } },
    orderBy: { enqueuedAt: "asc" },
    take: limit,
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      nights: true,
      cause: true,
      sourceBookingId: true,
      actorMemberId: true,
      reason: true,
      attempts: true,
    },
  });

  const claimed: HostingCoverageReevaluationItem[] = [];
  for (const candidate of candidates) {
    const claim = await db.hostingCoverageReevaluation.updateMany({
      where: { id: candidate.id, processedAt: null, attempts: candidate.attempts },
      data: { attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;
    claimed.push({
      ...candidate,
      nights: parseNights(candidate.nights),
      attempts: candidate.attempts + 1,
    });
  }
  return claimed;
}

/** Mark an item done. Idempotent: a second call matches nothing. */
export async function completeHostingCoverageReevaluation(
  id: string,
  db: HostingCoverageQueueDb,
): Promise<void> {
  await db.hostingCoverageReevaluation.updateMany({
    where: { id, processedAt: null },
    data: { processedAt: new Date(), lastError: null },
  });
}

/** Record why an item failed, leaving it unprocessed for the next sweep. */
export async function failHostingCoverageReevaluation(
  id: string,
  message: string,
  db: HostingCoverageQueueDb,
): Promise<void> {
  await db.hostingCoverageReevaluation.updateMany({
    where: { id, processedAt: null },
    data: { lastError: message.slice(0, 1000) },
  });
}

/**
 * Read the stored night list back without trusting it.
 *
 * The column is JSON, so a hand-edited or partially-written value is possible. A
 * value that is not an array of date-only strings yields NO nights, which makes
 * the item a no-op rather than letting a malformed row widen a bounded
 * re-evaluation into something unbounded.
 */
function parseNights(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const nights = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry),
  );
  return [...new Set(nights)].sort();
}
