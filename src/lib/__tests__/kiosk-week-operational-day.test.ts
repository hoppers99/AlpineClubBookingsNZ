/**
 * #2631 — the kiosk week strip answers ONE question about who is in the lodge.
 *
 * THE ORIGINAL COMPLAINT, at route level. On a changeover morning the week
 * endpoint returned `guestCount: 4`, `departingCount: 4` and
 * `rosterStatus: "no-guests"` in the same response: the counts came from the
 * checkout-inclusive lodge list and the colour came from the night model, and
 * no test in the suite could see the contradiction because nothing asserted the
 * two together.
 *
 * Kept at unit level on purpose: `docs/END_TO_END_TEST_MATRIX.md` records kiosk
 * week coverage as deliberately unit-level plus manual screenshots, so this is
 * a Vitest route test rather than a new Playwright spec.
 *
 * Frozen clock discipline: every fixture is anchored to 2026-07-01T00:00:00Z,
 * never the real calendar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const lodgeAuthMocks = vi.hoisted(() => ({
  checkLodgeAuth: vi.fn(),
  resolveKioskLodgeId: vi.fn(),
}));
vi.mock("@/lib/lodge-auth", () => ({
  checkLodgeAuth: lodgeAuthMocks.checkLodgeAuth,
  resolveKioskLodgeId: lodgeAuthMocks.resolveKioskLodgeId,
  kioskLodgeAuthErrorResponse: vi.fn(() => null),
}));

// The frozen anchor. Week 1 = 2026-07-01 .. 2026-07-07.
const WEEK_START = "2026-07-01";

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

type WeekDay = {
  date: string;
  accessible: boolean;
  guestCount?: number;
  arrivingCount?: number;
  departingCount?: number;
  rosterStatus?: string;
};

async function week(start = WEEK_START): Promise<WeekDay[]> {
  const { GET } = await import("@/app/api/lodge/week/route");
  const url = `http://localhost/api/lodge/week?start=${start}`;
  const response = await GET({
    url,
    nextUrl: new URL(url),
  } as never);
  expect(response.status).toBe(200);
  return (await response.json()).days as WeekDay[];
}

function dayOf(days: WeekDay[], date: string): WeekDay {
  const found = days.find((entry) => entry.date === date);
  if (!found) throw new Error(`no day ${date} in the week payload`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "hut-leader" });
  lodgeAuthMocks.resolveKioskLodgeId.mockResolvedValue("lodge-1");
  mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
});

describe("GET /api/lodge/week — the changeover morning (#2631)", () => {
  it("a departure-only day reports guests, an equal departing count, and a rosterable status", async () => {
    // Four people, last night 2 July, all gone by midday on the 3rd. On the
    // 3rd the lodge needs its beds stripped and its kitchen shut down.
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: day("2026-07-02"),
        checkOut: day("2026-07-03"),
        guests: Array.from({ length: 4 }, () => ({
          stayStart: day("2026-07-02"),
          stayEnd: day("2026-07-03"),
          ageTier: "ADULT",
          nights: [{ stayDate: day("2026-07-02") }],
        })),
      },
    ]);

    const days = await week();
    const changeover = dayOf(days, "2026-07-03");

    expect(changeover.guestCount).toBe(4);
    expect(changeover.departingCount).toBe(4);
    expect(changeover.arrivingCount).toBe(0);
    // The payload that started this issue said "no-guests" right here.
    expect(changeover.rosterStatus).toBe("needs-roster");
  });

  it("guest count and roster status can never disagree, on any day of the week", async () => {
    // A mixed week: a stay over the 2nd–3rd, an arrival on the 5th, and a gap.
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: day("2026-07-02"),
        checkOut: day("2026-07-04"),
        guests: [
          {
            stayStart: day("2026-07-02"),
            stayEnd: day("2026-07-04"),
            ageTier: "ADULT",
            nights: [{ stayDate: day("2026-07-02") }, { stayDate: day("2026-07-03") }],
          },
        ],
      },
      {
        id: "booking-2",
        checkIn: day("2026-07-05"),
        checkOut: day("2026-07-06"),
        guests: [
          {
            stayStart: day("2026-07-05"),
            stayEnd: day("2026-07-06"),
            ageTier: "ADULT",
            nights: [{ stayDate: day("2026-07-05") }],
          },
        ],
      },
    ]);

    const days = await week();

    // THE INVARIANT, checked on every date: the count and the colour come from
    // one candidate set, so "somebody is here" and "there is somebody to
    // roster" are the same statement.
    for (const entry of days) {
      expect(
        (entry.guestCount ?? 0) > 0,
        `${entry.date}: guestCount ${entry.guestCount} vs status ${entry.rosterStatus}`,
      ).toBe(entry.rosterStatus !== "no-guests");
      // Arriving and departing are halves of the same presence, never extra
      // people bolted on beside it.
      expect((entry.arrivingCount ?? 0) + (entry.departingCount ?? 0)).toBeLessThanOrEqual(
        entry.guestCount ?? 0,
      );
    }

    expect(dayOf(days, "2026-07-01").guestCount).toBe(0);
    expect(dayOf(days, "2026-07-02").arrivingCount).toBe(1);
    expect(dayOf(days, "2026-07-04").departingCount).toBe(1);
    expect(dayOf(days, "2026-07-04").guestCount).toBe(1);
    expect(dayOf(days, "2026-07-05").arrivingCount).toBe(1);
    expect(dayOf(days, "2026-07-07").guestCount).toBe(0);
  });

  it("a sparse stay leaves its gap day empty at every count on the strip", async () => {
    // THE NIGHTS REGRESSION TRAP. Nights 2 and 5 only: present 2, 3, 5, 6.
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: day("2026-07-02"),
        checkOut: day("2026-07-06"),
        guests: [
          {
            stayStart: day("2026-07-02"),
            stayEnd: day("2026-07-06"),
            ageTier: "ADULT",
            nights: [{ stayDate: day("2026-07-02") }, { stayDate: day("2026-07-05") }],
          },
        ],
      },
    ]);

    const days = await week();
    expect(days.map((entry) => entry.guestCount)).toEqual([0, 1, 1, 0, 1, 1, 0]);
    expect(days.map((entry) => entry.rosterStatus)).toEqual([
      "no-guests",
      "needs-roster",
      "needs-roster",
      "no-guests", // the gap day: adjacent to no booked night
      "needs-roster",
      "needs-roster",
      "no-guests",
    ]);
    // Each segment gets its own arrival and its own departure morning.
    expect(days.map((entry) => entry.arrivingCount)).toEqual([0, 1, 0, 0, 1, 0, 0]);
    expect(days.map((entry) => entry.departingCount)).toEqual([0, 0, 1, 0, 0, 1, 0]);
  });

  it("MUTATION PROBE: the week query is checkout-inclusive and loads the night rows", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);
    await week();

    const args = mockPrisma.booking.findMany.mock.calls[0][0];
    // A booking whose last night was 30 June has people here on 1 July.
    expect(args.where.checkOut).toEqual({ gte: day("2026-07-01") });
    expect(args.where.guests.some.stayEnd).toEqual({ gte: day("2026-07-01") });
    expect(args.select.guests.select.nights).toEqual({
      select: { stayDate: true },
    });
  });
});
