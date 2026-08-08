import { BookingStatus, Prisma, type BedAllocation } from "@prisma/client";

import {
  buildFirstFitBedAllocationPlan,
  type BedAllocationBooking,
  type BedAllocationDisplacement,
  type BedAllocationRoom,
} from "@/lib/bed-allocation";
import { createAuditLog } from "@/lib/audit";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import {
  custodianHeldBedNightKeys,
  custodianOccupiedBedNightsForPlanner,
  findCustodianBedHolds,
} from "@/lib/custodian-occupancy";
import { mayShareDoubleBedWith } from "@/lib/double-bed-sharing";
import {
  buildWholeLodgeHeldNightPredicate,
  findBlockingWholeLodgeHolds,
  wholeLodgeHoldOccupiedBedNightsForPlanner,
} from "@/lib/exclusive-hold-occupancy";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import logger from "@/lib/logger";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { prisma } from "@/lib/prisma";
import { resolveEffectiveBedAllocationSettings } from "@/lib/bed-allocation-settings";

type BedAllocationLifecycleDb = Prisma.TransactionClient | typeof prisma;

// Statuses whose bookings may own a per-night BedAllocation row.
//
// This is a deliberate superset of CAPACITY_HOLDING_BOOKING_STATUSES (in
// booking-status.ts). Every capacity-holding status appears here, plus the
// provisional/offered "pre-assignment" statuses (PENDING, PAYMENT_PENDING,
// WAITLIST_OFFERED) that may be assigned a bed before they commit lodge
// capacity. The two sets are kept distinct on purpose; the ownership boundary
// is locked down by booking-status-bed-allocation-ownership.test.ts (issue
// #813), so any change here must keep capacity-holding ⊆ bed-allocatable.
export const BED_ALLOCATABLE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
  BookingStatus.AWAITING_REVIEW,
  BookingStatus.WAITLIST_OFFERED,
] as const;

/**
 * Cap on how many pruned `BedAllocation` rows an audit entry records verbatim
 * (#2285 review). Setting an exclusive whole-lodge hold destroys every per-bed
 * row the booking owns — including manually placed and admin-approved ones —
 * and a deleted row otherwise leaves no trace of WHAT it was, so both prune
 * sites (the admin toggle route and the school-approval conversion) list the
 * removed rows in their audit metadata.
 *
 * The value is pinned to the audit layer's own `MAX_METADATA_ARRAY_ITEMS`
 * (`src/lib/audit.ts`): the sanitiser silently truncates any metadata array
 * past 50 entries and replaces the WHOLE metadata blob with a short preview
 * once the serialised JSON passes its size budget — so reading more rows than
 * this would not preserve them, and could cost the entries that DO fit. A
 * whole-lodge group is guests × nights and will routinely exceed it, so the
 * exact figure is always recorded alongside as `deletedCount` and a
 * `removedAllocationsTruncated` flag says the list is partial.
 */
export const MAX_AUDITED_PRUNED_ALLOCATIONS = 50;

interface BedAllocationLifecycleRange {
  checkIn: Date;
  checkOut: Date;
}

export interface BedAllocationLifecycleResult {
  enabled: boolean;
  deletedCount: number;
  createdCount: number;
  // Second occupants promoted to primary because the prune removed a shared
  // double's primary from another booking (#1750). Assertable via the reconcile
  // return, not only via the update spy.
  promotedCount: number;
}

export interface OrphanedBedNight {
  bedId: string;
  stayDate: Date;
}

/**
 * Promote the surviving second occupant to primary on each bed-night that just
 * lost its primary — a board delete (#1743), a board move of the primary to
 * another bed, or a cross-booking lifecycle prune (#1750). Without this, a lone
 * `isSecondOccupant=true` row is a safe dead-end (visible, no constraint
 * violation) but the orphan guard in `resolveSecondOccupant` blocks every new
 * placement on that bed-night until it is manually removed.
 *
 * The gate is `isSecondOccupant` only, NEVER the denormalized `bedType` of the
 * removed primary OR the survivor: AUTO-created rows carry the default SINGLE
 * even on a real DOUBLE (#1749), so trusting that type would skip the promotion
 * the partner needs — the exact failure #1749's "never trust denormalized
 * bedType" fix targeted, here in the REPAIR mechanism where declining silently
 * dead-ends the bed-night behind the orphan guard forever. A second-occupant row
 * can only exist on a genuine shared DOUBLE (`resolveSecondOccupant` checks the
 * live bed + the partial index enforces it), so the `isSecondOccupant=true`
 * lookup finds nothing on any other bed and nothing is written. The JS re-check
 * of `partner.isSecondOccupant` (the WHERE clause is the real gate) keeps a test
 * mock — whose `findFirst` ignores the WHERE — from fabricating a promotion.
 *
 * Runs on the supplied client so the caller's transaction wraps delete/move +
 * flip atomically. The removed primary must already be gone, so the flip to
 * `isSecondOccupant=false` cannot collide with
 * `@@unique([bedId, stayDate, isSecondOccupant])`. Returns the promoted rows so
 * the caller can audit them — a promoted partner may belong to a DIFFERENT
 * booking than the row that was removed.
 */
