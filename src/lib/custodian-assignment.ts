import type { Prisma } from "@prisma/client";
import {
  computeNightOccupancy,
  findOverlappingOverriddenNonHoldingBookings,
} from "@/lib/capacity";
import {
  custodianHeldNightsForBed,
  findCustodianBedHolds,
} from "@/lib/custodian-occupancy";
import {
  eachDateOnlyInRange,
  addDaysDateOnly,
  formatDateOnly,
} from "@/lib/date-only";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

/**
 * Write-side validation for a custodian bed hold (#2286) — the other half of
 * `custodian-occupancy.ts`, which is read-side only.
 *
 * Kept out of that module deliberately: this one needs `capacity.ts` and
 * `lodge-capacity.ts`, and `capacity.ts` imports `custodian-occupancy.ts`.
 * Splitting the write side out is what keeps that a straight line rather than a
 * cycle.
 *
 * Every function here is designed to run INSIDE the caller's transaction, after
 * `acquireLodgeCapacityLock` — a custodian hold is a capacity-mutating write and
 * must serialize with booking admission and with the allocation chokepoints.
 */

type CustodianAssignmentDb = typeof prisma | Prisma.TransactionClient;

/** A night the hold would push past the lodge's ceiling. */
export interface CustodianOverCapacityNight {
  date: string;
  occupiedBeds: number;
  capacity: number;
}

/**
 * A live booking over those nights that the arithmetic above does NOT count
 * (#2286 review M5), following the #177 override-settle precedent.
 *
 * `occupiedBeds` is built from `capacityHoldingBookingFilter()`, so an overridden
 * PAYMENT_PENDING booking — which the settlement carve-out will later admit onto
 * exactly these nights — contributes nothing to the number the admin is asked to
 * confirm. Naming it makes the confirmation honest: the ceiling may be breached
 * by more than the figure shown. Informational only; it never refuses.
 */
export interface CustodianOverCapacityBooking {
  id: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: string;
}

export class CustodianBedHoldError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** Machine-readable discriminator for the admin UI. */
    readonly code:
      | "BED_NOT_FOUND"
      | "BED_WRONG_LODGE"
      | "BED_HELD_BY_ANOTHER_CUSTODIAN"
      | "BED_HAS_ALLOCATIONS"
      | "MODULE_DISABLED" = "BED_NOT_FOUND",
    /** The offending nights, when the refusal is per night. */
    readonly nights: string[] = [],
  ) {
    super(message);
    this.name = "CustodianBedHoldError";
  }
}

/**
 * Warn-and-confirm signal, following the #1668 over-capacity precedent: holding
 * this bed pushes at least one night past the lodge ceiling. The admin may
 * proceed by re-sending with `confirmOverCapacity: true`.
 *
 * Deliberately NOT reusing `overCapacityNights()`: that helper is only valid
 * over a `checkCapacityForGuestRanges` result (its `availableBeds` already bakes
 * in the proposed guests). A custodian hold proposes no guests, so this flow
 * computes its own small per-night list instead — the same pattern and error
 * shape, not the same helper.
 */
export class CustodianOverCapacityConfirmationRequiredError extends Error {
  readonly status = 409;
  readonly code = "CUSTODIAN_OVER_CAPACITY_CONFIRM_REQUIRED";
  constructor(
    readonly nightDetails: CustodianOverCapacityNight[],
    /**
     * Live bookings over those nights that `nightDetails` does not count (#177
     * shape, #2286 review M5). Empty in the ordinary case.
     */
    readonly nonHoldingBookings: CustodianOverCapacityBooking[] = [],
  ) {
    super(
      "Holding that bed puts the lodge over capacity on at least one night. Confirm to proceed.",
    );
    this.name = "CustodianOverCapacityConfirmationRequiredError";
  }
}

/** Every night a `startDate..endDate` (inclusive) assignment covers. */
export function custodianAssignmentNights(
  startDate: Date,
  endDate: Date,
): Date[] {
  return eachDateOnlyInRange(startDate, addDaysDateOnly(endDate, 1));
}

/**
 * Validate an optional bed hold for a hut-leader assignment.
 *
 * Runs inside the caller's locked transaction. Throws on every hard refusal and
 * on the confirmable over-capacity signal; returns quietly when the hold is
 * fine (or when there is no bed, which is the pre-#2286 role-only case and is
 * always fine).
 */
