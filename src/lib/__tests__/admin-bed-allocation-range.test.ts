import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn(),
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));

import {
  BedAllocationAdminError,
  MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS,
  assignBedRange,
  manuallyAllocateBed,
  summariseNightRuns,
} from "@/lib/admin-bed-allocation";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";

/*
 * Range assignment (#2251). The board's own 31-night window is irrelevant here:
 * these exercise the WRITE path, which is atomic across a range of any length,
 * refuses in three distinct categories, and only ever writes a subset when the
 * caller explicitly opted in (freeNightsOnly).
 */

function buildGuest(
  overrides: Partial<{
    id: string;
    bookingId: string;
    stayStart: string;
    stayEnd: string;
    memberId: string | null;
    bookingStatus: string;
    wholeLodgeHold: boolean;
    lodgeId: string | null;
  }> = {},
) {
  return {
    id: overrides.id ?? "guest-1",
    bookingId: overrides.bookingId ?? "booking-1",
    firstName: "Range",
    lastName: "Guest",
    stayStart: parseDateOnly(overrides.stayStart ?? "2026-06-01"),
    stayEnd: parseDateOnly(overrides.stayEnd ?? "2026-06-06"),
    memberId: overrides.memberId ?? null,
    booking: {
      id: overrides.bookingId ?? "booking-1",
      status: overrides.bookingStatus ?? "CONFIRMED",
      deletedAt: null,
      lodgeId: overrides.lodgeId ?? "lodge-1",
      wholeLodgeHold: overrides.wholeLodgeHold ?? false,
    },
  };
}

function buildBed(
  overrides: Partial<{ id: string; bedType: string; lodgeId: string | null }> = {},
) {
  return {
    id: overrides.id ?? "bed-1",
    roomId: "room-1",
    name: "Bed One",
    active: true,
    bedType: overrides.bedType ?? "SINGLE",
    room: {
      id: "room-1",
      name: "Room One",
      active: true,
      lodgeId: overrides.lodgeId ?? "lodge-1",
    },
  };
}

function occupant(
  stayDate: string,
  overrides: Partial<{
    status: string;
    isSecondOccupant: boolean;
    memberId: string | null;
  }> = {},
) {
  return {
    stayDate: parseDateOnly(stayDate),
    isSecondOccupant: overrides.isSecondOccupant ?? false,
    bookingGuest: {
      memberId: overrides.memberId ?? null,
      firstName: "Other",
      lastName: "Guest",
      booking: {
        id: "booking-other",
        status: overrides.status ?? "CONFIRMED",
        originBookingRequest: null,
        adminCapacityHoldAt: null,
        member: {
          firstName: "Other",
          lastName: "Member",
          email: "other@example.com",
        },
      },
    },
  };
}

function buildDb(input: {
  guest?: ReturnType<typeof buildGuest> | null;
  bed?: ReturnType<typeof buildBed> | null;
  occupants?: ReturnType<typeof occupant>[];
  existingRows?: Array<{
    id: string;
    bedId: string;
    stayDate: Date;
    isSecondOccupant: boolean;
  }>;
  holds?: Array<{ id: string; checkIn: string; checkOut: string }>;
  ownBookingMemberName?: string;
}) {
  const createMany = vi.fn().mockResolvedValue({ count: 0 });
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  // findMany is used for both the occupant scan (has a bedId filter) and the
  // guest's own existing rows (filtered by bookingGuestId).
  const bedAllocationFindMany = vi.fn(
    async (args: { where: Record<string, unknown> }) => {
      if ("bedId" in args.where) return input.occupants ?? [];
      return input.existingRows ?? [];
    },
  );

  const db = {
    bookingGuest: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          input.guest === undefined ? buildGuest() : input.guest,
        ),
    },
    lodgeBed: {
      findUnique: vi
        .fn()
        .mockResolvedValue(input.bed === undefined ? buildBed() : input.bed),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue(
        (input.holds ?? []).map((hold) => ({
          id: hold.id,
          checkIn: parseDateOnly(hold.checkIn),
          checkOut: parseDateOnly(hold.checkOut),
          member: {
            firstName: "Hold",
            lastName: "Member",
            email: "hold@example.com",
          },
        })),
      ),
      findUnique: vi.fn().mockResolvedValue({
        member: {
          firstName: input.ownBookingMemberName ?? "Own",
          lastName: "Member",
          email: "own@example.com",
        },
      }),
    },
    bedAllocation: {
      findMany: bedAllocationFindMany,
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      createMany,
      updateMany,
    },
  };

  return { db, createMany, updateMany };
}