export async function promoteOrphanedSecondOccupants(
  db: BedAllocationLifecycleDb,
  bedNights: OrphanedBedNight[],
): Promise<BedAllocation[]> {
  const promoted: BedAllocation[] = [];
  const seen = new Set<string>();
  for (const { bedId, stayDate } of bedNights) {
    // Dedup: the same (bedId, stayDate) must never be flipped twice.
    const key = `${bedId}:${formatDateOnly(stayDate)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const partner = await db.bedAllocation.findFirst({
      where: { bedId, stayDate, isSecondOccupant: true },
    });
    if (partner && partner.isSecondOccupant) {
      const updated = await db.bedAllocation.update({
        where: { id: partner.id },
        data: { isSecondOccupant: false },
      });
      promoted.push(updated);
    }
  }
  return promoted;
}

/**
 * Batched form of {@link promoteOrphanedSecondOccupants}: ONE `findMany` over
 * every vacated bed-night plus ONE `updateMany`, instead of a `findFirst` +
 * `update` round-trip per night (#2285 review). The per-night helper above is
 * kept for the single-night board callers (a board delete/move vacates exactly
 * one bed-night); every whole-booking / whole-stay sweep uses this one, because
 * those run under the per-lodge capacity lock (the exclusive-hold toggle) or
 * under the global + per-lodge locks (the school approval), where guests ×
 * nights sequential round-trips hold the lock far longer than they need to.
 *
 * Semantics are identical to the per-night helper and deliberately re-stated
 * here rather than shared: the WHERE gate is `isSecondOccupant` only (never the
 * denormalized `bedType`, #1749), the JS re-check of `isSecondOccupant` keeps a
 * test mock whose `findMany` ignores the WHERE from fabricating a promotion, the
 * bed-night key set is deduped so no bed-night is flipped twice, and the
 * `updateMany` re-asserts `isSecondOccupant: true` so a row concurrently removed
 * or already promoted is an idempotent no-op rather than a crash. Returns the
 * promoted rows (with the flag flipped) so the caller can audit them — a
 * promoted partner may belong to a DIFFERENT booking than the row that was
 * removed. Runs on the supplied client, never opening a nested transaction.
 */
export async function promoteOrphanedSecondOccupantsBatch(
  db: BedAllocationLifecycleDb,
  bedNights: OrphanedBedNight[],
): Promise<BedAllocation[]> {
  const wanted = new Map<string, OrphanedBedNight>();
  for (const { bedId, stayDate } of bedNights) {
    const key = `${bedId}:${formatDateOnly(stayDate)}`;
    if (!wanted.has(key)) wanted.set(key, { bedId, stayDate });
  }
  if (wanted.size === 0) return [];

  const partners = await db.bedAllocation.findMany({
    where: {
      isSecondOccupant: true,
      OR: [...wanted.values()].map((night) => ({
        bedId: night.bedId,
        stayDate: night.stayDate,
      })),
    },
  });

  const byBedNight = new Map<string, BedAllocation>();
  for (const partner of partners) {
    if (!partner.isSecondOccupant) continue;
    const key = `${partner.bedId}:${formatDateOnly(partner.stayDate)}`;
    if (!wanted.has(key) || byBedNight.has(key)) continue;
    byBedNight.set(key, partner);
  }

  const targets = [...byBedNight.values()];
  if (targets.length === 0) return [];

  await db.bedAllocation.updateMany({
    where: { id: { in: targets.map((row) => row.id) }, isSecondOccupant: true },
    data: { isSecondOccupant: false },
  });

  return targets.map((row) => ({ ...row, isSecondOccupant: false }));
}

async function recordPartnerPromotionAudit(
  db: BedAllocationLifecycleDb,
  promoted: BedAllocation,
): Promise<void> {
  // Best-effort, mirroring recordBedDisplacementAudit: an audit-write failure
  // must never roll back a committed promotion. There is no acting member on the
  // lifecycle path (the promotion is a system-driven consequence of a prune), so
  // this is a "lodge" system event rather than an "admin" action, and it is
  // recorded against the PROMOTED partner's own booking — which may differ from
  // the booking whose prune triggered it.
  try {
    await createAuditLog(
      {
        action: "BED_ALLOCATION_PARTNER_PROMOTED",
        category: "lodge",
        entityType: "BedAllocation",
        entityId: promoted.id,
        targetId: promoted.bookingId,
        outcome: "success",
        summary:
          "Second occupant auto-promoted to primary after the shared double's primary was pruned by a lifecycle change on another booking",
        metadata: {
          issue: 1750,
          allocationId: promoted.id,
          bedId: promoted.bedId,
          stayDate: formatDateOnly(promoted.stayDate),
        },
      },
      db,
    );
  } catch (err) {
    logger.error(
      { err, promoted },
      "Failed to record partner promotion audit",
    );
  }
}

/**
 * Delete allocations matching `where`, promoting any second occupant left
 * orphaned when the sweep removes a shared double's primary (#1750). The
 * affected bed-nights are captured BEFORE the delete (a `deleteMany` returns
 * only a count) and the survivors are flipped AFTER, on the SAME client the
 * sweep runs on — reconcile often already runs inside a caller's transaction, so
 * this deliberately never opens a nested one. Delete-first/flip-after keeps the
 * flip from colliding with `@@unique([bedId, stayDate, isSecondOccupant])`.
 */
async function sweepAllocationsWithPromotion(
  db: BedAllocationLifecycleDb,
  where: Prisma.BedAllocationWhereInput,
): Promise<{ deletedCount: number; promotedCount: number }> {
  // Bed-nights whose PRIMARY this sweep will delete. Only a deleted primary can
  // orphan a partner, so the capture is scoped to isSecondOccupant=false — but
  // NOT to bedType (#1749: an AUTO primary on a real DOUBLE carries the stale
  // SINGLE default; filtering it out would strand its partner).
  const doomedPrimaries = await db.bedAllocation.findMany({
    where: { ...where, isSecondOccupant: false },
    select: { bedId: true, stayDate: true },
  });

  const deleted = await db.bedAllocation.deleteMany({ where });

  if (doomedPrimaries.length === 0) {
    return { deletedCount: deleted.count, promotedCount: 0 };
  }

  // Batched (#2285 review): a whole-booking / whole-stay sweep vacates guests ×
  // nights bed-nights, and this sweep runs under the caller's capacity lock on
  // the hold-toggle and school-approval paths — one findMany + one updateMany
  // instead of two round-trips per vacated night.
  const promoted = await promoteOrphanedSecondOccupantsBatch(db, doomedPrimaries);
  for (const row of promoted) {
    await recordPartnerPromotionAudit(db, row);
  }
  return { deletedCount: deleted.count, promotedCount: promoted.length };
}

interface ReconcileBedAllocationsForBookingInput {
  bookingId: string;
  // Retained for API stability and as pruning context for the ~45 call sites
  // that pass a booking's pre-change dates. Since #1686 the auto-placement
  // range is the booking's CURRENT range only; stale rows outside it are
  // already handled by pruneAllocationsForBooking, so previousRange no longer
  // widens the planner scan.
  previousRange?: BedAllocationLifecycleRange | null;
}

interface AutoAllocateMissingBedNightsInput {
  db: BedAllocationLifecycleDb;
  // The reconciled booking whose guests are the ONLY ones auto-placed (#1686).
  // The room/occupancy loads below stay lodge-wide across the range so the
  // planner still sees every occupied bed-night (and can displace provisional
  // occupants for a held booking, #1387/#1677), but no OTHER booking's missing
  // guest-nights are opportunistically drafted into the freed/idle beds.
  bookingId: string;
  range: BedAllocationLifecycleRange;
  // Lodge of the booking being reconciled. Auto-fill must never place a
  // guest into another lodge's bed (lodge-scoping contract); null (booking
  // missing/pre-backfill) keeps the club-wide behaviour, which is exact
  // while one lodge exists.
  lodgeId?: string | null;
}

type BookingForBedAllocation = Awaited<
  ReturnType<typeof loadBookingForBedAllocation>
>;

function isAllocatableBookingStatus(status: string): boolean {
  return (BED_ALLOCATABLE_BOOKING_STATUSES as readonly string[]).includes(status);
}

/**
 * Write-time re-check of the bookings a planner is about to write rows for
 * (#2285 review).
 *
 * Every bed-allocation planner reads state, plans in memory, then writes, and
 * the read is not serialised against the hold toggle: `runAutoBedAllocation`
 * reads the dashboard OUTSIDE its locked write transaction (#2286 gave it one;
 * before that it had no lock at all), and
 * `reconcileBedAllocationsForBooking` is called post-commit and unlocked from
 * several lifecycle callers. A hold SET (or a cancel, or a soft delete) that
 * commits between the read and the write would otherwise be silently undone:
 * the prune frees the unique keys, so `skipDuplicates` cannot save us and the
 * planner happily re-inserts rows for a booking that must own none.
 *
 * So immediately before the write, re-read the live held/status/deleted state of
 * every booking in the payload in ONE query and drop the rows of any booking
 * that is no longer allocatable — whole-lodge-held (ADR-001), soft-deleted, or
 * moved to a non-allocatable status by a concurrent cancel, which reaches here
 * through the hold's clear-direction re-plan and serialises on the DISJOINT
 * club-wide key. A booking id the re-read does not return at all is dropped: it
 * no longer exists, so its rows would fail the FK anyway.
 *
 * Structural row type, so both writers can pass their own payload shape.
 */
export async function dropAllocationRowsForUnallocatableBookings<
  TRow extends { bookingId: string },
>(
  db: BedAllocationLifecycleDb,
  rows: TRow[],
): Promise<{ rows: TRow[]; droppedBookingIds: string[] }> {
  if (rows.length === 0) return { rows, droppedBookingIds: [] };

  const bookingIds = [...new Set(rows.map((row) => row.bookingId))];
  const live = await db.booking.findMany({
    where: { id: { in: bookingIds } },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      wholeLodgeHold: true,
    },
  });

  const allocatable = new Set(
    live
      .filter(
        (booking) =>
          !booking.deletedAt &&
          !booking.wholeLodgeHold &&
          isAllocatableBookingStatus(booking.status),
      )
      .map((booking) => booking.id),
  );

  const droppedBookingIds = bookingIds.filter((id) => !allocatable.has(id));
  if (droppedBookingIds.length === 0) {
    return { rows, droppedBookingIds };
  }
  return {
    rows: rows.filter((row) => allocatable.has(row.bookingId)),
    droppedBookingIds,
  };
}

/**
 * Which lodges do these rooms belong to, sorted (#2286 review M1).
 *
 * Used to decide the advisory-lock keys for an UNSCOPED reconcile, which can
 * legitimately span several lodges. Sorted so every multi-lodge acquirer takes
 * the keys in the same order and cannot deadlock against a per-lodge writer.
 */
async function resolveLodgeIdsForRooms(
  db: BedAllocationLifecycleDb,
  roomIds: string[],
): Promise<string[]> {
  const distinct = [...new Set(roomIds)];
  if (distinct.length === 0) return [];
  const rooms = await db.lodgeRoom.findMany({
    where: { id: { in: distinct } },
    select: { lodgeId: true },
  });
  // `LodgeRoom.lodgeId` is NOT NULL in the schema, but a missing value must
  // never become a lock key ("" hashes to a real key that protects nothing).
  return [
    ...new Set(rooms.map((room) => room.lodgeId).filter((id): id is string => Boolean(id))),
  ].sort();
}

/**
 * Drop any payload row that would land on a custodian-held bed-night (#2286
 * review M1).
 *
 * Called immediately before a `createMany`, on the SAME client that performs
 * it. The planner is already fed the holds as never-evictable unknown
 * occupants, but that read is not the write: no unique index and no database
 * constraint stands behind the custodian exclusion, so a hold that commits
 * between the plan and the write would otherwise be silently written over. This
 * is the write-time half, and it is what makes the DOMAIN_INVARIANTS claim
 * ("every placing write re-checks the live holds immediately before writing")
 * true for the lifecycle planner rather than only for `runAutoBedAllocation`.
 */
async function dropRowsOnCustodianHeldBedNights<
  TRow extends { bedId: string; stayDate: Date },
>(
  db: BedAllocationLifecycleDb,
  rows: TRow[],
  context: { lodgeId?: string; bookingId: string },
): Promise<TRow[]> {
  if (rows.length === 0) return rows;

  const stayDates = rows.map((row) => row.stayDate);
  const from = stayDates.reduce((a, b) => (a < b ? a : b));
  const latest = stayDates.reduce((a, b) => (a > b ? a : b));
  const toExclusive = addDaysDateOnly(latest, 1);

  const heldKeys = custodianHeldBedNightKeys(
    await findCustodianBedHolds({
      lodgeId: context.lodgeId,
      from,
      toExclusive,
      db,
    }),
    eachDateOnlyInRange(from, toExclusive),
  );
  if (heldKeys.size === 0) return rows;

  const writable = rows.filter(
    (row) => !heldKeys.has(`${row.bedId}:${formatDateOnly(row.stayDate)}`),
  );
  if (writable.length < rows.length) {
    logger.info(
      {
        bookingId: context.bookingId,
        lodgeId: context.lodgeId ?? null,
        droppedCount: rows.length - writable.length,
      },
      "Bed allocation write-time re-check dropped rows targeting custodian-held bed-nights",
    );
  }
  return writable;
}

/**
 * Drop any payload row that would land on a whole-lodge-held night (#2317).
 *
 * The exact mirror of the custodian re-filter above, and it exists for the same
 * reason: the planner IS fed the hold as blocking unattributed occupancy, but
 * that read happened several queries earlier and this reconcile is routinely
 * called post-commit and unlocked. Nothing in the database stops a row landing
 * on a held bed-night, so a hold that commits between the plan and the write
 * would otherwise be written straight over.
 *
 * `dropAllocationRowsForUnallocatableBookings` does NOT cover this: it asks
 * whether the booking we are placing became unallocatable, and a hold set on a
 * DIFFERENT booking leaves ours perfectly allocatable while taking every bed it
 * was about to occupy.
 *
 * A row whose room has no resolved lodge is treated as held by ANY hold
 * (null-tolerant matching), which is the conservative direction.
 */
async function dropRowsOnWholeLodgeHeldNights<
  TRow extends { roomId: string; stayDate: Date },
>(
  db: BedAllocationLifecycleDb,
  rows: TRow[],
  context: {
    lodgeId?: string;
    bookingId: string;
    roomLodgeIdById: ReadonlyMap<string, string>;
  },
): Promise<TRow[]> {
  if (rows.length === 0) return rows;

  const stayDates = rows.map((row) => row.stayDate);
  const from = stayDates.reduce((a, b) => (a < b ? a : b));
  const latest = stayDates.reduce((a, b) => (a > b ? a : b));
  const toExclusive = addDaysDateOnly(latest, 1);

  const isWholeLodgeHeld = buildWholeLodgeHeldNightPredicate(
    await findBlockingWholeLodgeHolds({
      lodgeId: context.lodgeId,
      from,
      toExclusive,
      db,
    }),
  );

  const writable = rows.filter(
    (row) =>
      !isWholeLodgeHeld(
        context.lodgeId ?? context.roomLodgeIdById.get(row.roomId) ?? null,
        formatDateOnly(row.stayDate),
      ),
  );
  if (writable.length < rows.length) {
    logger.info(
      {
        bookingId: context.bookingId,
        lodgeId: context.lodgeId ?? null,
        droppedCount: rows.length - writable.length,
      },
      "Bed allocation write-time re-check dropped rows targeting whole-lodge-held nights",
    );
  }
  return writable;
}

function normalizeRange(
  range?: BedAllocationLifecycleRange | null,
): BedAllocationLifecycleRange | null {
  if (!range || range.checkOut <= range.checkIn) return null;
  return range;
}

async function loadBookingForBedAllocation(
  db: BedAllocationLifecycleDb,
  bookingId: string,
) {
  return db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      // ADR-001 bed-allocation short-circuit (#2285): a whole-lodge-held
      // booking implicitly occupies every bed, so the lifecycle must neither
      // create nor keep per-bed rows for it. Keyed on the flag, NOT the
      // status — a held booking sits in an ordinary allocatable status.
      wholeLodgeHold: true,
      guests: {
        // Owner decision D-12 (#2307): bed allocation places the people who
        // will actually sleep at the lodge, so a member guest whose consent is
        // still PENDING (or was DECLINED / EXPIRED and survived its removal
        // attempt) is not in this set. They still hold a bed against capacity
        // under D-4 — that is capacity.ts's job and is deliberately untouched.
        //
        // This list is also what `pruneAllocationsForBooking` diffs against, so
        // excluding a row here does not merely skip placing them: any
        // BedAllocation an earlier release wrote for them is swept on the next
        // reconcile. That is the intended coherence, not a side effect — a
        // guest who is not operationally present must not be occupying a bed on
        // the board either.
        where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE },
        select: {
          id: true,
          bookingId: true,
          ageTier: true,
          stayStart: true,
          stayEnd: true,
          // Explicit night set (issue #713): allocations are pruned/created per
          // included night, so non-contiguous stays only hold beds on the
          // nights the guest actually stays.
          nights: { select: { stayDate: true } },
          member: {
            select: {
              familyGroupMemberships: {
                select: { familyGroupId: true },
              },
            },
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
}

/**
 * The dates a guest actually stays within a date range (issue #713). Uses the
 * explicit night set when present; otherwise the contiguous stayStart/stayEnd
 * range clamped to the range — the pre-#713 behaviour.
 */
function getGuestNightDatesInRange(
  guest: { stayStart: Date; stayEnd: Date; nights?: { stayDate: Date }[] },
  range: BedAllocationLifecycleRange
): Date[] {
  const rangeStartKey = formatDateOnly(range.checkIn);
  const rangeEndKey = formatDateOnly(range.checkOut); // exclusive
  return (guest.nights ?? [])
    .map((night) => night.stayDate)
    .filter((stayDate) => {
      const key = formatDateOnly(stayDate);
      return key >= rangeStartKey && key < rangeEndKey;
    })
    .sort((a, b) => a.getTime() - b.getTime());
}

async function pruneAllocationsForBooking(
  db: BedAllocationLifecycleDb,
  bookingId: string,
  booking: BookingForBedAllocation,
): Promise<{ deletedCount: number; promotedCount: number }> {
  if (
    !booking ||
    booking.deletedAt ||
    !isAllocatableBookingStatus(booking.status) ||
    // ADR-001 short-circuit (#2285): a whole-lodge-held booking owns NO
    // per-bed rows — the group implicitly occupies the whole lodge. Sweeping
    // here (not just skipping creation) is what makes legacy rows self-heal:
    // any reconcile that touches a held booking removes rows an older
    // lifecycle wrongly created, with no data migration needed.
    booking.wholeLodgeHold ||
    booking.guests.length === 0
  ) {
    // Whole-booking sweep (cancelled / soft-deleted / non-allocatable /
    // whole-lodge-held / no guests): cancelling the primary's booking orphans
    // a partner sitting on ANOTHER booking (sharing eligibility is
    // member-level), so promote after the sweep (#1750).
    return sweepAllocationsWithPromotion(db, { bookingId });
  }

  const guestIds = booking.guests.map((guest) => guest.id);
  const staleGuestNightClauses: Prisma.BedAllocationWhereInput[] = [
    { bookingGuestId: { notIn: guestIds } },
  ];

  for (const guest of booking.guests) {
    const nightDates = guest.nights?.map((night) => night.stayDate) ?? [];
      // Prune any allocation on a night the guest no longer stays — this covers
      // gaps in a non-contiguous stay and nights switched off in the grid
      // (issue #713), not just the range edges.
      staleGuestNightClauses.push({
        bookingGuestId: guest.id,
        stayDate: { notIn: nightDates },
      });
  }

  // Stale guest-night sweep (date change / night dropped / guest removed):
  // dropping a night on which the guest was a shared double's primary orphans a
  // partner from another booking, so promote after the sweep (#1750).
  return sweepAllocationsWithPromotion(db, {
    bookingId,
    OR: staleGuestNightClauses,
  });
}

/**
 * Per-lodge auto-allocation switch (lodge-scoping contract): a lodge's own
 * settings row (id = lodgeId) wins; otherwise the legacy "default" row
 * applies when it is unlinked or soft-linked to this lodge; missing rows
 * default to enabled. Exported for the admin settings surface.
 */
export async function resolveAutoAllocationEnabled(
  db: {
    bedAllocationSettings: {
      findUnique: (args: {
        where: { id: string };
      }) => Promise<{
        id: string;
        autoAllocationEnabled: boolean;
        allocationPriorityOrder: unknown;
        lodgeId?: string | null;
      } | null>;
    };
  },
  lodgeId?: string | null,
): Promise<boolean> {
  return (await resolveEffectiveBedAllocationSettings(db, lodgeId))
    .autoAllocationEnabled;
}

async function autoAllocateMissingBedNights({
  db,
  bookingId,
  range,
  lodgeId,
}: AutoAllocateMissingBedNightsInput): Promise<number> {
  const settings = await resolveEffectiveBedAllocationSettings(db, lodgeId);
  if (!settings.autoAllocationEnabled) {
    return 0;
  }

  const [rooms, bookings] = await Promise.all([
    db.lodgeRoom.findMany({
      where: lodgeId ? lodgeNullTolerantScope(lodgeId) : undefined,
      include: { beds: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
    }),
    db.booking.findMany({
      where: {
        deletedAt: null,
        status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
        checkIn: { lt: range.checkOut },
        checkOut: { gt: range.checkIn },
        // DELIBERATELY NOT consent-filtered, unlike the guest select below
        // (owner decision D-12, #2307). This `some` decides which bookings the
        // planner LOADS — the set it widens its load envelope from (#1677) and
        // sees existing occupancy against (#1387) — not who it places. Narrowing
        // it would make the planner blind to a neighbouring booking whose only
        // overlapping guest happens to be unconsented, and that booking's
        // already-written BedAllocation rows would still be occupying beds. Only
        // the reconciled booking's guests are ever placed, and that list IS
        // filtered, so nothing here can draft a bed for an absent guest.
        guests: {
          some: {
            stayStart: { lt: range.checkOut },
            stayEnd: { gt: range.checkIn },
          },
        },
        ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
      },
      select: {
        id: true,
        createdAt: true,
        lodgeId: true,
        requestedRoomId: true,
        // #1677 envelope widening: the overlapping bookings' own stay windows
        // widen the loads below so the planner sees WHOLE stays.
        checkIn: true,
        checkOut: true,
        // #1387: classify each booking Held vs Provisional so the planner can
        // give capacity-holding bookings first claim on beds. The request
        // `type` marks SCHOOL groups (#1768) — adults together, students
        // separate — including a SCHOOL request's pre-approval held booking.
        status: true,
        originBookingRequest: { select: { id: true, type: true } },
        heldForBookingRequest: { select: { type: true } },
        adminCapacityHoldAt: true,
        // ADR-001 short-circuit (#2285): a whole-lodge-held booking is never
        // auto-placed (deep guard in the planner-bookings filter below).
        wholeLodgeHold: true,
        // Whole-stay planning (issue #1677): load every guest of an
        // overlapping booking, not just the reconcile-range slice — guest
        // stays sit inside the booking envelope, which is inside the widened
        // load envelope by construction.
        guests: {
          // D-12 (#2307): the planner never drafts a bed for a guest who is not
          // operationally present. A booking whose only overlapping guests are
          // unconsented therefore yields an empty guest list and is dropped from
          // `plannerBookings` below, exactly as a booking with nothing left to
          // place already is.
          where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE },
          select: {
            id: true,
            bookingId: true,
            ageTier: true,
            stayStart: true,
            stayEnd: true,
            nights: { select: { stayDate: true } },
            member: {
              select: {
                familyGroupMemberships: {
                  select: { familyGroupId: true },
                },
              },
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);

  // Envelope widening (issue #1677): clip loads to [min(checkIn), max(checkOut)]
  // of the bookings overlapping the reconcile range, union the range itself.
  // The planner then plans whole stays instead of range slices, while the
  // planner bookings SET stays restricted to bookings overlapping the original
  // range (no cascade to neighbours-of-neighbours).
  let envelopeCheckIn = range.checkIn;
  let envelopeCheckOut = range.checkOut;
  for (const booking of bookings) {
    if (booking.checkIn && booking.checkIn < envelopeCheckIn) {
      envelopeCheckIn = booking.checkIn;
    }
    if (booking.checkOut && booking.checkOut > envelopeCheckOut) {
      envelopeCheckOut = booking.checkOut;
    }
  }
  const envelope: BedAllocationLifecycleRange = {
    checkIn: envelopeCheckIn,
    checkOut: envelopeCheckOut,
  };

  // DELIBERATELY NOT CONSENT-FILTERED (owner decision D-12, #2307).
  //
  // This reads the BedAllocation rows that already exist, to learn which beds
  // are occupied and which guest-nights are already placed. It is an occupancy
  // view of the world as written, not a list of who should be placed. Filtering
  // it on consent would corrupt that view in two ways: a bed still holding an
  // unconsented guest's row would look free and the planner would double-book
  // it, and `allocatedGuestNights` below would forget that guest-night was
  // already written and draft a duplicate. The exclusion belongs on the two
  // guest SELECTS above, which decide who gets placed; the sweep in
  // `pruneAllocationsForBooking` is what removes a stale row, not this query.
  const existingAllocations = await db.bedAllocation.findMany({
    where: {
      stayDate: {
        gte: envelope.checkIn,
        lt: envelope.checkOut,
      },
      ...(lodgeId ? { room: lodgeNullTolerantScope(lodgeId) } : {}),
    },
    select: {
      bedId: true,
      bookingId: true,
      bookingGuestId: true,
      roomId: true,
      stayDate: true,
      // #1387: an admin-approved allocation (#776 lock) is never displaced —
      // and (#1677) one approved night pins its whole booking.
      approvedAt: true,
      // #1387: classify each occupied bed-night Held vs Provisional so the
      // planner never displaces a capacity-holding occupant. createdAt orders
      // newest-first eviction and checkIn/checkOut flag stays that extend past
      // the envelope as non-displaceable (#1677).
      booking: {
        select: {
          status: true,
          createdAt: true,
          checkIn: true,
          checkOut: true,
          lodgeId: true,
          requestedRoomId: true,
          originBookingRequest: { select: { id: true, type: true } },
          heldForBookingRequest: { select: { type: true } },
          adminCapacityHoldAt: true,
        },
      },
      bookingGuest: {
        select: {
          ageTier: true,
          member: {
            select: {
              familyGroupMemberships: {
                select: { familyGroupId: true },
              },
            },
          },
        },
      },
    },
  });

  const allocatedGuestNights = new Set(
    existingAllocations.map(
      (allocation) =>
        `${allocation.bookingGuestId}:${formatDateOnly(allocation.stayDate)}`,
    ),
  );

  const plannerBookings: BedAllocationBooking[] = bookings
    // #1686: only the reconciled booking's guests are auto-placed. Other
    // overlapping bookings were loaded above so the planner can widen the load
    // envelope (#1677) and see/displace their occupancy (#1387), but their own
    // missing guest-nights are never opportunistically drafted here — lodge-
    // wide re-planning belongs exclusively to the explicit board action.
    //
    // ADR-001 short-circuit (#2285), deep guard: a whole-lodge-held booking is
    // NEVER auto-placed, even if a caller reaches this planner with a held
    // bookingId directly. reconcileBedAllocationsForBooking already skips the
    // planner for held bookings; this keeps the invariant local to the code
    // that writes BedAllocation rows. The board planner applies the same
    // exclusion (admin-bed-allocation.ts heldSpans / unallocatedGuestNights).
    .filter((booking) => booking.id === bookingId && !booking.wholeLodgeHold)
    .map((booking): BedAllocationBooking | null => {
      const guests: BedAllocationBooking["guests"] = [];

      for (const guest of booking.guests) {
        // Allocate only the nights the guest actually stays (issue #713):
        // a non-contiguous stay gets beds on its included nights, not the
        // whole envelope. The widened load envelope (#1677) exposes the
        // guest's WHOLE stay so the planner can keep it in one room.
        for (const stayDate of getGuestNightDatesInRange(guest, envelope)) {
          const stayDateKey = formatDateOnly(stayDate);
          if (allocatedGuestNights.has(`${guest.id}:${stayDateKey}`)) {
            continue;
          }

          guests.push({
            id: guest.id,
            bookingId: booking.id,
            ageTier: guest.ageTier,
            stayStart: stayDate,
            stayEnd: addDaysDateOnly(stayDate, 1),
            nights: [stayDate],
            familyGroupIds:
              guest.member?.familyGroupMemberships.map(
                (membership) => membership.familyGroupId,
              ) ?? [],
          });
        }
      }

      return guests.length
        ? {
            id: booking.id,
            createdAt: booking.createdAt,
            lodgeId: booking.lodgeId,
            requestedRoomId: booking.requestedRoomId,
            holdsCapacity: bookingHoldsCapacity({
              status: booking.status,
              isRequestConverted: Boolean(booking.originBookingRequest),
              hasAdminCapacityHold: Boolean(booking.adminCapacityHoldAt),
            }),
            // SCHOOL request bookings (#1768): adults room together,
            // students separately.
            isSchoolGroup:
              booking.originBookingRequest?.type === "SCHOOL" ||
              booking.heldForBookingRequest?.type === "SCHOOL",
            guests,
          }
        : null;
    })
    .filter((booking): booking is BedAllocationBooking => Boolean(booking));

  if (plannerBookings.length === 0) {
    return 0;
  }

  const plannerRooms = rooms.map((room) => ({
    id: room.id,
    name: room.name,
    sortOrder: room.sortOrder,
    active: room.active,
    lodgeId: room.lodgeId,
    beds: room.beds.map((bed) => ({
      id: bed.id,
      roomId: bed.roomId,
      name: bed.name,
      sortOrder: bed.sortOrder,
      active: bed.active,
    })),
  })) satisfies BedAllocationRoom[];

  // Which lodge is each planned room in? Only the write-time whole-lodge-hold
  // re-filter (#2317) needs this, and only on a CLUB-WIDE reconcile — a scoped
  // one already knows its lodge. Built from the rooms already loaded, so it
  // costs no extra query either way.
  const roomLodgeIdById = new Map<string, string>(
    rooms.flatMap((room) => (room.lodgeId ? [[room.id, room.lodgeId]] : [])),
  );

  // Custodian bed holds (#2286): a bed held for a season by a hut-leader
  // assignment has no Booking and no BedAllocation row, so it is invisible to
  // `existingAllocations` above. Feed it to the planner as #1768 "unknown
  // occupant" rows — blocking, NEVER evictable (so a displacement can never
  // move a booking onto it either) and conservative for room mix.
  //
  // Exclusive whole-lodge holds (#2317) are loaded on the same envelope for the
  // same reason: a held group implicitly occupies every bed of its lodge for
  // its nights (ADR-001) and owns no `BedAllocation` row anywhere (#2285), so
  // it too is invisible to `existingAllocations`. Its own query, not a filter
  // over `bookings` above: that load is restricted to bed-allocatable statuses
  // AND to bookings with a guest overlapping the range, and a hold's blocking
  // power depends on neither — it is the capacity engine's population or
  // nothing (see exclusive-hold-occupancy.ts).
  const [custodianHolds, blockingWholeLodgeHolds] = await Promise.all([
    findCustodianBedHolds({
      // Club-wide when the reconcile is unscoped, matching every other load here.
      lodgeId: lodgeId ?? undefined,
      from: envelope.checkIn,
      toExclusive: envelope.checkOut,
      db,
    }),
    findBlockingWholeLodgeHolds({
      lodgeId: lodgeId ?? undefined,
      from: envelope.checkIn,
      toExclusive: envelope.checkOut,
      db,
    }),
  ]);
  const envelopeNights = eachDateOnlyInRange(
    envelope.checkIn,
    envelope.checkOut,
  );

  const plan = buildFirstFitBedAllocationPlan({
    enabled: true,
    // #1387: capacity-holding bookings get first claim; a blocking provisional
    // allocation is moved aside or unallocated so a held booking always gets a
    // bed the availability math already admitted it to.
    prioritizeCapacityHolding: true,
    allocationPriorityOrder: settings.allocationPriorityOrder,
    rooms: plannerRooms,
    bookings: plannerBookings,
    occupiedBedNights: [
      ...custodianOccupiedBedNightsForPlanner(custodianHolds, envelopeNights),
      // #2317 (owner decision option (a)): every active bed of a held lodge, on
      // every held night, as unattributed non-displaceable occupancy. The held
      // booking itself is never planned (the #2285 short-circuit above), so
      // this only ever stops ANOTHER booking's guests from being auto-placed
      // onto beds the held group is physically using — those guest-nights come
      // back as NO_BED_AVAILABLE for the officer instead.
      ...wholeLodgeHoldOccupiedBedNightsForPlanner(
        blockingWholeLodgeHolds,
        rooms,
        envelopeNights,
      ),
      ...existingAllocations.map((allocation) => ({
        bedId: allocation.bedId,
        bookingId: allocation.bookingId,
        bookingGuestId: allocation.bookingGuestId,
        roomId: allocation.roomId,
        stayDate: allocation.stayDate,
        ageTier: allocation.bookingGuest.ageTier,
        familyGroupIds:
          allocation.bookingGuest.member?.familyGroupMemberships.map(
            (membership) => membership.familyGroupId,
          ) ?? [],
        bookingRequestedRoomId:
          allocation.booking?.requestedRoomId ?? null,
        bookingIsSchoolGroup:
          allocation.booking?.originBookingRequest?.type === "SCHOOL" ||
          allocation.booking?.heldForBookingRequest?.type === "SCHOOL",
        approvedAt: allocation.approvedAt,
        // #1677: newest provisional bookings are evicted first when a held
        // booking needs a whole room.
        bookingCreatedAt: allocation.booking?.createdAt ?? null,
        // #1677: a stay extending past the loaded envelope is only partially
        // visible, so a whole-stay move is impossible — treat it as
        // non-displaceable (mirrors the holdsCapacity-undefined default).
        stayExtendsBeyondWindow: Boolean(
          allocation.booking &&
            ((allocation.booking.checkIn &&
              allocation.booking.checkIn < envelope.checkIn) ||
              (allocation.booking.checkOut &&
                allocation.booking.checkOut > envelope.checkOut)),
        ),
        holdsCapacity: allocation.booking
          ? bookingHoldsCapacity({
              status: allocation.booking.status,
              isRequestConverted: Boolean(
                allocation.booking.originBookingRequest,
              ),
              hasAdminCapacityHold: Boolean(
                allocation.booking.adminCapacityHoldAt,
              ),
            })
          : false,
      })),
    ],
  });

  if (plan.allocations.length === 0) {
    return 0;
  }

  const createManyArgs = {
    data: plan.allocations.map((allocation) => ({
      bookingId: allocation.bookingId,
      bookingGuestId: allocation.bookingGuestId,
      roomId: allocation.roomId,
      bedId: allocation.bedId,
      stayDate: new Date(`${allocation.stayDate}T00:00:00.000Z`),
      source: allocation.source,
    })),
    skipDuplicates: true,
  };

  const displacements = plan.displacements ?? [];

  /**
   * Which of the planned displacements are still JUSTIFIED by the re-checked
   * payload (#2317 review)?
   *
   * A displacement exists for exactly one reason: it frees the bed-night
   * `(fromBedId, stayDate)` so a capacity-holding booking can take it. The
   * write-time re-filters drop payload rows at ROW granularity — a whole-lodge
   * hold covering part of a stay is the normal case — so a plan can arrive here
   * with the displacement still in the list and the row it was clearing the way
   * for already gone. Applying it then destroys an existing (possibly
   * hand-placed) allocation in exchange for nothing, and writes a
   * `provisional_displaced` audit entry for a claim that never happened.
   *
   * The unit is the DISPLACED BOOKING, not the individual row: #1677 relocates
   * or unallocates a provisional stay whole and never night-splits it, so its
   * displacement set is all-or-nothing here too. A booking's set survives when
   * ANY bed-night its eviction freed is claimed by a surviving payload row.
   */
  const justifiedDisplacements = (
    data: typeof createManyArgs.data,
  ): BedAllocationDisplacement[] => {
    if (displacements.length === 0) return [];
    const claimed = new Set(
      data.map((row) => `${row.bedId}:${formatDateOnly(row.stayDate)}`),
    );
    const justifiedBookingIds = new Set(
      displacements
        .filter((displacement) =>
          claimed.has(`${displacement.fromBedId}:${displacement.stayDate}`),
        )
        .map((displacement) => displacement.bookingId),
    );
    return displacements.filter((displacement) =>
      justifiedBookingIds.has(displacement.bookingId),
    );
  };

  // Write-time re-check (#2285 review): the planner's booking read happened
  // several queries ago and this reconcile is often called post-commit and
  // unlocked, so a hold SET / cancel / soft delete may have landed in between.
  // Re-read the payload's bookings and drop any that are no longer allocatable
  // rather than re-inserting rows a concurrent prune just removed.
  const recheckPayload = async (client: BedAllocationLifecycleDb) => {
    const { rows, droppedBookingIds } =
      await dropAllocationRowsForUnallocatableBookings(
        client,
        createManyArgs.data,
      );
    if (droppedBookingIds.length > 0) {
      logger.info(
        { bookingId, droppedBookingIds },
        "Bed allocation write-time re-check dropped rows for bookings that became unallocatable (held/cancelled/deleted) after planning",
      );
    }
    // Custodian re-filter (#2286 review M1). Feeding the holds to the planner
    // above is NOT enough on its own: that read happened several queries
    // earlier, and this reconcile is routinely called post-commit and unlocked,
    // so a hold created between the plan and the write would be silently
    // written over — no unique index and no database constraint stands behind
    // the custodian exclusion (owner decision, option (a)). Re-read the holds
    // HERE, on the SAME client that is about to write, and drop any row that
    // would land on one. Mirrors runAutoBedAllocation's re-filter exactly.
    // `custodian-write-path-contract.test.ts` reads this call as the evidence
    // that the custodian re-filter is still wired in — whitespace-insensitively,
    // so this may be reformatted freely.
    const offCustodianHolds = await dropRowsOnCustodianHeldBedNights(
      client,
      rows,
      { lodgeId: lodgeId ?? undefined, bookingId },
    );
    // Whole-lodge-hold re-filter (#2317), the same shape and the same reason —
    // see dropRowsOnWholeLodgeHeldNights.
    return dropRowsOnWholeLodgeHeldNights(client, offCustodianHolds, {
      lodgeId: lodgeId ?? undefined,
      bookingId,
      roomLodgeIdById,
    });
  };

  // Common case (no displacement): a plain createMany, unchanged apart from the
  // re-checked payload.
  if (displacements.length === 0) {
    const data = await recheckPayload(db);
    if (data.length === 0) return 0;
    const created = await db.bedAllocation.createMany({
      ...createManyArgs,
      data,
    });
    return created.count;
  }

  // Apply the provisional MOVEs/UNALLOCATEs BEFORE creating the new capacity-
  // holding allocations, so the freed beds are available and no transient
  // @@unique([bedId, stayDate]) conflict occurs (issue #1387). updateMany/
  // deleteMany (not update/delete) make a row that was concurrently pruned an
  // idempotent no-op (count 0) rather than a P2025 crash.
  const applyPlan = async (
    client: BedAllocationLifecycleDb,
    lockLodgeIds: string[],
  ) => {
    // Locks FIRST, in sorted order (#2286 review M1). The custodian exclusion
    // has no database constraint behind it, so the re-check read below and the
    // write must sit inside the same per-lodge advisory lock the hold writer
    // takes. Sorted acquisition is the codebase's multi-lodge pattern, so a
    // club-wide reconcile can never deadlock against the per-lodge
    // transactions taking the same keys one at a time; pg advisory locks are
    // re-entrant within a session, so re-taking one an outer caller already
    // holds is a no-op.
    for (const lockLodgeId of lockLodgeIds) {
      await acquireLodgeCapacityLock(client, lockLodgeId);
    }
    // Re-check on the transaction client: if the booking we are planning
    // for became held/cancelled/deleted since the read, we must not displace
    // anyone else's provisional rows on its behalf either.
    const data = await recheckPayload(client);
    if (data.length === 0) {
      return { count: 0, applied: false, appliedDisplacements: [] };
    }

    // Only the displacements the re-checked payload still needs (see
    // `justifiedDisplacements`). A row dropped by a write-time re-filter takes
    // its displacement down with it rather than leaving a provisional booking
    // evicted for a bed nobody ends up in.
    const applicable = justifiedDisplacements(data);
    if (applicable.length < displacements.length) {
      logger.info(
        {
          bookingId,
          plannedDisplacements: displacements.length,
          appliedDisplacements: applicable.length,
        },
        "Bed allocation write-time re-check dropped displacements whose freed bed-nights are no longer claimed by the payload",
      );
    }

    for (const displacement of applicable) {
      const where = {
        bookingGuestId: displacement.bookingGuestId,
        stayDate: new Date(`${displacement.stayDate}T00:00:00.000Z`),
      };
      if (
        displacement.type === "MOVE" &&
        displacement.toBedId &&
        displacement.toRoomId
      ) {
        await client.bedAllocation.updateMany({
          where,
          data: { bedId: displacement.toBedId, roomId: displacement.toRoomId },
        });
      } else {
        await client.bedAllocation.deleteMany({ where });
      }
    }
    const created = await client.bedAllocation.createMany({
      ...createManyArgs,
      data,
    });
    return {
      count: created.count,
      applied: true,
      appliedDisplacements: applicable,
    };
  };

  // Apply atomically: a failed createMany after an UNALLOCATE must never
  // permanently drop the provisional row. If the caller already runs us inside
  // a transaction (db is a TransactionClient with no `$transaction`), apply
  // inline on that client; otherwise open our own transaction.
  const transactionalDb = db as typeof prisma;
  const canOpenTransaction = typeof transactionalDb.$transaction === "function";

  let created: {
    count: number;
    applied: boolean;
    appliedDisplacements: BedAllocationDisplacement[];
  };
  if (canOpenTransaction) {
    // Which lodges does this write touch? A scoped reconcile locks exactly its
    // lodge; an unscoped (pre-backfill / club-wide) one locks every lodge whose
    // rooms the payload targets, sorted. Resolved BEFORE the transaction opens
    // so the lock is the transaction's first statement.
    const lockLodgeIds = lodgeId
      ? [lodgeId]
      : await resolveLodgeIdsForRooms(
          db,
          plan.allocations.map((allocation) => allocation.roomId),
        );
    created = await transactionalDb.$transaction((tx) =>
      applyPlan(tx, lockLodgeIds),
    );
  } else {
    // Already inside the caller's transaction: it owns the lock discipline (and
    // may already hold this lodge's key), so re-acquiring here could only add a
    // second key to a transaction whose ordering we do not control. The
    // custodian re-filter still runs on that client, immediately before the
    // write.
    created = await applyPlan(db, []);
  }

  // Audit trail: record each displacement on the displaced PROVISIONAL booking
  // AFTER the plan is applied (post-commit when we own the transaction) so an
  // audit-write failure can never roll back a committed displacement, and every
  // committed displacement always attempts its audit. Best-effort (swallowed).
  // Skipped entirely when the write-time re-check abandoned the plan (#2285
  // review), and narrowed to the displacements that were actually applied
  // (#2317 review): a displacement whose freed bed-night the payload no longer
  // claims never happened, so it must never be audited as though it had.
  for (const displacement of created.appliedDisplacements) {
    await recordBedDisplacementAudit(db, displacement);
  }

  return created.count;
}

async function recordBedDisplacementAudit(
  db: BedAllocationLifecycleDb,
  displacement: BedAllocationDisplacement,
): Promise<void> {
  const summary =
    displacement.type === "MOVE"
      ? `Auto-allocation moved this provisional booking's bed on ${displacement.stayDate} to another bed so a capacity-holding booking could claim it (issue #1387).`
      : `Auto-allocation returned this provisional booking's bed on ${displacement.stayDate} to the awaiting-allocation queue so a capacity-holding booking could claim it (issue #1387).`;

  try {
    await createAuditLog(
      {
        action: "bed_allocation.provisional_displaced",
        category: "lodge",
        entityType: "Booking",
        entityId: displacement.bookingId,
        targetId: displacement.bookingId,
        outcome: "success",
        summary,
        metadata: {
          issue: 1387,
          displacementType: displacement.type,
          stayDate: displacement.stayDate,
          displacedBookingId: displacement.bookingId,
          displacedBookingGuestId: displacement.bookingGuestId,
          fromBedId: displacement.fromBedId,
          toBedId: displacement.toBedId ?? null,
          displacedByBookingId: displacement.displacedByBookingId,
        },
      },
      db,
    );
  } catch (err) {
    logger.error(
      { err, displacement },
      "Failed to record bed displacement audit",
    );
  }
}

/**
 * Internal reconciliation entrypoint for callers that already hold the global
 * booking lock followed by this booking's lodge-capacity lock.
 */
export async function reconcileBedAllocationsForBookingWithLodgeLockHeld({
  bookingId,
  db,
}: ReconcileBedAllocationsForBookingInput & {
  db: BedAllocationLifecycleDb;
}): Promise<BedAllocationLifecycleResult> {
  const enabled = await isEffectiveModuleEnabled("bedAllocation", db);

  if (!enabled) {
    return { enabled: false, deletedCount: 0, createdCount: 0, promotedCount: 0 };
  }

  const booking = await loadBookingForBedAllocation(db, bookingId);
  const { deletedCount, promotedCount } = await pruneAllocationsForBooking(
    db,
    bookingId,
    booking,
  );

  // #1686: auto-placement is scoped to THIS booking on its CURRENT nights.
  // previousRange no longer widens the planner scan (pruning already removed
  // stale rows), so a date change/cancellation never re-plans anyone else into
  // the freed beds. When the booking cannot receive allocations at all —
  // missing, soft-deleted, non-allocatable status (cancelled etc.), or an
  // empty range — skip the planner entirely: it would deterministically place
  // nothing, and cancel/delete flows call this inside their transactions.
  // ADR-001 short-circuit (#2285): a whole-lodge-held booking must never be
  // fed to the planner — the board already excludes it (admin-bed-allocation
  // heldSpans), and the lifecycle must agree. Keyed on the flag, not the
  // status: a held booking sits in an ordinary allocatable status, so
  // BED_ALLOCATABLE_BOOKING_STATUSES alone cannot express this.
  const bookingCanReceiveAllocations = Boolean(
    booking &&
      !booking.deletedAt &&
      !booking.wholeLodgeHold &&
      isAllocatableBookingStatus(booking.status),
  );
  const currentRange = normalizeRange(
    bookingCanReceiveAllocations && booking
      ? { checkIn: booking.checkIn, checkOut: booking.checkOut }
      : null,
  );
  const createdCount = currentRange
    ? await autoAllocateMissingBedNights({
        db,
        bookingId,
        range: currentRange,
        lodgeId: booking?.lodgeId ?? null,
      })
    : 0;

  return { enabled: true, deletedCount, createdCount, promotedCount };
}

/**
 * Composition boundary for a transaction that already owns global lock(1)
 * but has not yet acquired the booking's lodge key. It resolves that key under
 * the global lock, acquires the lodge tier, then delegates to the fully-held
 * implementation. Call this before any member-family lock is acquired.
 */
export async function reconcileBedAllocationsForBookingWithGlobalLockHeld(
  input: ReconcileBedAllocationsForBookingInput & {
    db: BedAllocationLifecycleDb;
  },
): Promise<BedAllocationLifecycleResult> {
  const bookingKey = await input.db.booking.findUnique({
    where: { id: input.bookingId },
    select: { lodgeId: true },
  });
  if (bookingKey?.lodgeId) {
    await acquireLodgeCapacityLock(input.db, bookingKey.lodgeId);
  }
  return reconcileBedAllocationsForBookingWithLodgeLockHeld(input);
}

/**
 * Self-locking public boundary. It owns its transaction and acquires global
 * then the booking's immutable lodge key; composed transactions use one of the
 * explicit held entrypoints above. Mutable booking/allocation state is re-read
 * by the internal implementation after lock acquisition.
 */
export async function reconcileBedAllocationsForBooking(
  input: ReconcileBedAllocationsForBookingInput,
): Promise<BedAllocationLifecycleResult> {
  const runLocked = async (tx: BedAllocationLifecycleDb) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    return reconcileBedAllocationsForBookingWithGlobalLockHeld({
      ...input,
      db: tx,
    });
  };

  return prisma.$transaction(runLocked);
}

