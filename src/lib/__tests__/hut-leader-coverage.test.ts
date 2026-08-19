import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  coverageSpansMultipleLodges,
  getUnassignedHutLeaderDates,
} from "@/lib/hut-leader-coverage";

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Lodge names, so a row's `lodgeName` and the name ordering can be asserted. */
const LODGE_NAMES: Record<string, string> = {
  "lodge-a": "Alpine Lodge",
  "lodge-b": "Basin Lodge",
  "lodge-z": "Zenith Lodge",
};

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
        (options.bookings ?? []).map((booking) => {
          const lodgeId = booking.lodgeId ?? "lodge-a";
          return {
            lodge: { name: LODGE_NAMES[lodgeId] ?? lodgeId },
            ...booking,
            lodgeId,
          };
        }),
      ),
    },
    hutLeaderAssignment: {
      findMany: vi.fn().mockResolvedValue(
        (options.assignments ?? []).map((assignment) => ({ lodgeId: "lodge-a", ...assignment })),
      ),
    },
  };
}

/**
 * The expected shape of one uncovered lodge-night (#2917): the row names WHICH
 * lodge is uncovered, so a night can appear more than once.
 */
function uncovered(
  date: string,
  bookingCount: number,
  guestCount: number,
  lodgeId = "lodge-a",
) {
  return {
    date,
    lodgeId,
    lodgeName: LODGE_NAMES[lodgeId],
    bookingCount,
    guestCount,
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
    ).resolves.toEqual([uncovered("2026-04-15", 1, 2)]);
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
      uncovered("2026-03-05", 1, 2),
      uncovered("2026-03-20", 1, 1),
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
    ).resolves.toEqual([uncovered("2026-04-15", 1, 2)]);
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

    expect(result).toEqual([uncovered("2026-08-10", 1, 2, "lodge-b")]);
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
      uncovered("2026-08-10", 1, 2),
      uncovered("2026-08-11", 1, 1),
      uncovered("2026-08-12", 1, 2),
    ]);
  });

  /**
   * Per-lodge coverage semantics (#2917), the read side of the per-lodge
   * auto-assign cron shipped by #2915/PR #2916.
   */
  describe("one row per uncovered lodge-night", () => {
    it("reports the SAME night twice when two lodges are both uncovered, with each lodge's own counts", async () => {
      const night = dateOnly("2026-08-10");
      const result = await getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({
          bookings: [
            {
              lodgeId: "lodge-a",
              checkIn: night,
              checkOut: dateOnly("2026-08-11"),
              guests: [{}],
            },
            {
              lodgeId: "lodge-b",
              checkIn: night,
              checkOut: dateOnly("2026-08-11"),
              guests: [{}, {}, {}],
            },
          ],
        }),
        from: night,
        to: night,
      });

      // Before #2917 this was ONE row reading {bookingCount: 2, guestCount: 4} —
      // a number an officer could not act on, because it never said where.
      expect(result).toEqual([
        uncovered("2026-08-10", 1, 1, "lodge-a"),
        uncovered("2026-08-10", 1, 3, "lodge-b"),
      ]);
    });

    it("orders deterministically by date, then by lodge name", async () => {
      const night = dateOnly("2026-08-10");
      const laterNight = dateOnly("2026-08-11");
      const result = await getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({
          // Deliberately returned in reverse-name order: the sort, not the
          // query, is what makes the response stable.
          bookings: [
            {
              lodgeId: "lodge-z",
              checkIn: night,
              checkOut: dateOnly("2026-08-12"),
              guests: [{}],
            },
            {
              lodgeId: "lodge-b",
              checkIn: night,
              checkOut: dateOnly("2026-08-12"),
              guests: [{}],
            },
            {
              lodgeId: "lodge-a",
              checkIn: night,
              checkOut: dateOnly("2026-08-12"),
              guests: [{}],
            },
          ],
        }),
        from: night,
        to: laterNight,
      });

      expect(result.map((row) => [row.date, row.lodgeName])).toEqual([
        ["2026-08-10", "Alpine Lodge"],
        ["2026-08-10", "Basin Lodge"],
        ["2026-08-10", "Zenith Lodge"],
        ["2026-08-11", "Alpine Lodge"],
        ["2026-08-11", "Basin Lodge"],
        ["2026-08-11", "Zenith Lodge"],
      ]);
    });

    it("groups every uncovered booking at one lodge into that lodge's single row", async () => {
      const night = dateOnly("2026-08-10");
      const result = await getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({
          bookings: [
            {
              lodgeId: "lodge-a",
              checkIn: night,
              checkOut: dateOnly("2026-08-11"),
              guests: [{}, {}],
            },
            {
              lodgeId: "lodge-a",
              checkIn: night,
              checkOut: dateOnly("2026-08-11"),
              guests: [{}],
            },
          ],
        }),
        from: night,
        to: night,
      });

      expect(result).toEqual([uncovered("2026-08-10", 2, 3)]);
    });

    it("A SINGLE-LODGE CLUB IS UNCHANGED: same nights, same counts as before #2917", async () => {
      // The pre-#2917 expectation, copied verbatim from the club-wide result
      // this function used to return for exactly this fixture. Only the two
      // lodge fields are new; every date and count is identical, and the row
      // count is identical, so no single-lodge club's badge, tile or officer
      // card can move.
      const legacyRows = [
        { date: "2026-08-10", bookingCount: 2, guestCount: 3 },
        { date: "2026-08-11", bookingCount: 1, guestCount: 1 },
        // 08-12 has a leader; 08-13 has a booking with no guests.
      ];

      const result = await getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({
          bookings: [
            {
              checkIn: dateOnly("2026-08-10"),
              checkOut: dateOnly("2026-08-11"),
              guests: [{}, {}],
            },
            {
              checkIn: dateOnly("2026-08-10"),
              checkOut: dateOnly("2026-08-13"),
              guests: [{}],
            },
            {
              checkIn: dateOnly("2026-08-13"),
              checkOut: dateOnly("2026-08-14"),
              guests: [],
            },
          ],
          assignments: [
            { startDate: dateOnly("2026-08-12"), endDate: dateOnly("2026-08-12") },
          ],
        }),
        from: dateOnly("2026-08-10"),
        to: dateOnly("2026-08-13"),
      });

      expect(
        result.map(({ date, bookingCount, guestCount }) => ({
          date,
          bookingCount,
          guestCount,
        })),
      ).toEqual(legacyRows);
      // …and every row names the club's only lodge, so a caller never has to
      // guess which lodge a bare date meant.
      expect(result.every((row) => row.lodgeId === "lodge-a")).toBe(true);
    });

    it("reports only ACTIVE lodges on a club-wide read, and does not re-filter a lodge-scoped one", async () => {
      // An archived lodge can never be covered — the auto-assign cron iterates
      // active lodges only (#2915) and the admin workspace cannot select an
      // archived one — so a club-wide amber row for it would be unactionable.
      const clubWide = buildDb({});
      await getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: clubWide,
        from: dateOnly("2026-08-10"),
        to: dateOnly("2026-08-10"),
      });
      expect(clubWide.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ lodge: { active: true } }),
        }),
      );

      const oneLodge = buildDb({});
      await getUnassignedHutLeaderDates({
        scope: { kind: "lodge", lodgeId: "lodge-b" },
        db: oneLodge,
        from: dateOnly("2026-08-10"),
        to: dateOnly("2026-08-10"),
      });
      const [[lodgeScopedArgs]] = oneLodge.booking.findMany.mock.calls as [
        [{ where: Record<string, unknown> }],
      ];
      expect(lodgeScopedArgs.where.lodgeId).toBe("lodge-b");
      expect(lodgeScopedArgs.where.lodge).toBeUndefined();
    });
  });
});

describe("coverageSpansMultipleLodges", () => {
  it("is false for an empty or single-lodge result and true once a second lodge appears", () => {
    expect(coverageSpansMultipleLodges([])).toBe(false);
    expect(
      coverageSpansMultipleLodges([
        uncovered("2026-08-10", 1, 1),
        uncovered("2026-08-11", 1, 1),
      ]),
    ).toBe(false);
    expect(
      coverageSpansMultipleLodges([
        uncovered("2026-08-10", 1, 1),
        uncovered("2026-08-10", 1, 1, "lodge-b"),
      ]),
    ).toBe(true);
  });
});
