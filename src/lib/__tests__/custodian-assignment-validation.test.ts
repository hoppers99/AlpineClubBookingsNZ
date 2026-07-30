import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

/**
 * Custodian bed hold — write-side validation (#2286).
 *
 * The hut-leaders form is where a hold is created, so this is where a bad hold
 * has to be stopped: an inactive or other-lodge bed, a bed another custodian
 * already holds on a covered night, and a bed with guests already allocated on
 * it. The last one is a HARD refusal rather than an eviction — displacing a
 * guest a human placed is not a form's decision to make.
 *
 * The over-capacity case is deliberately warn-and-confirm rather than a
 * refusal (#1668 precedent): a custodian genuinely does sleep in the lodge, so
 * a full night is legitimate — the admin just has to see it first.
 */

const mocks = vi.hoisted(() => ({
  hutLeaderAssignmentFindMany: vi.fn(),
  lodgeBedFindUnique: vi.fn(),
  bedAllocationFindMany: vi.fn(),
  bookingFindMany: vi.fn(),
  // #2286 review M5: the over-capacity confirmation ALSO reads the live
  // bookings its per-night figures cannot count (the #177 override-settle blind
  // spot). Its own spy, dispatched on the `capacityOverriddenAt` filter, so the
  // capacity-holding population stays exactly what each case sets.
  overriddenBookingFindMany: vi.fn(),
  getLodgeCapacity: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: mocks.getLodgeCapacity,
}));

import {
  custodianAssignmentNights,
  CustodianBedHoldError,
  CustodianOverCapacityConfirmationRequiredError,
  validateCustodianBedHold,
} from "@/lib/custodian-assignment";

const LODGE = "lodge-a";
const OTHER_LODGE = "lodge-b";

function db() {
  return {
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
    lodgeBed: { findUnique: mocks.lodgeBedFindUnique },
    bedAllocation: { findMany: mocks.bedAllocationFindMany },
    booking: {
      findMany: (args: { where?: Record<string, unknown> }) =>
        args?.where && "capacityOverriddenAt" in args.where
          ? mocks.overriddenBookingFindMany(args)
          : mocks.bookingFindMany(args),
    },
  } as never;
}

function bed(overrides: Partial<{ active: boolean; roomActive: boolean; lodgeId: string }> = {}) {
  return {
    id: "bed-1",
    name: "A1",
    active: overrides.active ?? true,
    room: {
      id: "room-1",
      name: "Kea",
      active: overrides.roomActive ?? true,
      lodgeId: overrides.lodgeId ?? LODGE,
    },
  };
}