// ---------------------------------------------------------------------------
// Stale partner-share sweep (#1756)
//
// Placement-time eligibility (mayShareDoubleBed) blocks NEW second occupants
// once a partner link dissolves or a member stops being an active adult, but
// rows placed while the pair qualified used to outlive those events. This
// sweep removes the affected pair's FUTURE (tonight onwards, NZ date-only —
// the same `stayDate >= getTodayDateOnly()` window as the bed deactivate
// guard) shared-double second-occupant rows, returning those guest-nights to
// the awaiting-allocation queue; past lodge nights are history and stay
// untouched. Only the `isSecondOccupant=true` row is ever deleted — the
// primary keeps their bed — so the sweep can never orphan a partner and needs
// no promotion pass (contrast the #1750 primary-removal paths). Callers run it
// on the same transaction as the event that broke the pair (link delete /
// member deactivation) and alert admins after commit
// (`sendAdminPartnerShareSweptAlert`). Not gated on the Bed Allocation module
// toggle: a stale row is invalid whether or not the board is currently
// enabled, and with the module unused the candidate set is simply empty.
// ---------------------------------------------------------------------------

export type PartnerSharedSweepReason =
  | "partner_link_dissolved"
  | "member_deactivated"
  | "member_age_tier_changed"
  | "members_merged";

