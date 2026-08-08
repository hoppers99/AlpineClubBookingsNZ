import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly, formatDateOnly } from "@/lib/date-only";

/**
 * The capacity-warnings cron and the admission engines must agree about how
 * many beds are occupied on a night (#2681).
 *
 * Until #2681 they did not. The cron computed occupancy itself and was three
 * terms behind `capacity.ts`:
 *
 *  1. **Policy-exception reservations (#2525)** — never counted, so beds a HELD
 *     exception request had provisionally reserved were invisible and the cron
 *     UNDER-reported occupancy on those nights.
 *  2. **Whole-lodge holds (ADR-001, #118)** — no pin, so a lodge under an
 *     exclusive hold reported only the holding group's own headcount and never
 *     triggered a fullness warning.
 *  3. **Explicit guest nights (#713)** — the cron loaded `guests: true` rather
 *     than `guests: { include: { nights: true } }`, so a sparse, non-contiguous
 *     stay fell back to its `stayStart`/`stayEnd` envelope and was counted on
 *     the gap nights the guest is not there. (This one goes the other way: the
 *     cron OVER-reported on a gap night.)
 *
 * Each `it` below drives BOTH surfaces over the SAME fixture and asserts they
 * return the same number, so the parity is what is pinned rather than a
 * hand-copied expectation. Every one of them fails against the pre-#2681 cron.
 *
 * The lodge capacity is 5 and the warn threshold is 5 beds remaining, so every
 * night in the cron's 14-day window is reported and the alert payload can be
 * read as a per-night occupancy table.
 */

const LODGE = "lodge-a";
const LODGE_CAPACITY = 5;

type FixtureGuest = {
  stayStart: Date;
  stayEnd: Date;
  nights: Array<{ stayDate: Date }>;
};
type FixtureBooking = {
  id: string;
  checkIn: Date;
  checkOut: Date;
  wholeLodgeHold: boolean;
  guests: FixtureGuest[];
};

/**
 * The booking fixture for a run. Read through a `findMany` double that HONOURS
 * `include`, so a query that does not ask for `guests.nights` does not receive
 * them — which is exactly how the pre-#2681 cron (`include: { guests: true }`)
 * lost the #713 night sets and fell back to the stay envelope.
 */
let bookingFixture: FixtureBooking[] = [];

function bookingFindManyDouble(args: {
  include?: { guests?: boolean | { include?: { nights?: boolean } } };
}) {
  const wantsNights =
    typeof args?.include?.guests === "object" &&
    args.include.guests?.include?.nights === true;
  return bookingFixture.map((booking) => ({
    ...booking,
    guests: booking.guests.map((guest) =>
      wantsNights ? guest : { stayStart: guest.stayStart, stayEnd: guest.stayEnd },
    ),
  }));
}

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  lodgeFindMany: vi.fn(),
  hutLeaderAssignmentFindMany: vi.fn(),
  reservationFindMany: vi.fn(),
  getLodgeCapacity: vi.fn(),
  sendAdminCapacityWarningAlert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: mocks.bookingFindMany },
    lodge: { findMany: mocks.lodgeFindMany },
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
    policyExceptionReservationNight: { findMany: mocks.reservationFindMany },
  },
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: mocks.getLodgeCapacity,
}));

vi.mock("@/lib/email", () => ({
  sendAdminCapacityWarningAlert: mocks.sendAdminCapacityWarningAlert,
}));

import { checkCapacity } from "@/lib/capacity";
import { checkCapacityWarnings } from "@/lib/cron-capacity-warnings";

/** The cron's own per-night occupancy table, keyed `YYYY-MM-DD`. */
async function cronOccupancyByNight(): Promise<Map<string, number>> {
  mocks.sendAdminCapacityWarningAlert.mockClear();
  await checkCapacityWarnings();

  const table = new Map<string, number>();
  for (const call of mocks.sendAdminCapacityWarningAlert.mock.calls) {
    const days = call[0] as Array<{ date: Date; occupiedBeds: number }>;
    for (const day of days) {
      table.set(formatDateOnly(day.date), day.occupiedBeds);
    }
  }
  return table;
}

/** `checkCapacity`'s occupancy for the single night starting `night`. */
async function engineOccupancyForNight(night: string): Promise<number> {
  const result = await checkCapacity(
    LODGE,
    parseDateOnly(night),
    parseDateOnly(formatDateOnly(new Date(parseDateOnly(night).getTime() + 86_400_000))),
    1,
  );
  return result.nightDetails[0].occupiedBeds;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The frozen test clock is 2026-07-01T00:00:00.000Z, which is midday on
  // 2026-07-01 in New Zealand, so the cron's window is the nights of
  // 2026-07-01 .. 2026-07-14 inclusive.
  mocks.lodgeFindMany.mockResolvedValue([{ id: LODGE, name: "Main Lodge" }]);
  mocks.getLodgeCapacity.mockResolvedValue(LODGE_CAPACITY);
  bookingFixture = [];
  mocks.bookingFindMany.mockImplementation(bookingFindManyDouble);
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.reservationFindMany.mockResolvedValue([]);
  mocks.sendAdminCapacityWarningAlert.mockResolvedValue(undefined);
});

