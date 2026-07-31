import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addDaysDateOnly,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  createDraftBooking: vi.fn(),
  logAudit: vi.fn(),
  resolveLinkedBookingMembers: vi.fn(),
  resolveLinkedBookingMembersWithBoundary: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  normalizeBookingGuestInputs: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    member: { findMany: vi.fn() },
    familyGroupMember: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/booking-create", () => ({
  createDraftBooking: mocks.createDraftBooking,
}));

vi.mock("@/lib/booking-guests", () => ({
  BookingGuestValidationError: class BookingGuestValidationError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
  // MG3 (#2308) C1: `markCrossFamilyGuestsOnBooking` re-derives the D-8 marker
  // over the WHOLE proposed party from this function. These fixtures are about
  // pricing/payment rather than family boundaries, and were written when every
  // member-linked guest in them was family scope, so an empty boundary states
  // that assumption explicitly. The C1 behaviour itself is covered by
  // `member-guest-cross-family-refusals.test.ts` and by the source contract in
  // `review-findings-contracts.test.ts`.
  computeMemberGuestBoundary: vi.fn().mockResolvedValue({
    scopeByMemberId: new Map(),
    beyondFamilyMemberIds: [],
  }),
  resolveLinkedBookingMembers: mocks.resolveLinkedBookingMembers,
  resolveLinkedBookingMembersWithBoundary:
    mocks.resolveLinkedBookingMembersWithBoundary,
  assertLinkedBookingMembersCanBeBooked:
    mocks.assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs: mocks.normalizeBookingGuestInputs,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

import { copyBookingToDraft } from "@/lib/admin-booking-copy";

/**
 * `copyBookingToDraft` refuses a target check-in that is already in the past,
 * comparing it against `getTodayDateOnly()` — the NZ calendar date, read from
 * the real clock. Every case below copies onto 2026-09-10, so left on the real
 * clock the whole suite would have started failing on 11 September 2026 (#2401):
 * the refusal is correct production behaviour, it is the FIXTURE that goes stale,
 * and the failure would have looked like a copy regression rather than a test
 * that outlived its dates.
 *
 * Pin the clock well before the target so the scenario under test — copying a
 * booking FORWARD onto a future date — stays the intended one for good. The
 * past-target guard keeps its own coverage in the last case below, so pinning
 * hides nothing.
 *
 * Only `Date` is faked, so real timers still run and awaited promises resolve
 * normally. 2026-07-01T00:00:00Z reads as 1 July in NZ (12:00 NZST) and in UTC
 * alike — but `APP_TIME_ZONE` falls back to `process.env.TZ`, so on a runner
 * with TZ set to a negative-offset zone the club-zone "today" under this pin is
 * 2026-06-30. Any date the assertions compare against "today" is therefore
 * DERIVED through the club timezone below rather than hardcoded, so the suite
 * holds regardless of the runner's TZ.
 */
const FIXED_NOW = new Date("2026-07-01T00:00:00.000Z"); // NZ 2026-07-01 12:00

// Club-zone boundary dates under the pin, derived the way production derives
// "today" (`getTodayDateOnly` = `formatDateOnlyForTimeZone(now)`).
const TODAY = formatDateOnlyForTimeZone(FIXED_NOW);
const YESTERDAY = formatDateOnly(addDaysDateOnly(parseDateOnly(TODAY), -1));
const TODAY_PLUS_3 = formatDateOnly(addDaysDateOnly(parseDateOnly(TODAY), 3));

function makeSourceBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-booking",
    memberId: "member-1",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-04T00:00:00.000Z"),
    deletedAt: null,
    notes: "Late arrival",
    expectedArrivalTime: "19:00",
    member: { id: "member-1", active: true },
    guests: [
      {
        id: "guest-1",
        firstName: "Nina",
        lastName: "Visitor",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: new Date("2026-08-01T00:00:00.000Z"),
        stayEnd: new Date("2026-08-03T00:00:00.000Z"),
      },
      {
        id: "guest-2",
        firstName: "Old",
        lastName: "Member",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-2",
        stayStart: new Date("2026-08-02T00:00:00.000Z"),
        stayEnd: new Date("2026-08-04T00:00:00.000Z"),
      },
    ],
    ...overrides,
  };
}

describe("copyBookingToDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    mocks.resolveLinkedBookingMembers.mockResolvedValue(
      new Map([
        [
          "member-2",
          {
            id: "member-2",
            firstName: "Current",
            lastName: "Member",
            ageTier: "YOUTH",
          },
        ],
      ]),
    );
    // MG2 (#2307): the copy uses the boundary-returning resolver so it can decide
    // each guest's consent. An empty boundary is "everybody is inside the booking
    // owner's family", which is this test's world unchanged.
    mocks.resolveLinkedBookingMembersWithBoundary.mockImplementation(
      async (...args: unknown[]) => ({
        members: await mocks.resolveLinkedBookingMembers(...args),
        boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
      }),
    );
    mocks.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
    mocks.normalizeBookingGuestInputs.mockImplementation((guests, linkedMembers) =>
      guests.map((guest: any) => {
        const linkedMember = guest.memberId
          ? linkedMembers.get(guest.memberId)
          : null;
        return linkedMember
          ? {
              ...guest,
              firstName: linkedMember.firstName,
              lastName: linkedMember.lastName,
              ageTier: linkedMember.ageTier,
              isMember: true,
            }
          : guest;
      }),
    );
    mocks.createDraftBooking.mockResolvedValue({
      id: "draft-copy",
      status: "DRAFT",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a draft copy with shifted guest ranges and recalculated creation input", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeSourceBooking());

    const result = await copyBookingToDraft({
      sourceBookingId: "source-booking",
      targetCheckIn: "2026-09-10",
      adminMemberId: "admin-1",
    });

    expect(result).toEqual({
      bookingId: "draft-copy",
      sourceBookingId: "source-booking",
      checkIn: "2026-09-10",
      checkOut: "2026-09-13",
      status: "DRAFT",
    });
    expect(mocks.createDraftBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveMemberId: "member-1",
        isOnBehalf: true,
        sessionUserId: "admin-1",
        checkIn: new Date("2026-09-10T00:00:00.000Z"),
        checkOut: new Date("2026-09-13T00:00:00.000Z"),
        notes: "Late arrival",
        expectedArrivalTime: "19:00",
      }),
    );
    const call = mocks.createDraftBooking.mock.calls[0][0];
    expect(call.guests).toEqual([
      expect.objectContaining({
        firstName: "Nina",
        lastName: "Visitor",
        ageTier: "ADULT",
        isMember: false,
        memberId: undefined,
        stayStart: new Date("2026-09-10T00:00:00.000Z"),
        stayEnd: new Date("2026-09-12T00:00:00.000Z"),
      }),
      expect.objectContaining({
        firstName: "Current",
        lastName: "Member",
        ageTier: "YOUTH",
        isMember: true,
        memberId: "member-2",
        stayStart: new Date("2026-09-11T00:00:00.000Z"),
        stayEnd: new Date("2026-09-13T00:00:00.000Z"),
      }),
    ]);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.copy.created",
        memberId: "admin-1",
        targetId: "draft-copy",
        metadata: expect.objectContaining({
          sourceBookingId: "source-booking",
          copiedBookingId: "draft-copy",
        }),
      }),
    );
  });

  it("rejects deleted source bookings", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeSourceBooking({ deletedAt: new Date("2026-08-10T00:00:00.000Z") }),
    );

    await expect(
      copyBookingToDraft({
        sourceBookingId: "source-booking",
        targetCheckIn: "2026-09-10",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      message: "Deleted bookings cannot be copied",
      status: 400,
    });
    expect(mocks.createDraftBooking).not.toHaveBeenCalled();
  });

  // The guard the clock pin above exists to keep out of the way. Stated against
  // the DERIVED club-zone "today" rather than a date that merely happens to be
  // behind the wall clock, so it asserts the boundary itself — yesterday is
  // refused, today is not — in every runner timezone.
  it("refuses a target check-in before today but allows today itself", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeSourceBooking());

    await expect(
      copyBookingToDraft({
        sourceBookingId: "source-booking",
        targetCheckIn: YESTERDAY,
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      message: "Target check-in date cannot be in the past",
      status: 400,
    });
    expect(mocks.createDraftBooking).not.toHaveBeenCalled();

    await expect(
      copyBookingToDraft({
        sourceBookingId: "source-booking",
        targetCheckIn: TODAY,
        adminMemberId: "admin-1",
      }),
    ).resolves.toMatchObject({ checkIn: TODAY, checkOut: TODAY_PLUS_3 });
  });
});