const PARTNER_SHARE_SWEEP_REASON_LABELS: Record<PartnerSharedSweepReason, string> = {
  partner_link_dissolved: "Partner link dissolved",
  member_deactivated: "Member deactivated",
  member_age_tier_changed: "Member is no longer an adult",
  members_merged: "Members merged with no confirmed partnership",
};

/** Human phrase for a sweep reason, shared by the audit rows and admin alert. */
export function describePartnerSharedSweepReason(
  reason: PartnerSharedSweepReason,
): string {
  return PARTNER_SHARE_SWEEP_REASON_LABELS[reason];
}

export interface SweptPartnerSharedAllocation {
  allocationId: string;
  // The second occupant's booking (the removed row's side).
  bookingId: string;
  bookingGuestId: string;
  bedId: string;
  roomId: string;
  stayDate: Date;
  secondOccupantMemberId: string | null;
  secondOccupantName: string;
  // The bed-night's surviving primary — often a DIFFERENT booking (sharing
  // eligibility is member-level). Null only for an already-orphaned second
  // occupant swept via the single-member scope.
  primaryBookingId: string | null;
  primaryMemberId: string | null;
  primaryName: string | null;
}

const SWEEP_ALLOCATION_SELECT = {
  id: true,
  bookingId: true,
  bookingGuestId: true,
  bedId: true,
  roomId: true,
  stayDate: true,
  bookingGuest: {
    select: { memberId: true, firstName: true, lastName: true },
  },
} as const;