describe("assignBedRange", () => {
  it("writes every night of a long range in one pass, auto-approved", async () => {
    const { db, createMany, updateMany } = buildDb({
      guest: buildGuest({ stayStart: "2026-06-01", stayEnd: "2026-09-01" }),
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-09-01",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(true);
    expect(result.refusals).toEqual([]);
    // 92 nights — nearly three times the board's read window, written at once.
    expect(result.writtenNights).toHaveLength(92);
    expect(result.writtenNights[0]).toBe("2026-06-01");
    expect(result.writtenNights.at(-1)).toBe("2026-08-31");
    // Batched: one createMany for the whole range, not one write per night.
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();

    const rows = createMany.mock.calls[0][0].data as Array<{
      approvedAt: Date | null;
      approvedByMemberId: string | null;
      source: string;
    }>;
    expect(rows).toHaveLength(92);
    // AUTO-APPROVE (owner decision, 28 Jul 2026).
    expect(rows.every((row) => row.approvedAt instanceof Date)).toBe(true);
    expect(rows.every((row) => row.approvedByMemberId === "admin-1")).toBe(true);
    expect(rows.every((row) => row.source === "MANUAL")).toBe(true);
  });

  it("refuses the WHOLE range and writes nothing when one night's bed is taken", async () => {
    const { db, createMany, updateMany } = buildDb({
      occupants: [occupant("2026-06-03")],
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(result.writtenNights).toEqual([]);
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(result.refusals).toEqual([
      {
        stayDate: "2026-06-03",
        category: "BED_TAKEN",
        occupiedBy: {
          guestName: "Other Guest",
          memberName: "Other Member",
          bookingId: "booking-other",
          holdsCapacity: true,
        },
      },
    ]);
    // The four other nights are free and can be offered as the second action.
    expect(result.freeNights).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-04",
      "2026-06-05",
    ]);
  });

  it("counts a provisional occupant as a conflict, flagged as not holding", async () => {
    const { db } = buildDb({
      occupants: [occupant("2026-06-02", { status: "PAYMENT_PENDING" })],
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(result.refusals[0].category).toBe("BED_TAKEN");
    // Provisional: it does not hold the night, but nothing is overwritten.
    expect(result.refusals[0].occupiedBy?.holdsCapacity).toBe(false);
  });

  it("reports nights the guest is not booked as their own category, never skipped", async () => {
    const { db, createMany } = buildDb({
      guest: buildGuest({ stayStart: "2026-06-01", stayEnd: "2026-06-04" }),
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(createMany).not.toHaveBeenCalled();
    expect(result.refusals).toEqual([
      { stayDate: "2026-06-04", category: "GUEST_NOT_BOOKED" },
      { stayDate: "2026-06-05", category: "GUEST_NOT_BOOKED" },
    ]);
  });

  it("reports another booking's whole-lodge hold as its own category (ADR-001)", async () => {
    const { db } = buildDb({
      holds: [{ id: "booking-hold", checkIn: "2026-06-03", checkOut: "2026-06-05" }],
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(result.refusals).toEqual([
      {
        stayDate: "2026-06-03",
        category: "EXCLUSIVE_HOLD",
        hold: {
          bookingId: "booking-hold",
          memberName: "Hold Member",
          ownBooking: false,
        },
      },
      {
        stayDate: "2026-06-04",
        category: "EXCLUSIVE_HOLD",
        hold: {
          bookingId: "booking-hold",
          memberName: "Hold Member",
          ownBooking: false,
        },
      },
    ]);
    expect(result.freeNights).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-05",
    ]);
  });

  it("refuses every night when the guest's OWN booking holds the whole lodge", async () => {
    const { db, createMany } = buildDb({
      guest: buildGuest({ wholeLodgeHold: true }),
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(createMany).not.toHaveBeenCalled();
    expect(result.refusals).toHaveLength(5);
    expect(
      result.refusals.every(
        (refusal) =>
          refusal.category === "EXCLUSIVE_HOLD" &&
          refusal.hold?.ownBooking === true,
      ),
    ).toBe(true);
    // Nothing is free, so the "assign the free nights" action has nothing to do.
    expect(result.freeNights).toEqual([]);
  });

  it("writes only the free nights when the admin explicitly opts in, and still reports the refusals", async () => {
    const { db, createMany } = buildDb({
      occupants: [occupant("2026-06-03")],
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      freeNightsOnly: true,
      db: db as never,
    });

    expect(result.applied).toBe(true);
    expect(result.freeNightsOnly).toBe(true);
    expect(result.writtenNights).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-04",
      "2026-06-05",
    ]);
    // The refusal is still carried, so one audit entry records both halves.
    expect(result.refusals).toHaveLength(1);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toHaveLength(4);
  });

  it("moves the guest off an old bed and promotes the partner stranded there", async () => {
    const { db, updateMany, createMany } = buildDb({
      existingRows: [
        {
          id: "allocation-1",
          bedId: "bed-old",
          stayDate: parseDateOnly("2026-06-02"),
          isSecondOccupant: false,
        },
      ],
    });
    db.bedAllocation.findFirst = vi.fn().mockResolvedValue({
      id: "partner-1",
      isSecondOccupant: true,
      bedId: "bed-old",
    });
    db.bedAllocation.update = vi
      .fn()
      .mockResolvedValue({ id: "partner-1", isSecondOccupant: false });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(true);
    // One night already existed (moved via updateMany), four are new.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where.id.in).toEqual(["allocation-1"]);
    expect(createMany.mock.calls[0][0].data).toHaveLength(4);
    expect(result.promotedPartners).toEqual([
      { id: "partner-1", isSecondOccupant: false },
    ]);
  });

  it("refuses a range over the assignment cap rather than truncating it", async () => {
    const { db, createMany } = buildDb({
      guest: buildGuest({ stayStart: "2026-01-01", stayEnd: "2028-01-01" }),
    });

    await expect(
      assignBedRange({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        from: "2026-01-01",
        to: "2027-06-01",
        approvedByMemberId: "admin-1",
        db: db as never,
      }),
    ).rejects.toThrow(
      `A range assignment covers at most ${MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS} nights`,
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it("rejects a range whose date out is not after its date in", async () => {
    const { db } = buildDb({});

    await expect(
      assignBedRange({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        from: "2026-06-06",
        to: "2026-06-06",
        approvedByMemberId: "admin-1",
        db: db as never,
      }),
    ).rejects.toThrow(BedAllocationAdminError);
  });

  it("allows a partner to share a double across the range as a second occupant", async () => {
    const { db, createMany } = buildDb({
      guest: buildGuest({ memberId: "member-b" }),
      bed: buildBed({ bedType: "DOUBLE" }),
      occupants: [
        occupant("2026-06-01", { memberId: "member-a" }),
        occupant("2026-06-02", { memberId: "member-a" }),
      ],
    });
    // mayShareDoubleBed's seams: both adults, with a confirmed partner link.
    (db as unknown as Record<string, unknown>).member = {
      findMany: vi.fn().mockResolvedValue([
        { id: "member-a", ageTier: "ADULT", active: true },
        { id: "member-b", ageTier: "ADULT", active: true },
      ]),
    };
    (db as unknown as Record<string, unknown>).memberPartnerLink = {
      findUnique: vi.fn().mockResolvedValue({ status: "CONFIRMED" }),
    };

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(true);
    expect(result.refusals).toEqual([]);
    // Two batches: the shared nights as second occupant, the rest as primary.
    const written = createMany.mock.calls.flatMap(
      (call) =>
        call[0].data as Array<{ stayDate: Date; isSecondOccupant: boolean }>,
    );
    const shared = written
      .filter((row) => row.isSecondOccupant)
      .map((row) => formatDateOnly(row.stayDate))
      .sort();
    expect(shared).toEqual(["2026-06-01", "2026-06-02"]);
    expect(written).toHaveLength(5);
  });
});

describe("whole-lodge holds at the manual write chokepoint", () => {
  it("refuses a single-night manual allocation on a held booking (ADR-001, #2285)", async () => {
    const { db } = buildDb({ guest: buildGuest({ wholeLodgeHold: true }) });

    await expect(
      manuallyAllocateBed({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDate: "2026-06-02",
        db: db as never,
      }),
    ).rejects.toThrow("holds the whole lodge");
  });
});

describe("summariseNightRuns", () => {
  it("collapses contiguous nights into readable runs", () => {
    expect(
      summariseNightRuns([
        "2026-06-01",
        "2026-06-02",
        "2026-06-03",
        "2026-06-05",
        "2026-06-30",
        "2026-07-01",
      ]),
    ).toEqual(["2026-06-01 → 2026-06-03", "2026-06-05", "2026-06-30 → 2026-07-01"]);
  });

  it("returns nothing for an empty night list", () => {
    expect(summariseNightRuns([])).toEqual([]);
  });
});
