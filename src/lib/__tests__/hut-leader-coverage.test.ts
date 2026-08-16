import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function buildDb(options: {
  hutLeaderLookaheadDays?: number;
  bookings?: Array<{
    lodgeId?: string | null;
    checkIn: Date;
    checkOut: Date;
    guests?: Array<{
      stayStart?: Date | null;
      stayEnd?: Date | null;
      nights?: Array<{ stayDate: Date }>;
    }>;
  }>;
  assignments?: Array<{ lodgeId?: string | null; startDate: Date; endDate: Date }>;
}) {
  return {
    lodgeSettings: {
      findUnique: vi.fn().mockResolvedValue({
        capacity: null,
        hutLeaderLookaheadDays: options.hutLeaderLookaheadDays,
      }),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue(
        (options.bookings ?? []).map((booking) => ({ lodgeId: "lodge-a", ...booking })),
      ),
    },
    hutLeaderAssignment: {
      findMany: vi.fn().mockResolvedValue(
        (options.assignments ?? []).map((assignment) => ({ lodgeId: "lodge-a", ...assignment })),
      ),
    },
  };
}

describe("getUnassignedHutLeaderDates", () => {
  it("uses the configured hut-leader lookahead when no override is supplied", async () => {
    const booking = {
      checkIn: dateOnly("2026-04-15"),
      checkOut: dateOnly("2026-04-16"),
      guests: [{}, {}],
    };
    const today = dateOnly("2026-04-10");

    await expect(
      getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({ hutLeaderLookaheadDays: 3, bookings: [booking] }),
        today,
      }),
    ).resolves.toEqual([]);

    await expect(
      getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({ hutLeaderLookaheadDays: 6, bookings: [booking] }),
        today,
      }),
    ).resolves.toEqual([
      {
        date: "2026-04-15",
        bookingCount: 1,
        guestCount: 2,
      },
    ]);
  });

  it("restricts to an explicit {from,to} window (may include past nights) and ignores the stored lookahead", async () => {
    const db = buildDb({
      hutLeaderLookaheadDays: 3,
      bookings: [
        // Occupies nights 03-05 and 03-06 (checkOut is exclusive).
        { checkIn: dateOnly("2026-03-05"), checkOut: dateOnly("2026-03-07"), guests: [{}, {}] },
        // Occupies night 03-20.
        { checkIn: dateOnly("2026-03-20"), checkOut: dateOnly("2026-03-21"), guests: [{}] },
        // Outside the window — must not appear even though the mock returns it.
        { checkIn: dateOnly("2026-04-15"), checkOut: dateOnly("2026-04-16"), guests: [{}] },
      ],
      // 03-06 already has a leader, so it is not "needs a leader".
      assignments: [{ startDate: dateOnly("2026-03-06"), endDate: dateOnly("2026-03-06") }],
    });

    const result = await getUnassignedHutLeaderDates({
      scope: { kind: "all" },
      db,
      from: dateOnly("2026-03-01"),
      to: dateOnly("2026-03-31"),
      // "today" is well after the window: a windowed call still reports history.
      today: dateOnly("2026-07-01"),
    });

    // A window skips the lookahead setting entirely.
    expect(db.lodgeSettings.findUnique).not.toHaveBeenCalled();
    expect(result).toEqual([
      { date: "2026-03-05", bookingCount: 1, guestCount: 2 },
      { date: "2026-03-20", bookingCount: 1, guestCount: 1 },
    ]);
  });

  it("ignores a partial window (only from, or only to) and falls back to the lookahead", async () => {
    const booking = {
      checkIn: dateOnly("2026-04-15"),
      checkOut: dateOnly("2026-04-16"),
      guests: [{}, {}],
    };

    await expect(
      getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({ hutLeaderLookaheadDays: 6, bookings: [booking] }),
        today: dateOnly("2026-04-10"),
        from: dateOnly("2026-03-01"),
      }),
    ).resolves.toEqual([
      { date: "2026-04-15", bookingCount: 1, guestCount: 2 },
    ]);
  });

  it("lets an explicit lookahead override the stored setting", async () => {
    const db = buildDb({
      hutLeaderLookaheadDays: 3,
      bookings: [
        {
          checkIn: dateOnly("2026-04-15"),
          checkOut: dateOnly("2026-04-16"),
          guests: [{}],
        },
      ],
    });

    const result = await getUnassignedHutLeaderDates({
      scope: { kind: "all" },
      db,
      today: dateOnly("2026-04-10"),
      lookAheadDays: 6,
    });

    expect(db.lodgeSettings.findUnique).not.toHaveBeenCalled();
    expect(result.map((item) => item.date)).toEqual(["2026-04-15"]);
  });

  it("binds both assignments and occupied bookings to the selected lodge", async () => {
    const db = buildDb({
      bookings: [
        {
          checkIn: dateOnly("2026-08-10"),
          checkOut: dateOnly("2026-08-11"),
          guests: [{}],
        },
      ],
    });

    await getUnassignedHutLeaderDates({
      scope: { kind: "lodge", lodgeId: "lodge-b" },
      db,
      from: dateOnly("2026-08-10"),
      to: dateOnly("2026-08-10"),
    });

    expect(db.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ lodgeId: "lodge-b" }) }),
    );
    expect(db.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ lodgeId: "lodge-b" }) }),
    );
  });

  it("keeps lodge identity in all-lodges coverage for the same calendar night", async () => {
    const night = dateOnly("2026-08-10");
    const result = await getUnassignedHutLeaderDates({
      scope: { kind: "all" },
      db: buildDb({
        bookings: [
          { lodgeId: "lodge-a", checkIn: night, checkOut: dateOnly("2026-08-11"), guests: [{}] },
          { lodgeId: "lodge-b", checkIn: night, checkOut: dateOnly("2026-08-11"), guests: [{}, {}] },
        ],
        assignments: [
          { lodgeId: "lodge-a", startDate: night, endDate: night },
        ],
      }),
      from: night,
      to: night,
    });

    expect(result).toEqual([
      { date: "2026-08-10", bookingCount: 1, guestCount: 2 },
    ]);
  });

  it("counts only explicit sparse guest nights and falls back only when none exist", async () => {
    const result = await getUnassignedHutLeaderDates({
      scope: { kind: "lodge", lodgeId: "lodge-a" },
      db: buildDb({
        bookings: [{
          lodgeId: "lodge-a",
          checkIn: dateOnly("2026-08-10"),
          checkOut: dateOnly("2026-08-13"),
          guests: [
            {
              stayStart: dateOnly("2026-08-10"),
              stayEnd: dateOnly("2026-08-13"),
              nights: [
                { stayDate: dateOnly("2026-08-10") },
                { stayDate: dateOnly("2026-08-12") },
              ],
            },
            {},
          ],
        }],
      }),
      from: dateOnly("2026-08-10"),
      to: dateOnly("2026-08-12"),
    });

    expect(result).toEqual([
      { date: "2026-08-10", bookingCount: 1, guestCount: 2 },
      { date: "2026-08-11", bookingCount: 1, guestCount: 1 },
      { date: "2026-08-12", bookingCount: 1, guestCount: 2 },
    ]);
  });
});
