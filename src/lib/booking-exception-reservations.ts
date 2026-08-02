import { prisma } from "@/lib/prisma";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import type { PrismaTransactionClient } from "@/lib/db-transaction";
import {
  computeProposalReservation,
  type ExceptionProposalSnapshot,
  type NightReservation,
} from "@/lib/booking-exception-requests";

/**
 * Live provisional-reservation store for HELD booking-policy exception requests
 * (#2525), and the seam that makes those reservations COUNT as occupancy in the
 * canonical capacity calculation.
 *
 * The reservation MATH is the foundation's (`computeProposalReservation`,
 * booking-exception-requests.ts): a new-booking request reserves the FULL
 * proposal's per-night beds, a modification reserves only the INCREMENTAL beds
 * beyond the unchanged live booking. This module is the durable, transaction-
 * aware side of it:
 *
 *  - {@link reservePolicyExceptionCapacity} writes one `PolicyExceptionReservationNight`
 *    row per reserved night when a request is HELD (called by the request-hold
 *    path — #2524 — inside its held-capacity transaction);
 *  - {@link releasePolicyExceptionReservation} deletes every row for a request,
 *    atomically with the terminal transition or the successful approval that owns
 *    the same transaction;
 *  - {@link buildLodgePolicyExceptionReservationCounter} is the per-night counter
 *    the capacity engine adds to `occupiedBeds`, exactly as it adds the custodian
 *    counter.
 *
 * The invariant that makes the counter trivial and race-safe: **a reservation
 * night row exists IFF the request is currently holding that night's beds.**
 * There is no `active` flag to forget — release is a DELETE, and every writer
 * runs under the booking's per-lodge capacity lock, so a held request can never
 * overbook (its reservation was claimed under that same lock) and a released one
 * vanishes from the sum the instant its transaction commits.
 */

type ReservationDb = Pick<
  PrismaTransactionClient,
  "policyExceptionReservationNight"
>;

/**
 * Persist the provisional reservation a HELD request holds. Idempotent per
 * (request, night) via the unique index: a re-hold of the same proposal (e.g. a
 * retry after a transient failure inside the same held transaction) upserts
 * rather than duplicating. Writes nothing when the proposal reserves no beds (a
 * modification that only shrinks the party), which is the correct NO_HOLD-shaped
 * footprint.
 *
 * MUST be called on the caller's transaction client, under the booking's
 * per-lodge capacity lock — the same lock the capacity read takes — so the claim
 * and every concurrent occupancy read serialise.
 */
export async function reservePolicyExceptionCapacity(
  tx: ReservationDb,
  input: {
    changeRequestId: string;
    lodgeId: string;
    /** Precomputed footprint, or a snapshot to derive it from. */
    reservation?: NightReservation[];
    snapshot?: ExceptionProposalSnapshot;
  },
): Promise<NightReservation[]> {
  const reservation =
    input.reservation ??
    (input.snapshot ? computeProposalReservation(input.snapshot) : []);
  if (reservation.length === 0) return [];

  for (const { night, beds } of reservation) {
    if (beds <= 0) continue;
    const nightDate = parseDateOnly(night);
    // Upsert on the (changeRequestId, night) unique key so a re-run within the
    // held transaction is a no-op rather than a duplicate-key abort.
    await tx.policyExceptionReservationNight.upsert({
      where: {
        changeRequestId_night: { changeRequestId: input.changeRequestId, night: nightDate },
      },
      create: {
        changeRequestId: input.changeRequestId,
        lodgeId: input.lodgeId,
        night: nightDate,
        beds,
      },
      update: { beds, lodgeId: input.lodgeId },
    });
  }
  return reservation.filter((entry) => entry.beds > 0);
}

/**
 * Release a request's whole provisional reservation by deleting every night row.
 * Returns the number of rows deleted (0 when the request reserved nothing, e.g.
 * a NO_HOLD request). Atomic with the caller's transaction: the release is the
 * SAME `deleteMany` that a terminal transition or a successful approval issues
 * alongside the status write, so a lost status claim (which rolls the whole
 * transaction back) also rolls back the release.
 */