describe("#2681 the capacity-warnings cron and checkCapacity agree on occupancy", () => {
  it("counts a HELD policy-exception reservation on both surfaces (#2525)", async () => {
    const night = "2026-07-05";
    mocks.reservationFindMany.mockResolvedValue([
      { night: parseDateOnly(night), beds: 2 },
    ]);

    const engine = await engineOccupancyForNight(night);
    const cron = await cronOccupancyByNight();

    expect(engine).toBe(2);
    expect(cron.get(night)).toBe(engine);
  });

  it("pins a whole-lodge-held night to the lodge ceiling on both surfaces (ADR-001, #118)", async () => {
    const night = "2026-07-06";
    bookingFixture = [
      {
        id: "booking-hold",
        checkIn: parseDateOnly(night),
        checkOut: parseDateOnly("2026-07-07"),
        wholeLodgeHold: true,
        guests: [
          {
            stayStart: parseDateOnly(night),
            stayEnd: parseDateOnly("2026-07-07"),
            nights: [],
          },
        ],
      },
    ];

    const engine = await engineOccupancyForNight(night);
    const cron = await cronOccupancyByNight();

    // One guest, but the lodge is exclusively held: both surfaces report a full
    // lodge, so the cron warns rather than reading 1 of 5 beds taken.
    expect(engine).toBe(LODGE_CAPACITY);
    expect(cron.get(night)).toBe(engine);
  });

  it("respects a sparse guest's explicit night set on both surfaces (#713)", async () => {
    const gapNight = "2026-07-09";
    bookingFixture = [
      {
        id: "booking-sparse",
        checkIn: parseDateOnly("2026-07-08"),
        checkOut: parseDateOnly("2026-07-11"),
        wholeLodgeHold: false,
        guests: [
          {
            stayStart: parseDateOnly("2026-07-08"),
            stayEnd: parseDateOnly("2026-07-11"),
            // Stays the 8th and the 10th; the 9th is a genuine absence.
            nights: [
              { stayDate: parseDateOnly("2026-07-08") },
              { stayDate: parseDateOnly("2026-07-10") },
            ],
          },
        ],
      },
    ];

    const engine = await engineOccupancyForNight(gapNight);
    const cron = await cronOccupancyByNight();

    expect(engine).toBe(0);
    expect(cron.get(gapNight)).toBe(engine);
    // The nights either side are genuinely occupied, so this is not a fixture
    // that simply counts nothing anywhere.
    expect(cron.get("2026-07-08")).toBe(1);
    expect(cron.get("2026-07-10")).toBe(1);
  });

  it("still counts custodian bed holds on both surfaces (#2286, the term that did reach every surface)", async () => {
    const night = "2026-07-03";
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "assignment-1",
        memberId: "member-1",
        lodgeId: LODGE,
        bedId: "bed-1",
        startDate: parseDateOnly(night),
        endDate: parseDateOnly(night),
        member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);

    const engine = await engineOccupancyForNight(night);
    const cron = await cronOccupancyByNight();

    expect(engine).toBe(1);
    expect(cron.get(night)).toBe(engine);
  });

  it("agrees night by night when all four terms land in the same window", async () => {
    bookingFixture = [
      {
        id: "booking-hold",
        checkIn: parseDateOnly("2026-07-06"),
        checkOut: parseDateOnly("2026-07-07"),
        wholeLodgeHold: true,
        guests: [
          {
            stayStart: parseDateOnly("2026-07-06"),
            stayEnd: parseDateOnly("2026-07-07"),
            nights: [],
          },
        ],
      },
      {
        id: "booking-sparse",
        checkIn: parseDateOnly("2026-07-08"),
        checkOut: parseDateOnly("2026-07-11"),
        wholeLodgeHold: false,
        guests: [
          {
            stayStart: parseDateOnly("2026-07-08"),
            stayEnd: parseDateOnly("2026-07-11"),
            nights: [
              { stayDate: parseDateOnly("2026-07-08") },
              { stayDate: parseDateOnly("2026-07-10") },
            ],
          },
        ],
      },
    ];
    mocks.reservationFindMany.mockResolvedValue([
      { night: parseDateOnly("2026-07-05"), beds: 2 },
    ]);
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "assignment-1",
        memberId: "member-1",
        lodgeId: LODGE,
        bedId: "bed-1",
        startDate: parseDateOnly("2026-07-03"),
        endDate: parseDateOnly("2026-07-03"),
        member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);

    const cron = await cronOccupancyByNight();

    for (const night of [
      "2026-07-01",
      "2026-07-03",
      "2026-07-05",
      "2026-07-06",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-14",
    ]) {
      expect(
        cron.get(night),
        `the cron and checkCapacity must agree on ${night}`,
      ).toBe(await engineOccupancyForNight(night));
    }
  });
});