export async function validateCustodianBedHold(input: {
  bedId: string | null;
  lodgeId: string;
  /** Inclusive first covered date. */
  startDate: Date;
  /** Inclusive last covered date. */
  endDate: Date;
  /** Present when editing, so the assignment does not conflict with itself. */
  assignmentId?: string;
  /** #1668-style explicit override of the over-capacity warning. */
  confirmOverCapacity?: boolean;
  db: CustodianAssignmentDb;
}): Promise<void> {
  const { bedId, lodgeId, startDate, endDate, db } = input;
  // No bed = role only = exactly the behaviour that existed before #2286. Every
  // row the auto-assign cron creates lands here.
  if (!bedId) return;

  const nights = custodianAssignmentNights(startDate, endDate);
  if (nights.length === 0) return;
  const toExclusive = addDaysDateOnly(endDate, 1);

  const bed = await db.lodgeBed.findUnique({
    where: { id: bedId },
    select: {
      id: true,
      name: true,
      active: true,
      room: { select: { id: true, name: true, active: true, lodgeId: true } },
    },
  });
  if (!bed || !bed.active || !bed.room.active) {
    throw new CustodianBedHoldError(
      "That bed was not found, or it (or its room) is not active.",
      404,
      "BED_NOT_FOUND",
    );
  }
  if (bed.room.lodgeId !== lodgeId) {
    // Also the refusal an admin hits when they try to move an assignment to
    // another lodge without clearing the bed first — the message says so.
    throw new CustodianBedHoldError(
      "That bed belongs to a different lodge. Clear the bed before changing the lodge, then pick a bed at the new lodge.",
      400,
      "BED_WRONG_LODGE",
    );
  }

  // Another custodian on the SAME bed on any covered night. The one-day
  // handover overlap assignments already allow is fine — but only on different
  // beds; two people cannot sleep in one bed on handover night.
  const clashingNights = await custodianHeldNightsForBed({
    bedId,
    stayDates: nights,
    excludeAssignmentId: input.assignmentId,
    db,
  });
  if (clashingNights.length > 0) {
    throw new CustodianBedHoldError(
      `That bed is already held by another hut-leader assignment on ${clashingNights.join(", ")}. A handover overlap is allowed, but only on different beds.`,
      409,
      "BED_HELD_BY_ANOTHER_CUSTODIAN",
      clashingNights,
    );
  }

  // Existing guest allocations on the bed inside the range: a HARD refusal, not
  // an eviction. Displacing a guest a human already placed is not this form's
  // decision to make — the admin clears those nights on the board first.
  const allocations = await db.bedAllocation.findMany({
    where: { bedId, stayDate: { gte: startDate, lte: endDate } },
    select: { stayDate: true },
    orderBy: { stayDate: "asc" },
  });
  if (allocations.length > 0) {
    const dates = [
      ...new Set(allocations.map((row) => formatDateOnly(row.stayDate))),
    ];
    throw new CustodianBedHoldError(
      `That bed already has guests allocated on ${dates.join(", ")}. Clear those nights on the bed allocation page first.`,
      409,
      "BED_HAS_ALLOCATIONS",
      dates,
    );
  }

  if (input.confirmOverCapacity) return;

  // Over-capacity warn-and-confirm (#1668 precedent). Holding a bed removes it
  // from the bookable pool, so on an already-full night the lodge tips over its
  // ceiling. That is legitimate — the custodian is genuinely sleeping there —
  // but the admin should see it, not discover it later.
  const capacity = await getLodgeCapacity(lodgeId, db);
  if (capacity <= 0) return;

  // THE occupancy calculation (#2681), shared with the admission engines and
  // the capacity-warnings cron, so this warning cannot drift behind them. It
  // already counts OTHER custodians already holding beds on these nights —
  // three custodians on one night is three beds, so the arithmetic is a count —
  // and `excludeCustodianAssignmentId` drops this assignment's own hold so the
  // `+ 1` below adds it exactly once. Before #2681 this loop was its own copy
  // of the calculation and did not count provisional policy-exception
  // reservations (#2525), so a bed a held request had reserved was invisible
  // and the admin was not warned that the hold tips the lodge over.
  //
  // The whole-lodge hold flag is deliberately NOT pinned here, and the reason
  // is a POLICY, not an arithmetic fact: a hold and a custodian hold do not
  // block each other in either direction (docs/CAPACITY_MODEL.md, "Whole-lodge
  // holds and custodian beds do not block each other"). Pinning would turn this
  // advisory count into a hard "lodge is full" on every held night and refuse a
  // hut leader a bed the club fully intends them to occupy.
  //
  // Do NOT restate that as "the custodian's bed is outside the held pool" — it
  // is not. `getLodgeCapacityStatus` counts every active bed, including the
  // custodian's, and `wholeLodgeHoldOccupiedBedNightsForPlanner` (#2317)
  // expands a hold across every active bed too. The consequence is a real gap,
  // stated rather than hidden: creating a custodian hold over an exclusively
  // held night raises no warning at all, because this loop compares against the
  // holding group's own headcount. Whether it should is an owner decision, not
  // something #2681 changed.
  const occupancy = await computeNightOccupancy({
    lodgeId,
    from: startDate,
    toExclusive,
    nights,
    excludeCustodianAssignmentId: input.assignmentId,
    db,
  });

  const overCapacity: CustodianOverCapacityNight[] = [];
  for (const night of nights) {
    // + 1 for the hold being created/edited.
    const occupiedBeds = occupancy(night).occupiedBeds + 1;
    if (occupiedBeds > capacity) {
      overCapacity.push({ date: formatDateOnly(night), occupiedBeds, capacity });
    }
  }
  if (overCapacity.length > 0) {
    // The figures above come from the capacity-HOLDING population only, so an
    // overridden non-holding booking (chiefly PAYMENT_PENDING, #1764/#1771) is
    // invisible to them even though the settlement carve-out will admit it onto
    // exactly these nights. Mirror #177's companion query so the confirmation
    // names it: the admin is being asked to accept an over-capacity night, and
    // must be told the true figure could be higher still. Read only when we are
    // about to ask — an ordinary within-capacity hold pays nothing for this.
    const nonHoldingBookings = await findOverlappingOverriddenNonHoldingBookings(
      db,
      { lodgeId, checkIn: startDate, checkOut: toExclusive },
    );
    throw new CustodianOverCapacityConfirmationRequiredError(
      overCapacity,
      nonHoldingBookings.map((booking) => ({
        id: booking.id,
        memberName: booking.memberName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guestCount: booking.guestCount,
        status: booking.status,
      })),
    );
  }
}