type SweepAllocationRow = Prisma.BedAllocationGetPayload<{
  select: typeof SWEEP_ALLOCATION_SELECT;
}>;

function sweepBedNightKey(bedId: string, stayDate: Date): string {
  return `${bedId}:${formatDateOnly(stayDate)}`;
}

function sweepGuestName(guest: { firstName: string; lastName: string }): string {
  return `${guest.firstName} ${guest.lastName}`.trim();
}

/** Distinct swept lodge nights, ascending — for the admin alert. */
export function partnerShareSweepNights(
  swept: SweptPartnerSharedAllocation[],
): Date[] {
  const byKey = new Map<string, Date>();
  for (const row of swept) {
    byKey.set(formatDateOnly(row.stayDate), row.stayDate);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, date]) => date);
}

/**
 * The other member(s) of the swept bed-nights, for the deactivation/tier-change
 * call sites where the counterpart is only known from the rows themselves
 * (dissolve call sites already hold both partners' names).
 */
export function partnerShareSweepCounterpartNames(
  swept: SweptPartnerSharedAllocation[],
  memberId: string,
): string {
  const names = new Set<string>();
  let sawSelfPair = false;
  for (const row of swept) {
    if (row.secondOccupantMemberId !== memberId && row.secondOccupantName) {
      names.add(row.secondOccupantName);
    }
    if (row.primaryMemberId !== memberId && row.primaryName) {
      names.add(row.primaryName);
    }
    if (
      row.secondOccupantMemberId === memberId &&
      row.primaryMemberId === memberId
    ) {
      sawSelfPair = true;
    }
  }
  if (names.size > 0) return [...names].join(", ");
  // #2595 — the merge of two records that were each other's confirmed partners
  // and shared a bed. Both guest rows collapse onto the master, so BOTH sides
  // filter out here and the old fall-back told an officer the counterpart was
  // "Unknown member" — which reads like missing data rather than the truth,
  // which is that there is no longer a second person at all.
  if (sawSelfPair) return "the same member (a merged duplicate of themselves)";
  return "Unknown member";
}