export async function releasePolicyExceptionReservation(
  tx: ReservationDb,
  changeRequestId: string,
): Promise<number> {
  const { count } = await tx.policyExceptionReservationNight.deleteMany({
    where: { changeRequestId },
  });
  return count;
}

/** A reserved night as read back for capacity counting. */
type ReservationNightRow = { night: Date; beds: number };

/**
 * The active reservation night rows overlapping a half-open date window at one
 * lodge. "Active" needs no predicate: a row exists only while its request holds
 * the night. `excludeChangeRequestId` drops a specific request's own rows — used
 * only by the approval, which releases its reservation before reconstructing the
 * booking, so this is defence in depth rather than the primary mechanism.
 */
export async function findActivePolicyExceptionReservationNights(input: {
  lodgeId: string;
  from: Date;
  toExclusive: Date;
  db?: ReservationDb;
  excludeChangeRequestId?: string;
}): Promise<ReservationNightRow[]> {
  const db = input.db ?? prisma;
  const from = parseDateOnly(formatDateOnly(input.from));
  const toExclusive = parseDateOnly(formatDateOnly(input.toExclusive));
  if (from >= toExclusive) return [];

  // Test-double tolerance, NOT a production fallback. The generated Prisma client
  // and every `$transaction` client always expose this delegate (it is generated
  // from the schema), so the capacity engines — which pass `tx ?? prisma` — can
  // never reach this branch at runtime; `policy-exception-reservation-delegate`
  // in the contract test pins that. A partial capacity-engine test double that
  // predates this feature simply reads "no reservations", exactly the occupancy
  // it computed before #2525, instead of throwing on a missing delegate.
  if (typeof db.policyExceptionReservationNight?.findMany !== "function") {
    return [];
  }

  const rows = await db.policyExceptionReservationNight.findMany({
    where: {
      lodgeId: input.lodgeId,
      night: { gte: from, lt: toExclusive },
      ...(input.excludeChangeRequestId
        ? { changeRequestId: { not: input.excludeChangeRequestId } }
        : {}),
    },
    select: { night: true, beds: true },
  });
  return rows;
}

/**
 * Per-night reserved bed COUNT for a set of reservation rows. A count, never a
 * flag: several held requests can reserve the same night, so their beds add.
 * Keys are `YYYY-MM-DD`; nights with no reservation are absent (callers use
 * `?? 0`).
 */
export function buildPolicyExceptionReservationNightIndex(
  rows: readonly ReservationNightRow[],
  nights: readonly Date[],
): Map<string, number> {
  const index = new Map<string, number>();
  if (rows.length === 0) return index;
  const byKey = new Map<string, number>();
  for (const row of rows) {
    const key = formatDateOnly(row.night);
    byKey.set(key, (byKey.get(key) ?? 0) + row.beds);
  }
  for (const night of nights) {
    const key = formatDateOnly(night);
    const count = byKey.get(key);
    if (count && count > 0) index.set(key, count);
  }
  return index;
}

/**
 * The held-reservation bed count on one night for a lodge, as a ready-to-use
 * `(night) => number` closure — the exact shape of
 * `buildLodgeCustodianNightCounter`. The capacity engines add it to
 * `occupiedBeds`, so a held policy-exception request is counted as occupancy and
 * a later admission (or the eventual approval of another request) can never
 * oversell the beds it holds.
 */
export async function buildLodgePolicyExceptionReservationCounter(input: {
  lodgeId: string;
  from: Date;
  toExclusive: Date;
  nights: readonly Date[];
  db?: ReservationDb;
  excludeChangeRequestId?: string;
}): Promise<(night: Date) => number> {
  const rows = await findActivePolicyExceptionReservationNights({
    lodgeId: input.lodgeId,
    from: input.from,
    toExclusive: input.toExclusive,
    db: input.db,
    excludeChangeRequestId: input.excludeChangeRequestId,
  });
  const index = buildPolicyExceptionReservationNightIndex(rows, input.nights);
  if (index.size === 0) return () => 0;
  return (night: Date) => index.get(formatDateOnly(night)) ?? 0;
}