/**
 * Per-bed availability for the Hut Leaders bed picker, over the assignment's
 * own inclusive night range.
 *
 * Every active bed at the lodge is returned with the reason it cannot be picked
 * (if any), rather than filtering the unavailable ones out: an admin who cannot
 * see why "Bunk 3" is missing has no way to fix it.
 */
export interface CustodianBedOption {
  bedId: string;
  bedName: string;
  bedType: string;
  roomId: string;
  roomName: string;
  available: boolean;
  /** Nights blocked by an existing guest allocation. */
  allocatedNights: string[];
  /** Nights blocked by another custodian's hold on this same bed. */
  custodianHeldNights: string[];
  /** Set when THIS assignment already holds the bed (so it stays selectable). */
  heldByThisAssignment: boolean;
}

export async function listCustodianBedOptions(input: {
  lodgeId: string;
  startDate: Date;
  endDate: Date;
  assignmentId?: string;
  db?: CustodianAssignmentDb;
}): Promise<CustodianBedOption[]> {
  const db = input.db ?? prisma;
  const nights = custodianAssignmentNights(input.startDate, input.endDate);
  const nightKeys = new Set(nights.map(formatDateOnly));
  const toExclusive = addDaysDateOnly(input.endDate, 1);

  const rooms = await db.lodgeRoom.findMany({
    where: { active: true, ...lodgeNullTolerantScope(input.lodgeId) },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      beds: {
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, bedType: true },
      },
    },
  });

  const bedIds = rooms.flatMap((room) => room.beds.map((bed) => bed.id));
  if (bedIds.length === 0) return [];

  const [allocations, holds] = await Promise.all([
    db.bedAllocation.findMany({
      where: {
        bedId: { in: bedIds },
        stayDate: { gte: input.startDate, lte: input.endDate },
      },
      select: { bedId: true, stayDate: true },
    }),
    findCustodianBedHolds({
      lodgeId: input.lodgeId,
      from: input.startDate,
      toExclusive,
      db,
    }),
  ]);

  const allocatedByBed = new Map<string, Set<string>>();
  for (const row of allocations) {
    const key = formatDateOnly(row.stayDate);
    if (!nightKeys.has(key)) continue;
    const set = allocatedByBed.get(row.bedId) ?? new Set<string>();
    set.add(key);
    allocatedByBed.set(row.bedId, set);
  }

  const heldByBed = new Map<string, Set<string>>();
  const ownBedIds = new Set<string>();
  for (const hold of holds) {
    if (input.assignmentId && hold.assignmentId === input.assignmentId) {
      ownBedIds.add(hold.bedId);
      continue;
    }
    const set = heldByBed.get(hold.bedId) ?? new Set<string>();
    for (const key of nightKeys) {
      if (hold.startDate <= key && key <= hold.endDate) set.add(key);
    }
    if (set.size > 0) heldByBed.set(hold.bedId, set);
  }

  const options: CustodianBedOption[] = [];
  for (const room of rooms) {
    for (const bed of room.beds) {
      const allocatedNights = [...(allocatedByBed.get(bed.id) ?? [])].sort();
      const custodianHeldNights = [...(heldByBed.get(bed.id) ?? [])].sort();
      options.push({
        bedId: bed.id,
        bedName: bed.name,
        bedType: bed.bedType,
        roomId: room.id,
        roomName: room.name,
        available:
          allocatedNights.length === 0 && custodianHeldNights.length === 0,
        allocatedNights,
        custodianHeldNights,
        heldByThisAssignment: ownBedIds.has(bed.id),
      });
    }
  }
  return options;
}