async function recordPartnerShareSweepAudits(
  db: BedAllocationLifecycleDb,
  swept: SweptPartnerSharedAllocation[],
  reason: PartnerSharedSweepReason,
): Promise<void> {
  // One audit row per affected booking SIDE — the second occupant's booking
  // and the primary's booking when they differ (a couple sharing within one
  // booking gets a single row) — grouped so a multi-night sweep records a
  // nights list rather than a row per night.
  //
  // #2595 — the row must be enough to RESTORE what was removed. `allocationIds`
  // alone are not: they name rows that no longer exist. So the group also
  // carries the bed, room, booking-guest and occupant name for each swept
  // bed-night, in the same order as `stayDates`, which is everything an
  // operator needs to put the person back on that bed from the audit trail
  // alone. This matters more for merge than for the #1756 lifecycle events:
  // arm (b) of the merge sweep can remove a row on a THIRD party's booking (see
  // `sweepUnbackedFutureSharedDoublesWithLocksHeld`), whose owner had no part in
  // the merge and no other record of what happened.
  interface SweepAuditGroup {
    bookingId: string;
    role: "second_occupant" | "primary";
    counterpartBookingId: string | null;
    stayDates: string[];
    allocationIds: string[];
    bedIds: string[];
    roomIds: string[];
    bookingGuestIds: string[];
    secondOccupantNames: string[];
  }
  const groups = new Map<string, SweepAuditGroup>();
  const add = (
    bookingId: string,
    role: SweepAuditGroup["role"],
    counterpartBookingId: string | null,
    row: SweptPartnerSharedAllocation,
  ) => {
    const key = `${bookingId}:${role}:${counterpartBookingId ?? "none"}`;
    const group =
      groups.get(key) ??
      {
        bookingId,
        role,
        counterpartBookingId,
        stayDates: [],
        allocationIds: [],
        bedIds: [],
        roomIds: [],
        bookingGuestIds: [],
        secondOccupantNames: [],
      };
    group.stayDates.push(formatDateOnly(row.stayDate));
    group.allocationIds.push(row.allocationId);
    group.bedIds.push(row.bedId);
    group.roomIds.push(row.roomId);
    group.bookingGuestIds.push(row.bookingGuestId);
    group.secondOccupantNames.push(row.secondOccupantName);
    groups.set(key, group);
  };
  for (const row of swept) {
    add(row.bookingId, "second_occupant", row.primaryBookingId, row);
    if (row.primaryBookingId && row.primaryBookingId !== row.bookingId) {
      add(row.primaryBookingId, "primary", row.bookingId, row);
    }
  }

  const reasonLabel = describePartnerSharedSweepReason(reason).toLowerCase();
  // #2595 — the merge caller is the one that must NOT swallow an audit failure,
  // and the difference is the promise each caller makes.
  //
  // The #1756 lifecycle callers commit their sweep and then fire a best-effort
  // admin email; a lost audit row there costs a nudge on a short transaction the
  // operator just performed and can see the result of. Merge's justification for
  // the same fire-and-forget email is explicitly "the evidence is already
  // committed" — so if the evidence is what failed, the promise is void. Merge
  // also deletes rows on bookings whose owners were not party to the merge, and
  // the audit row is their ONLY record of it.
  //
  // A Postgres-level failure would abort merge's transaction anyway. What this
  // catches is the JS/Prisma-level failure inside `createAuditLog`, which the
  // shared catch below would otherwise swallow with the transaction still
  // healthy — committing a bed deletion whose only trace is a log line. Rolling
  // the merge back instead is safe and retryable: nothing has left the database.
  const auditFailureIsFatal = reason === "members_merged";
  for (const group of groups.values()) {
    // Best-effort for the #1756 lifecycle events, mirroring
    // recordPartnerPromotionAudit: an audit-write failure must never roll back a
    // committed sweep. There is no acting member — the removal is a system
    // consequence of the pair breaking — so this is a "lodge" system event
    // recorded against each affected booking.
    try {
      await createAuditLog(
        {
          action: "BED_ALLOCATION_PARTNER_SHARE_SWEPT",
          category: "lodge",
          entityType: "Booking",
          entityId: group.bookingId,
          targetId: group.bookingId,
          outcome: "success",
          summary:
            group.role === "second_occupant"
              ? `Second occupant removed from shared double bed back to the awaiting-allocation queue (${reasonLabel})`
              : `This booking's shared double bed lost its second occupant to the stale partner-share sweep (${reasonLabel})`,
          metadata: {
            // The mechanism's own issue for the four pair-breaking lifecycle
            // events; #2595 for the merge reconciliation, so an operator
            // reading the audit trail lands on the defect that added it.
            issue: reason === "members_merged" ? 2595 : 1756,
            reason,
            role: group.role,
            counterpartBookingId: group.counterpartBookingId,
            stayDates: group.stayDates,
            allocationIds: group.allocationIds,
            bedIds: group.bedIds,
            roomIds: group.roomIds,
            bookingGuestIds: group.bookingGuestIds,
            secondOccupantNames: group.secondOccupantNames,
          },
        },
        db,
      );
    } catch (err) {
      logger.error(
        { err, group, reason },
        "Failed to record partner share sweep audit",
      );
      if (auditFailureIsFatal) throw err;
    }
  }
}

/**
 * The lodges of every FUTURE bed allocation these members already hold — the
 * rows a partner-share sweep may judge or delete in this transaction.
 *
 * A conservative over-lock: it also names a lodge where the member merely has
 * an unshared future placement. It cannot MISS the lodge of a shared bed-night
 * whose counterpart belongs to another booking, because both occupants sit on
 * the same bed, hence in the same room and the same lodge.
 */
async function futurePartnerShareAllocationLodgeIds(
  tx: Prisma.TransactionClient,
  uniqueMemberIds: string[],
): Promise<string[]> {
  const allocationLodges = await tx.bedAllocation.findMany({
    where: {
      stayDate: { gte: getTodayDateOnly() },
      bookingGuest: { memberId: { in: uniqueMemberIds } },
    },
    select: { room: { select: { lodgeId: true } } },
  });
  return allocationLodges
    .map((allocation) => allocation.room.lodgeId)
    .filter((lodgeId): lodgeId is string => Boolean(lodgeId));
}

/**
 * The lodges of every booking that holds a FUTURE guest-night for one of these
 * members — the lodges a placement for them could still LAND in while this
 * transaction runs, whether or not a bed allocation exists there yet (#2595).
 *
 * This is the derivation that lets a caller drop the global cohort key, so its
 * completeness argument is the whole safety case and is spelled out here:
 *
 *  - A `BedAllocation` row exists only for a `BookingGuest` (`bookingGuestId`
 *    is NOT NULL and FK-constrained), so no placement can name a member who has
 *    no guest row.
 *  - Every allocating writer picks its rooms from the guest's OWN booking's
 *    lodge (`roomsForBooking`/`roomsAtLodge` in `bed-allocation.ts`, and the
 *    lodge-scoped room reads in `admin-bed-allocation.ts`), and both
 *    `Booking.lodgeId` and `LodgeRoom.lodgeId` are NOT NULL, so the allocation's
 *    lodge is the booking's lodge.
 *  - A placement is only ever written for one of that guest's own nights, and
 *    the sweep only ever judges `stayDate >= today`, so a FUTURE placement
 *    implies a FUTURE guest-night.
 *
 * WHAT THAT ARGUMENT DOES NOT COVER, stated plainly because the three bullets
 * above are all about IMMUTABLE or FK-constrained columns and it would be easy
 * to read them as closure. They are not. Every column this query FILTERS on is
 * mutable: `BookingGuest.stayStart`, `BookingGuest.stayEnd` and the
 * `BookingGuestNight` rows. The bullets prove "a future placement implies a
 * future guest-night IN THE SAME LODGE"; they do not prove "the set of lodges
 * holding a future guest-night cannot CHANGE while the merge runs". It can.
 *
 * Concretely, these writers rewrite a guest's dates while holding
 * `pg_advisory_xact_lock(1)` plus that booking's own lodge key — and NO
 * `member-lifecycle:` or `member-partner-link:` key, which are the only keys
 * merge holds once it has dropped the global one. So merge cannot exclude them:
 *
 *  - `modifyBookingDates` and `adminShiftBookingDates`
 *    (`booking-date-modification-service.ts`) under `adminOverride`, whose
 *    documented purpose includes moving a fully-past booking's dates; and
 *  - `modifyBookingBatch` via `buildInProgressGuestRangePlan`
 *    (`booking-edit-guest-ranges.ts`), which needs NO override and no admin
 *    role: extending an in-progress booking's check-out widens EVERY remaining
 *    guest's `stayEnd` to the new check-out, including a partial-stay guest
 *    whose own nights had already finished.
 *
 * Each is followed in its own transaction by
 * `reconcileBedAllocationsForBookingWithLodgeLockHeld`, so it also creates the
 * new `BedAllocation` rows on the newly-future nights.
 *
 * The consequence: a booking at lodge Y whose guest-nights are ALL in the past
 * when this query runs is invisible to both reads, and can be shifted into the
 * future during the merge, into a lodge the merge holds no key for. Nothing
 * about `Booking.lodgeId` being immutable prevents that — the lodge does not
 * move, the NIGHTS do.
 *
 * How far the enforcement below actually gets. This is not unguarded, and it is
 * narrower than it first looks, but it is not closed:
 *
 *  - `sweepUnbackedFutureSharedDoublesWithLocksHeld` throws
 *    {@link UnlockedPartnerShareLodgeError} for any candidate row in a lodge
 *    outside the locked set, which rolls the whole merge back. That catches
 *    every interleaving where the offending row is visible at the sweep's
 *    CANDIDATE READ. A row committed after that read and before the merge
 *    commits is not caught — the merge holds no key the other writer contends
 *    on, so there is nothing to serialise them.
 *  - For the escaped row to be an unbacked SHARED DOUBLE rather than a harmless
 *    primary, something must write `isSecondOccupant: true` in that window.
 *    Auto-allocation cannot: `autoAllocateMissingBedNights`' `createMany`
 *    payload carries no `isSecondOccupant` at all and the planner
 *    (`bed-allocation.ts`) has no concept of one. Only the manual admin
 *    placement paths in `admin-bed-allocation.ts` write second occupants, and
 *    they ask `mayShareDoubleBedWith`, which — before the merge commits — still
 *    reads the CONFIRMED link the merge is about to drop and says yes.
 *
 * So the residual is a four-step interleaving (lodge Y outside the derived set
 * → a concurrent guest-date write puts a merged member on a future night at Y →
 * an admin hand-places a second occupant on it → both commit inside the sweep's
 * own read-to-commit window), not a single racing writer. It is a real hole in
 * the completeness claim and it is recorded rather than argued away. It is NOT
 * a regression: `main` runs no sweep at all, so on `main` that same state is
 * simply never reconciled. Closing it needs an owner decision about which
 * Critical surface pays — see the residual-risk section of PR #2641.
 *
 * Deliberately NOT filtered by `Booking.status`. Status transitions serialise on
 * the global cohort key, which merge no longer holds, so a booking that is not
 * allocatable when the set is derived could become allocatable while the merge
 * runs. Reading the immutable member ids and over-locking on a mutable status is
 * the safe direction; narrowing on status would reintroduce exactly the hole
 * this query closes.
 *
 * The `stayEnd`/`nights` disjunction is deliberate too: `BookingGuestNight` rows
 * are the per-night truth for modern bookings, but legacy guests can carry only
 * the `stayStart..stayEnd` envelope (which is why the planners fall back to it),
 * so either signal alone could miss a lodge.
 */