function validate(overrides: Record<string, unknown> = {}) {
  return validateCustodianBedHold({
    bedId: "bed-1",
    lodgeId: LODGE,
    startDate: parseDateOnly("2026-07-02"),
    endDate: parseDateOnly("2026-07-04"),
    db: db(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lodgeBedFindUnique.mockResolvedValue(bed());
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.bedAllocationFindMany.mockResolvedValue([]);
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.overriddenBookingFindMany.mockResolvedValue([]);
  mocks.getLodgeCapacity.mockResolvedValue(10);
});

describe("custodianAssignmentNights", () => {
  it("includes the endDate night itself", () => {
    const nights = custodianAssignmentNights(
      parseDateOnly("2026-07-02"),
      parseDateOnly("2026-07-04"),
    );
    expect(nights).toHaveLength(3);
  });
});

describe("validateCustodianBedHold", () => {
  it("does nothing at all for a role-only assignment — the pre-#2286 path", async () => {
    await expect(validate({ bedId: null })).resolves.toBeUndefined();
    expect(mocks.lodgeBedFindUnique).not.toHaveBeenCalled();
  });

  it("refuses an inactive bed", async () => {
    mocks.lodgeBedFindUnique.mockResolvedValue(bed({ active: false }));
    await expect(validate()).rejects.toMatchObject({
      name: "CustodianBedHoldError",
      code: "BED_NOT_FOUND",
      status: 404,
    });
  });

  it("refuses a bed in an inactive room", async () => {
    mocks.lodgeBedFindUnique.mockResolvedValue(bed({ roomActive: false }));
    await expect(validate()).rejects.toBeInstanceOf(CustodianBedHoldError);
  });

  it("refuses a bed at another lodge, and says to clear the bed before changing lodges", async () => {
    mocks.lodgeBedFindUnique.mockResolvedValue(bed({ lodgeId: OTHER_LODGE }));
    await expect(validate()).rejects.toMatchObject({
      code: "BED_WRONG_LODGE",
      message: expect.stringContaining("Clear the bed"),
    });
  });

  it("refuses a bed another custodian already holds on a covered night — a handover overlap is allowed only on DIFFERENT beds", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "other-assignment",
        memberId: "m2",
        lodgeId: LODGE,
        bedId: "bed-1",
        startDate: parseDateOnly("2026-07-04"),
        endDate: parseDateOnly("2026-07-09"),
        member: { firstName: "Other", lastName: "Custodian", ageTier: "ADULT" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);

    await expect(validate()).rejects.toMatchObject({
      code: "BED_HELD_BY_ANOTHER_CUSTODIAN",
      nights: ["2026-07-04"],
    });
  });

  it("does not conflict with its OWN hold when the assignment is being edited", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "being-edited",
        memberId: "m1",
        lodgeId: LODGE,
        bedId: "bed-1",
        startDate: parseDateOnly("2026-07-02"),
        endDate: parseDateOnly("2026-07-04"),
        member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);

    await expect(
      validate({ assignmentId: "being-edited" }),
    ).resolves.toBeUndefined();
  });

  it("HARD refuses a bed with guests already allocated, listing the dates rather than evicting anyone", async () => {
    mocks.bedAllocationFindMany.mockResolvedValue([
      { stayDate: parseDateOnly("2026-07-03") },
    ]);

    await expect(validate()).rejects.toMatchObject({
      code: "BED_HAS_ALLOCATIONS",
      nights: ["2026-07-03"],
      message: expect.stringContaining("bed allocation page"),
    });
  });

  it("warns and asks for confirmation when the hold tips a night past capacity", async () => {
    mocks.getLodgeCapacity.mockResolvedValue(1);
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-07-02"),
        checkOut: parseDateOnly("2026-07-03"),
        guests: [
          {
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-03"),
            nights: [],
          },
        ],
      },
    ]);

    await expect(validate()).rejects.toBeInstanceOf(
      CustodianOverCapacityConfirmationRequiredError,
    );
  });

  it("names the live bookings its own figures cannot count (#177 blind spot)", async () => {
    // The per-night arithmetic uses capacityHoldingBookingFilter(), so an
    // overridden PAYMENT_PENDING booking contributes NOTHING to the number the
    // admin is asked to accept — yet the settlement carve-out will admit it onto
    // exactly these nights. A confirmation that hides it understates what is
    // being accepted.
    mocks.getLodgeCapacity.mockResolvedValue(1);
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-07-02"),
        checkOut: parseDateOnly("2026-07-03"),
        guests: [
          {
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-03"),
            nights: [],
          },
        ],
      },
    ]);
    mocks.overriddenBookingFindMany.mockResolvedValue([
      {
        id: "booking-override",
        checkIn: parseDateOnly("2026-07-03"),
        checkOut: parseDateOnly("2026-07-05"),
        status: "PAYMENT_PENDING",
        member: { firstName: "Pat", lastName: "Payer", email: "pat@x.nz" },
        _count: { guests: 3 },
      },
    ]);

    await expect(validate()).rejects.toMatchObject({
      code: "CUSTODIAN_OVER_CAPACITY_CONFIRM_REQUIRED",
      nonHoldingBookings: [
        {
          id: "booking-override",
          memberName: "Pat Payer",
          checkIn: "2026-07-03",
          checkOut: "2026-07-05",
          guestCount: 3,
          status: "PAYMENT_PENDING",
        },
      ],
    });
  });

  it("does not pay for that extra read when the hold fits inside capacity", async () => {
    // It only matters when we are ABOUT to ask, so an ordinary within-capacity
    // hold must not run the query at all.
    await expect(validate()).resolves.toBeUndefined();
    expect(mocks.overriddenBookingFindMany).not.toHaveBeenCalled();
  });

  it("proceeds once the admin confirms the override", async () => {
    mocks.getLodgeCapacity.mockResolvedValue(1);
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-07-02"),
        checkOut: parseDateOnly("2026-07-03"),
        guests: [
          {
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-03"),
            nights: [],
          },
        ],
      },
    ]);

    await expect(
      validate({ confirmOverCapacity: true }),
    ).resolves.toBeUndefined();
  });

  it("counts OTHER custodians toward the ceiling too — three custodians is three beds", async () => {
    mocks.getLodgeCapacity.mockResolvedValue(2);
    const otherHold = [
      {
        id: "other-assignment",
        memberId: "m2",
        lodgeId: LODGE,
        // A DIFFERENT bed, so it is not a same-bed clash — but it is still an
        // occupant on those nights.
        bedId: "bed-2",
        startDate: parseDateOnly("2026-07-02"),
        endDate: parseDateOnly("2026-07-04"),
        member: { firstName: "Other", lastName: "Custodian", ageTier: "ADULT" },
        bed: {
          id: "bed-2",
          name: "A2",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ];
    // The same-bed clash query filters to bed-1, so it must see nothing; the
    // lodge-wide occupancy query must see the other custodian.
    mocks.hutLeaderAssignmentFindMany.mockImplementation(
      async (args: { where: { bedId?: { in?: string[] } } }) =>
        args.where.bedId?.in ? [] : otherHold,
    );
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-07-02"),
        checkOut: parseDateOnly("2026-07-05"),
        guests: [
          {
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-05"),
            nights: [],
          },
        ],
      },
    ]);

    // 1 guest + 1 other custodian + this hold = 3 for 2 beds.
    await expect(validate()).rejects.toBeInstanceOf(
      CustodianOverCapacityConfirmationRequiredError,
    );
  });
});
