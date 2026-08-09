/**
 * #2631 — the arrive/depart lookups must NOT be unified onto the presence rule.
 *
 * This issue converted every lodge READ surface onto one operational-day rule,
 * which makes the two lookups in `lodge-date-scoping.ts` look like stragglers.
 * They are not. They are the kiosk's WRITE path, and they answer different
 * questions on purpose:
 *
 *   findLodgeGuestForDate         (arrive) — NIGHT-only. You can be marked
 *     arrived for a night you are actually sleeping here, and no other day.
 *   findLodgeGuestDepartingOnDate (depart) — a DEPARTURE MORNING. You leave on
 *     one specific day, not on any day you happen to be in the building.
 *
 * Collapse either into `isGuestOperationallyPresentOnDay` and a guest becomes
 * markable-ARRIVED on the morning they are driving home — the operational day
 * covers both halves, and "present" cannot tell them apart. The third function
 * in that file, `validateRosterAllocationsForDate`, IS the operational-day
 * question ("was this person in the building today?") and is deliberately on
 * the shared rule; the contrast is the point.
 *
 * #2628 kept that asymmetry and fixed the one thing wrong with the depart half:
 * it was keyed `stayEnd: date`, and `stayEnd` is the morning after the LAST
 * night, so a sparse stay could only ever record its final departure. The rule
 * is now per-segment (`isGuestDepartureMorning`), which is still not presence —
 * a guest mid-stay is present and is not departing — and is unchanged for every
 * contiguous stay.
 *
 * #2737 fixed the one thing wrong with the ARRIVE half, and the asymmetry
 * survives that too. "Night-only" was true of the RULE and not of the QUERY: the
 * SQL `where` is the envelope `[stayStart, stayEnd)`, which contains a sparse
 * stay's internal gap nights, so the endpoint would accept a check-in for a
 * night the guest is at home. The lookup now loads coarse and decides in code
 * with `isGuestActiveOnNight` — the same shape depart takes — and reports the
 * gap-night refusal as its OWN outcome rather than folding it into the
 * deliberately uninformative "nothing matched" that the enforcement gates share
 * (INV-DATE-022). Both lookups are still keyed on different questions; both are
 * still not presence.
 *
 * Frozen clock discipline: fixtures are anchored to 2026-07-01T00:00:00Z.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    bookingGuest: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  findLodgeGuestDepartingOnDate,
  findLodgeGuestForDate,
} from "@/lib/lodge-date-scoping";

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

// Last night was the 3rd; they leave on the morning of the 4th.
const DEPARTURE_MORNING = day("2026-07-04");

describe("the arrive/depart asymmetry survives the operational-day unification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("arrive stays NIGHT-only: a guest is not markable-arrived on their departure morning", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);

    await findLodgeGuestForDate("guest-1", DEPARTURE_MORNING, "lodge-1");

    const { where } = mockPrisma.bookingGuest.findFirst.mock.calls[0][0];
    // Half-open, exclusive of the checkout day — the night model. If this ever
    // became `gte`, or the operational-day rule, the kiosk would let a leader
    // check in somebody who is loading the car.
    expect(where.stayEnd).toEqual({ gt: DEPARTURE_MORNING });
    expect(where.booking.checkOut).toEqual({ gt: DEPARTURE_MORNING });
  });

  it("arrive loads on the coarse envelope and decides on the night set (#2737)", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);

    await findLodgeGuestForDate("guest-1", DEPARTURE_MORNING, "lodge-1");

    const { select } = mockPrisma.bookingGuest.findFirst.mock.calls[0][0];
    // Stop loading the night rows and the rule silently degrades back to the
    // envelope, which is the gap-night hole #2737 closed.
    expect(select.nights).toEqual({ select: { stayDate: true } });
  });

  it("arrive REFUSES a night inside a sparse stay's gap, distinctly from not-found (#2737)", async () => {
    // Nights {2, 4}: the envelope is [2, 5), so the 3rd is inside the SQL
    // filter and the guest is at home. MUTATION PROBE — delete the
    // `isGuestActiveOnNight` guard in `findLodgeGuestForDate` and the gap-night
    // case below comes back `ok` with a guest attached.
    const sparse = {
      id: "guest-1",
      bookingId: "booking-1",
      firstName: "Two",
      lastName: "Segments",
      memberId: null,
      arrivedAt: null,
      departedAt: null,
      stayStart: day("2026-07-02"),
      stayEnd: day("2026-07-05"),
      nights: [{ stayDate: day("2026-07-02") }, { stayDate: day("2026-07-04") }],
      booking: {
        memberId: "member-1",
        checkIn: day("2026-07-02"),
        checkOut: day("2026-07-05"),
      },
    };
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparse);

    expect(await findLodgeGuestForDate("guest-1", day("2026-07-03"))).toEqual({
      outcome: "not-a-booked-night",
    });
    // …and the nights either side are still accepted.
    for (const bookedNight of ["2026-07-02", "2026-07-04"]) {
      expect(
        (await findLodgeGuestForDate("guest-1", day(bookedNight))).outcome,
        bookedNight,
      ).toBe("ok");
    }

    // The two refusals stay separable, which is the reason the outcome is a
    // union rather than a null: everything the enforcement gates reject is
    // filtered in SQL and must keep collapsing to one uninformative answer.
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);
    expect(await findLodgeGuestForDate("guest-1", day("2026-07-02"))).toEqual({
      outcome: "not-found",
    });
  });

  it("arrive falls back to the envelope for a guest with no night rows (#2737)", async () => {
    // Pre-#713 rows carry only the envelope, exactly as the depart case below.
    // #2737 must refuse gap nights without turning legacy guests into permanent
    // refusals — they declare no gaps, so they have none.
    mockPrisma.bookingGuest.findFirst.mockResolvedValue({
      id: "guest-1",
      bookingId: "booking-1",
      firstName: "Leg",
      lastName: "Acy",
      memberId: null,
      arrivedAt: null,
      departedAt: null,
      stayStart: day("2026-07-02"),
      stayEnd: DEPARTURE_MORNING,
      nights: [],
      booking: {
        memberId: "member-1",
        checkIn: day("2026-07-02"),
        checkOut: DEPARTURE_MORNING,
      },
    });

    expect((await findLodgeGuestForDate("guest-1", day("2026-07-03"))).outcome).toBe("ok");
    // …and still not on the departure morning. Postgres would already have
    // excluded that row (`stayEnd: { gt: date }`), so this is belt-and-braces
    // with the mock forced open: the in-code rule AGREES with the SQL filter
    // rather than widening it, which is what makes the pair safe to reason
    // about separately.
    expect(
      (await findLodgeGuestForDate("guest-1", DEPARTURE_MORNING)).outcome,
    ).toBe("not-a-booked-night");
  });

  it("depart loads on the coarse envelope and decides on the night set", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);

    await findLodgeGuestDepartingOnDate("guest-1", DEPARTURE_MORNING, "lodge-1");

    const { where, select } = mockPrisma.bookingGuest.findFirst.mock.calls[0][0];
    // #2628: the SQL half is now the coarse envelope, which must contain any
    // departure morning, and the authoritative answer comes from the loaded
    // night rows. `stayEnd: date` alone could only ever match a sparse stay's
    // FINAL departure. Both bounds are checkout-inclusive for that reason.
    expect(where.stayStart).toEqual({ lte: DEPARTURE_MORNING });
    expect(where.stayEnd).toEqual({ gte: DEPARTURE_MORNING });
    expect(where.booking.checkOut).toEqual({ gte: DEPARTURE_MORNING });
    // …and the night rows are actually loaded, or the rule silently degrades to
    // the envelope and the sparse case comes straight back.
    expect(select.nights).toEqual({ select: { stayDate: true } });
  });

  it("depart is still NOT presence: a guest mid-stay is refused", async () => {
    // The whole reason the coarse filter is not the answer. On the 3rd this
    // guest occupies both halves of the day — present, not departing — and the
    // envelope filter happily returns them. The in-code rule is what says no.
    mockPrisma.bookingGuest.findFirst.mockResolvedValue({
      id: "guest-1",
      bookingId: "booking-1",
      firstName: "Mid",
      lastName: "Stay",
      memberId: null,
      arrivedAt: null,
      departedAt: null,
      stayStart: day("2026-07-02"),
      stayEnd: DEPARTURE_MORNING,
      nights: [{ stayDate: day("2026-07-02") }, { stayDate: day("2026-07-03") }],
      booking: {
        memberId: "member-1",
        checkIn: day("2026-07-02"),
        checkOut: DEPARTURE_MORNING,
      },
    });

    expect(await findLodgeGuestDepartingOnDate("guest-1", day("2026-07-03"))).toBeNull();
    expect(await findLodgeGuestDepartingOnDate("guest-1", DEPARTURE_MORNING)).not.toBeNull();
  });

  it("depart records EACH segment of a sparse stay, not only the last (#2628)", async () => {
    // Nights {2, 4}: they leave on the morning of the 3rd, come back that
    // evening, and leave again on the 5th. Keyed on `stayEnd` the officer could
    // only ever mark the 5th, so the first departure was unrecordable.
    const sparse = {
      id: "guest-1",
      bookingId: "booking-1",
      firstName: "Two",
      lastName: "Segments",
      memberId: null,
      arrivedAt: null,
      departedAt: null,
      stayStart: day("2026-07-02"),
      stayEnd: day("2026-07-05"),
      nights: [{ stayDate: day("2026-07-02") }, { stayDate: day("2026-07-04") }],
      booking: {
        memberId: "member-1",
        checkIn: day("2026-07-02"),
        checkOut: day("2026-07-05"),
      },
    };
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparse);

    expect(await findLodgeGuestDepartingOnDate("guest-1", day("2026-07-03"))).not.toBeNull();
    expect(await findLodgeGuestDepartingOnDate("guest-1", day("2026-07-05"))).not.toBeNull();
    // …and the gap evening and each arrival night are still refused.
    expect(await findLodgeGuestDepartingOnDate("guest-1", day("2026-07-02"))).toBeNull();
    expect(await findLodgeGuestDepartingOnDate("guest-1", day("2026-07-04"))).toBeNull();
  });

  it("a guest with no night rows still departs on stayEnd and nowhere else", async () => {
    // Pre-#713 rows carry only the envelope. The helper falls back to it, so
    // the legacy case is byte-for-byte what it was before #2628.
    const legacy = {
      id: "guest-1",
      bookingId: "booking-1",
      firstName: "Leg",
      lastName: "Acy",
      memberId: null,
      arrivedAt: null,
      departedAt: null,
      stayStart: day("2026-07-02"),
      stayEnd: DEPARTURE_MORNING,
      nights: [],
      booking: {
        memberId: "member-1",
        checkIn: day("2026-07-02"),
        checkOut: DEPARTURE_MORNING,
      },
    };
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(legacy);

    expect(await findLodgeGuestDepartingOnDate("guest-1", DEPARTURE_MORNING)).not.toBeNull();
    expect(await findLodgeGuestDepartingOnDate("guest-1", day("2026-07-03"))).toBeNull();
  });

  it("SOURCE CONTRACT: neither lookup is rewritten in terms of the presence helper", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/lib/lodge-date-scoping.ts"),
      "utf8",
    );

    const arrive = source.slice(
      source.indexOf("export async function findLodgeGuestForDate("),
      source.indexOf("export async function findLodgeGuestDepartingOnDate("),
    );
    const depart = source.slice(
      source.indexOf("export async function findLodgeGuestDepartingOnDate("),
      source.indexOf("export async function validateRosterAllocationsForDate("),
    );

    for (const [name, body] of [
      ["arrive", arrive],
      ["depart", depart],
    ] as const) {
      expect(body.length, name).toBeGreaterThan(0);
      expect(body, name).not.toContain("isGuestOperationallyPresentOnDay");
      expect(body, name).not.toContain("getGuestOperationalDayPresence");
      expect(body, name).not.toContain("getOperationallyPresentGuestsForDay");
    }

    // …and each carries its own in-code night decision, not just a SQL filter.
    // MUTATION PROBE (#2737): delete either guard and this fails by name.
    expect(arrive, "arrive").toContain("isGuestActiveOnNight(");
    expect(depart, "depart").toContain("isGuestDepartureMorning(");

    // The comment explaining WHY has to stay with them: the next reader
    // tidying up "the last two night-model callers" needs to find it.
    expect(source).toContain("THE ARRIVE/DEPART ASYMMETRY IS DELIBERATE");
    expect(source).toContain("BOTH LOOKUPS NOW LOAD COARSE AND DECIDE IN CODE");

    // …and the contrast: roster validation IS on the shared rule.
    const validate = source.slice(
      source.indexOf("export async function validateRosterAllocationsForDate("),
    );
    expect(validate).toContain("isGuestOperationallyPresentOnDay");
  });
});