async function futurePartnerShareGuestNightLodgeIds(
  tx: Prisma.TransactionClient,
  uniqueMemberIds: string[],
): Promise<string[]> {
  const today = getTodayDateOnly();
  const guestRows = await tx.bookingGuest.findMany({
    where: {
      memberId: { in: uniqueMemberIds },
      OR: [
        { stayEnd: { gte: today } },
        { nights: { some: { stayDate: { gte: today } } } },
      ],
    },
    select: { booking: { select: { lodgeId: true } } },
  });
  return guestRows
    .map((guest) => guest.booking.lodgeId)
    .filter((lodgeId): lodgeId is string => Boolean(lodgeId));
}

/**
 * Acquire the complete lock prefix for a transaction that will invalidate
 * future partner-shared placements. Call this before any member/link mutation:
 * the sweep may touch allocations in several lodges, so the canonical order is
 * global cohort, then every affected lodge in sorted order, then any member
 * lifecycle locks owned by the caller.
 *
 * Used by the #1756 pair/member sweep callers (link dissolve, deactivation,
 * age-tier correction, seasonal reassignment, bulk update, account-deletion
 * approval). Member merge takes the narrower
 * {@link acquireMemberMergePartnerSharedLodgeLocks} instead — see that helper
 * for why, and `docs/CONCURRENCY_AND_LOCKING.md` for the composed orders.
 * Neither may take the lodge tier after a member-lifecycle key: these helpers
 * are what keep every caller on the documented global -> lodge -> member order.
 */
export async function acquireFuturePartnerSharedAllocationLocks(
  tx: Prisma.TransactionClient,
  memberIds: readonly string[],
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  const uniqueMemberIds = [...new Set(memberIds.filter(Boolean))];
  if (uniqueMemberIds.length === 0) return;

  const lodgeIds = [
    ...new Set(await futurePartnerShareAllocationLodgeIds(tx, uniqueMemberIds)),
  ].sort();
  for (const lodgeId of lodgeIds) {
    await acquireLodgeCapacityLock(tx, lodgeId);
  }
}

/**
 * Member merge's partner-share prefix (#2595): every affected lodge capacity
 * key in sorted order and NOTHING ELSE — no global cohort `lock(1)`.
 *
 * Merge is the one partner-share caller that cannot afford the global key. An
 * advisory xact lock is released only at COMMIT and merge runs with a 120s
 * budget because it makes hundreds of sequential round-trips, so holding
 * `lock(1)` for a whole merge excludes every cancel/capture/settle/refund and
 * every bed-allocation writer in the club for that entire window — writers whose
 * own transactions run on Prisma's default 5s budget and are rejected with
 * `P2028` rather than served. The #1756 callers are all short transactions, so
 * they keep the global key.
 *
 * Dropping it is only sound because the lodge set is derived from BOTH sources
 * (see {@link futurePartnerShareGuestNightLodgeIds}): the lodges the members
 * already hold future allocations in, and the lodges they hold future
 * guest-nights in. Every writer that could create, move or invalidate a future
 * shared double in a lodge takes that lodge's capacity key
 * (`docs/CONCURRENCY_AND_LOCKING.md` -> "The counterpart inventory is
 * deliberate"), so covering every lodge a placement could land in is equivalent
 * to covering the cohort for the rows this sweep judges — without serialising
 * the club.
 *
 * Immutable pre-lock keys: `memberIds` come from the request. Everything the
 * set is derived FROM is re-read under the locks by the sweep itself.
 *
 * Call it BEFORE any member-lifecycle key, exactly like its sibling; the
 * documented order is lodge -> member and merge's own hosting policy-set key
 * comes before both.
 *
 * Returns the sorted lodge ids it locked, so the caller can hand them to
 * {@link sweepUnbackedFutureSharedDoublesWithLocksHeld} and have the sweep
 * REFUSE rather than touch a row in a lodge this prefix does not cover. The
 * derivation argument above is thereby enforced at run time instead of trusted.
 */
export async function acquireMemberMergePartnerSharedLodgeLocks(
  tx: Prisma.TransactionClient,
  memberIds: readonly string[],
): Promise<string[]> {
  const uniqueMemberIds = [...new Set(memberIds.filter(Boolean))];
  if (uniqueMemberIds.length === 0) return [];

  // Sequential on purpose: both reads share one interactive transaction client.
  const allocationLodgeIds = await futurePartnerShareAllocationLodgeIds(
    tx,
    uniqueMemberIds,
  );
  const guestNightLodgeIds = await futurePartnerShareGuestNightLodgeIds(
    tx,
    uniqueMemberIds,
  );
  const lodgeIds = [
    ...new Set([...allocationLodgeIds, ...guestNightLodgeIds]),
  ].sort();
  for (const lodgeId of lodgeIds) {
    await acquireLodgeCapacityLock(tx, lodgeId);
  }
  return lodgeIds;
}

/**
 * Internal sweep for callers that already hold the global cohort lock and all
 * affected lodge locks through `acquireFuturePartnerSharedAllocationLocks`.
 * The candidate rows are deliberately re-read after those locks. It is
 * idempotent and safe on empty sets: a second run finds no rows and writes
 * nothing.
 *
 * With `partnerMemberId`, only bed-nights whose occupants are exactly that
 * pair are swept. Without it (deactivation or ADULT-to-minor correction),
 * every future shared bed-night involving the member is swept on either side:
 * the second occupant is removed while the primary keeps the bed.
 *
 * Returns the removed rows so the caller can alert admins after the enclosing
 * transaction commits; external calls remain outside the transaction.
 */
export async function sweepFuturePartnerSharedAllocationsWithLocksHeld(params: {
  memberId: string;
  partnerMemberId?: string;
  reason: PartnerSharedSweepReason;
  db: BedAllocationLifecycleDb;
}): Promise<SweptPartnerSharedAllocation[]> {
  const db = params.db;
  const today = getTodayDateOnly();
  const scopeIds = params.partnerMemberId
    ? [params.memberId, params.partnerMemberId]
    : [params.memberId];

  // Second-occupant rows where a scoped member IS the second occupant.
  const candidates = new Map<string, SweepAllocationRow>();
  const secondRows = await db.bedAllocation.findMany({
    where: {
      isSecondOccupant: true,
      stayDate: { gte: today },
      bookingGuest: { memberId: { in: scopeIds } },
    },
    select: SWEEP_ALLOCATION_SELECT,
  });
  for (const row of secondRows) {
    candidates.set(row.id, row);
  }

  // Single-member scope only: the member may instead hold the PRIMARY side of
  // a shared double, in which case the partner sitting with them is the row to
  // remove. (On a pair dissolve the first query already saw whichever member
  // of the pair is the second occupant.)
  if (!params.partnerMemberId) {
    const primaryBedNights = await db.bedAllocation.findMany({
      where: {
        isSecondOccupant: false,
        stayDate: { gte: today },
        bookingGuest: { memberId: params.memberId },
      },
      select: { bedId: true, stayDate: true },
    });
    if (primaryBedNights.length > 0) {
      const partneredRows = await db.bedAllocation.findMany({
        where: {
          isSecondOccupant: true,
          OR: primaryBedNights.map((night) => ({
            bedId: night.bedId,
            stayDate: night.stayDate,
          })),
        },
        select: SWEEP_ALLOCATION_SELECT,
      });
      for (const row of partneredRows) {
        candidates.set(row.id, row);
      }
    }
  }

  if (candidates.size === 0) {
    return [];
  }

  // The primary occupant on each candidate bed-night: verifies the exact pair
  // on a dissolve and names the cross-booking side of the audit trail.
  const primaries = await db.bedAllocation.findMany({
    where: {
      isSecondOccupant: false,
      OR: [...candidates.values()].map((row) => ({
        bedId: row.bedId,
        stayDate: row.stayDate,
      })),
    },
    select: SWEEP_ALLOCATION_SELECT,
  });
  const primaryByBedNight = new Map(
    primaries.map((row) => [sweepBedNightKey(row.bedId, row.stayDate), row]),
  );

  const targets: SweptPartnerSharedAllocation[] = [];
  for (const row of candidates.values()) {
    const primary =
      primaryByBedNight.get(sweepBedNightKey(row.bedId, row.stayDate)) ?? null;
    if (params.partnerMemberId) {
      const occupantIds = new Set([
        row.bookingGuest.memberId,
        primary?.bookingGuest.memberId ?? null,
      ]);
      if (
        !occupantIds.has(params.memberId) ||
        !occupantIds.has(params.partnerMemberId)
      ) {
        continue;
      }
    }
    targets.push({
      allocationId: row.id,
      bookingId: row.bookingId,
      bookingGuestId: row.bookingGuestId,
      bedId: row.bedId,
      roomId: row.roomId,
      stayDate: row.stayDate,
      secondOccupantMemberId: row.bookingGuest.memberId,
      secondOccupantName: sweepGuestName(row.bookingGuest),
      primaryBookingId: primary?.bookingId ?? null,
      primaryMemberId: primary?.bookingGuest.memberId ?? null,
      primaryName: primary ? sweepGuestName(primary.bookingGuest) : null,
    });
  }
  if (targets.length === 0) {
    return [];
  }

  // Idempotent, race-safe delete: id-scoped AND re-checking isSecondOccupant,
  // so a row concurrently removed (or promoted to primary by an unrelated
  // #1750 repair) is skipped rather than a primary ever being deleted.
  await db.bedAllocation.deleteMany({
    where: {
      id: { in: targets.map((target) => target.allocationId) },
      isSecondOccupant: true,
    },
  });

  await recordPartnerShareSweepAudits(db, targets, params.reason);
  return targets;
}

// ---------------------------------------------------------------------------
// Unbacked shared-double reconciliation (#2595)
//
// The #1756 sweep above answers "this NAMED pair (or this one member) stopped
// qualifying — remove their shares". Member merge cannot use it, because merge
// is not a pair-breaking event about one pair: it COLLAPSES two identities, and
// the resulting shares have to be judged one bed-night at a time.
//
// `planPartnerLinkMerge` keeps at most one CONFIRMED partner for the surviving
// master, so merging a duplicate that already had its own confirmed partner
// DROPS that link. `applyMoves` then re-points `BookingGuest.memberId` from the
// duplicate onto the master with a blanket `updateMany` and leaves every bed
// allocation exactly where it was — so the master and the duplicate's
// ex-partner are left sharing a future DOUBLE bed with no partnership behind
// it, which is precisely what `resolveSecondOccupant`/`mayShareDoubleBed`
// refuse to create in the first place. Nothing else supplies the invariant:
// merge takes no lodge tier, no lifecycle sweep covers merge, and there is no
// database trigger.
//
// Passing the pair to the #1756 sweep would be wrong in both directions. With
// `partnerMemberId` it only knows one pair, and merge can invalidate several
// bed-nights against several different counterparts. Without it, the sweep
// removes EVERY future share the member has — including the master's own,
// still-CONFIRMED share with the partner it kept, which the merge did nothing
// to invalidate.
//
// So this reconciliation is validity-driven rather than event-driven: it
// re-derives each candidate bed-night's actual two occupants and re-asks the
// single source of truth (`mayShareDoubleBedWith`, the batched form of
// `mayShareDoubleBed`) whether they may still share. Only the bed-nights that
// FAIL are swept, and only ever the `isSecondOccupant=true` row, so the primary
// keeps their bed and no partner can be orphaned. Being validity-driven it is
// also idempotent and safe to run on an unaffected merge: the candidate set is
// simply empty, or every pair still qualifies and nothing is written.
//
// LOCKS. Take `acquireMemberMergePartnerSharedLodgeLocks(tx, memberIds)` —
// every affected lodge in sorted order, and NOT the global cohort key — BEFORE
// any member-lifecycle key, because the documented order is lodge -> member
// (docs/CONCURRENCY_AND_LOCKING.md). A caller that already holds
// member-lifecycle keys must NOT reach for the lodge tier afterwards. Pass the
// lodge ids that helper returns as `lockedLodgeIds`: without the global key,
// nothing else proves this sweep is not judging a row in an unlocked lodge, so
// it refuses instead of guessing.
// ---------------------------------------------------------------------------

/**
 * Thrown when a candidate future shared-double sits in a lodge the caller does
 * not hold the capacity key for (#2595).
 *
 * That is only reachable if a lodge appeared for one of these members AFTER the
 * prefix derived its set — a booking guest row added, in a new lodge, by a
 * concurrent writer. Deleting the row anyway would mutate bed inventory in a
 * lodge this transaction never serialised against, so the caller must roll back
 * and let the operator retry; the retry derives the new lodge and covers it.
 */
export class UnlockedPartnerShareLodgeError extends Error {
  constructor(public readonly lodgeIds: string[]) {
    super(
      `Future shared-double reconciliation found candidate rows in unlocked lodge(s): ${lodgeIds.join(", ")}`,
    );
    this.name = "UnlockedPartnerShareLodgeError";
  }
}

/** The #2595 sweep also needs each candidate's lodge, to prove it is locked. */
const MERGE_SWEEP_ALLOCATION_SELECT = {
  ...SWEEP_ALLOCATION_SELECT,
  room: { select: { lodgeId: true } },
} as const;

type MergeSweepAllocationRow = Prisma.BedAllocationGetPayload<{
  select: typeof MERGE_SWEEP_ALLOCATION_SELECT;
}>;

/**
 * Remove every FUTURE shared-double placement involving these members that no
 * longer has a valid partnership behind it, and audit both sides of each
 * removed bed-night.
 *
 * For callers that already hold the complete prefix from
 * `acquireMemberMergePartnerSharedLodgeLocks(tx, memberIds)`; the candidate rows
 * are deliberately re-read after those locks. Returns the removed rows so the
 * caller can alert admins AFTER the enclosing transaction commits (external
 * calls stay outside it), exactly like its #1756 sibling.
 *
 * `memberIds` is a SCOPE, not a pair: a bed-night is a candidate when either of
 * its two occupants is one of these members. Everything else is left alone, so
 * this can never turn into a lodge-wide re-plan.
 *
 * `lockedLodgeIds` is that prefix's own return value. Every candidate row must
 * sit in one of those lodges or the sweep throws
 * {@link UnlockedPartnerShareLodgeError} without writing anything.
 */
export async function sweepUnbackedFutureSharedDoublesWithLocksHeld(params: {
  memberIds: readonly string[];
  lockedLodgeIds: readonly string[];
  reason: PartnerSharedSweepReason;
  db: BedAllocationLifecycleDb;
}): Promise<SweptPartnerSharedAllocation[]> {
  const db = params.db;
  const scopeIds = [...new Set(params.memberIds.filter(Boolean))];
  if (scopeIds.length === 0) return [];
  const lockedLodgeIds = new Set(params.lockedLodgeIds);
  const today = getTodayDateOnly();

  // Candidate second-occupant rows, from both sides of the share:
  //  (a) a scoped member IS the second occupant, and
  //  (b) a scoped member holds the PRIMARY side, so the partner sitting with
  //      them is the row to judge.
  // Both are needed for merge: `applyMoves` re-points the duplicate's guest
  // rows onto the master, and the master may end up on either side of the
  // bed-night depending on which booking placed which guest first.
  const candidates = new Map<string, MergeSweepAllocationRow>();
  const secondRows = await db.bedAllocation.findMany({
    where: {
      isSecondOccupant: true,
      stayDate: { gte: today },
      bookingGuest: { memberId: { in: scopeIds } },
    },
    select: MERGE_SWEEP_ALLOCATION_SELECT,
  });
  for (const row of secondRows) {
    candidates.set(row.id, row);
  }

  const primaryBedNights = await db.bedAllocation.findMany({
    where: {
      isSecondOccupant: false,
      stayDate: { gte: today },
      bookingGuest: { memberId: { in: scopeIds } },
    },
    select: { bedId: true, stayDate: true },
  });
  if (primaryBedNights.length > 0) {
    const partneredRows = await db.bedAllocation.findMany({
      where: {
        isSecondOccupant: true,
        OR: primaryBedNights.map((night) => ({
          bedId: night.bedId,
          stayDate: night.stayDate,
        })),
      },
      select: MERGE_SWEEP_ALLOCATION_SELECT,
    });
    for (const row of partneredRows) {
      candidates.set(row.id, row);
    }
  }
  if (candidates.size === 0) return [];

  // #2595 — the derivation check, enforced rather than trusted. Without the
  // global cohort key the ONLY thing serialising this sweep against the
  // bed-allocation writers is the per-lodge capacity key, so every row it is
  // about to judge must sit in a lodge whose key the caller holds. A miss means
  // a lodge appeared for one of these members after the derivation, and the
  // safe answer is to roll the merge back.
  //
  // This is a VISIBILITY check, not a fence, and it is worth being exact about
  // which of the two it is. It is evaluated against the candidate rows read
  // immediately above, so it fires for every offending row that had committed
  // by then — but merge holds no key those writers contend on, so a row that
  // commits after this read and before the merge's own commit is not seen here
  // and cannot be. See `futurePartnerShareGuestNightLodgeIds` for the full
  // statement of that residual and why the mutable guest-date columns are what
  // makes it possible.
  const unlockedLodgeIds = [
    ...new Set(
      [...candidates.values()]
        .map((row) => row.room.lodgeId)
        .filter((lodgeId): lodgeId is string => Boolean(lodgeId))
        .filter((lodgeId) => !lockedLodgeIds.has(lodgeId)),
    ),
  ].sort();
  if (unlockedLodgeIds.length > 0) {
    throw new UnlockedPartnerShareLodgeError(unlockedLodgeIds);
  }

  // The primary occupant on each candidate bed-night names the OTHER half of
  // the pair being judged, and the cross-booking side of the audit trail.
  const primaries = await db.bedAllocation.findMany({
    where: {
      isSecondOccupant: false,
      OR: [...candidates.values()].map((row) => ({
        bedId: row.bedId,
        stayDate: row.stayDate,
      })),
    },
    select: SWEEP_ALLOCATION_SELECT,
  });
  const primaryByBedNight = new Map(
    primaries.map((row) => [sweepBedNightKey(row.bedId, row.stayDate), row]),
  );

  // One eligibility question per distinct primary member, batched over all the
  // second occupants it faces (`mayShareDoubleBedWith` answers a whole set in
  // two statements), so the statement count is bounded by the number of
  // distinct primaries rather than by the number of candidate bed-nights.
  const secondsByPrimaryMember = new Map<string, Set<string>>();
  for (const row of candidates.values()) {
    const primary = primaryByBedNight.get(sweepBedNightKey(row.bedId, row.stayDate));
    const primaryMemberId = primary?.bookingGuest.memberId;
    const secondMemberId = row.bookingGuest.memberId;
    if (!primaryMemberId || !secondMemberId) continue;
    const seconds = secondsByPrimaryMember.get(primaryMemberId) ?? new Set<string>();
    seconds.add(secondMemberId);
    secondsByPrimaryMember.set(primaryMemberId, seconds);
  }
  const eligibleByPrimaryMember = new Map<string, Set<string>>();
  for (const [primaryMemberId, seconds] of secondsByPrimaryMember) {
    eligibleByPrimaryMember.set(
      primaryMemberId,
      await mayShareDoubleBedWith(primaryMemberId, [...seconds], db),
    );
  }

  const targets: SweptPartnerSharedAllocation[] = [];
  for (const row of candidates.values()) {
    const primary =
      primaryByBedNight.get(sweepBedNightKey(row.bedId, row.stayDate)) ?? null;
    // No primary on the bed-night: a #1743/#1750 orphan. Judging a PAIR that
    // does not exist would delete a row on the strength of a partnership
    // question nobody asked, so it is skipped — but be precise about what that
    // defers to, because the obvious reading is wrong twice over.
    //
    // There is no standing promotion pass. `promoteOrphanedSecondOccupants`
    // runs only from `deleteAllocationsWithPartnerPromotion`, the reconcile
    // prune, and `promoteVacatedOldBedNight` — i.e. only when some OTHER
    // operation removes or moves a primary on that exact bed-night. A
    // pre-existing orphan therefore stays put, possibly indefinitely. Nor is
    // this "the same choice the #1756 sweep makes": #1756's PAIR scope skips
    // orphans, but its single-member scope sweeps them and records
    // `primaryBookingId: null`.
    //
    // Skipping is still right here. A lone second occupant is not an unbacked
    // SHARE — there is only one person on the bed — and the row makes
    // `resolveSecondOccupant` refuse the bed-night outright ("This double bed
    // already has two occupants") rather than pair a new arrival with it. So
    // the #2595 invariant holds either way, and the failure mode is a blocked
    // bed rather than a bad share.
    if (!primary) continue;
    const primaryMemberId = primary.bookingGuest.memberId;
    const secondMemberId = row.bookingGuest.memberId;
    // A share needs a member on BOTH sides (`resolveSecondOccupant` refuses to
    // create one otherwise), so an unlinked guest on either side is unbacked by
    // construction and needs no eligibility round-trip.
    const stillMayShare =
      Boolean(primaryMemberId) &&
      Boolean(secondMemberId) &&
      (eligibleByPrimaryMember.get(primaryMemberId as string)?.has(
        secondMemberId as string,
      ) ??
        false);
    if (stillMayShare) continue;
    targets.push({
      allocationId: row.id,
      bookingId: row.bookingId,
      bookingGuestId: row.bookingGuestId,
      bedId: row.bedId,
      roomId: row.roomId,
      stayDate: row.stayDate,
      secondOccupantMemberId: secondMemberId,
      secondOccupantName: sweepGuestName(row.bookingGuest),
      primaryBookingId: primary.bookingId,
      primaryMemberId,
      primaryName: sweepGuestName(primary.bookingGuest),
    });
  }
  if (targets.length === 0) return [];

  // Idempotent, race-safe delete: id-scoped AND re-checking isSecondOccupant,
  // so a row concurrently removed (or promoted to primary by an unrelated
  // #1750 repair) is skipped rather than a primary ever being deleted.
  await db.bedAllocation.deleteMany({
    where: {
      id: { in: targets.map((target) => target.allocationId) },
      isSecondOccupant: true,
    },
  });

  await recordPartnerShareSweepAudits(db, targets, params.reason);
  return targets;
}
