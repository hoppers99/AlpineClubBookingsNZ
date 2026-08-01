import { beforeEach, describe, expect, it, vi } from "vitest";

import { routeParams } from "@/lib/__tests__/helpers/requests";

/**
 * #2478 — ONE calendar-day contract for the printed chore roster.
 *
 * A roster night is a calendar day. It is stored in `@db.Date` columns, which
 * Prisma reads and writes as UTC midnight, and the print page heads the sheet
 * with the day parsed the same way. The API route behind that sheet used to
 * parse `dateStr + "T00:00:00"`, which is midnight ON THE SERVER'S WALL CLOCK.
 * Under the production `TZ=Pacific/Auckland` pin that is (D-1) 12:00 UTC, so
 * the equality filter matched no assignment row and the booking window filters
 * excluded the stay: the correct date at the top of the page, an empty roster
 * underneath.
 *
 * These tests run the same request with the process clock in two zones and
 * require an identical result. Note the two zones are deliberately independent
 * concepts: `APP_TIME_ZONE` is mocked to New Zealand below so that moving
 * `process.env.TZ` simulates a differently-zoned HOST for a club that is always
 * in NZ — without the mock, `src/config/operational.ts` reads `process.env.TZ`
 * first and the club would move with the host, hiding the mismatch.
 */

const ROSTER_NIGHT = "2026-07-10";
const NIGHT_UTC_MIDNIGHT = "2026-07-10T00:00:00.000Z";

vi.mock("@/config/operational", () => ({
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
}));

const { mockPrisma, mockAuth } = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

// The stored roster row for the night being printed, as Prisma would hand it
// back: `@db.Date` values are UTC midnight.
const STORED_ASSIGNMENT = {
  choreTemplateId: "chore-1",
  choreTemplate: { sortOrder: 1, name: "Dishes", description: "Wash and dry" },
  bookingGuest: { firstName: "Ada", lastName: "Lovelace" },
};

const STORED_BOOKING = {
  id: "booking-1",
  checkIn: dateOnly("2026-07-10"),
  checkOut: dateOnly("2026-07-12"),
  guests: [
    {
      id: "guest-1",
      stayStart: dateOnly("2026-07-10"),
      stayEnd: dateOnly("2026-07-12"),
      nights: [],
      consentStatus: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: {
      id: "admin-1",
      role: "ADMIN",
      accessRoles: [{ role: "ADMIN" }],
      email: "admin@example.org",
    },
  });

  // Both mocks APPLY the filter the route sent rather than ignoring it — a mock
  // that always returned the row would pass with the bug still in place.
  mockPrisma.choreAssignment.findMany.mockImplementation(async (args: never) => {
    const { where } = args as unknown as { where: { date: Date } };
    return where.date instanceof Date &&
      where.date.getTime() === Date.parse(NIGHT_UTC_MIDNIGHT)
      ? [STORED_ASSIGNMENT]
      : [];
  });

  mockPrisma.booking.findMany.mockImplementation(async (args: never) => {
    const { where } = args as unknown as {
      where: { checkIn: { lte: Date }; checkOut: { gt: Date } };
    };
    const night = where.checkIn.lte;
    const stayCovers =
      STORED_BOOKING.checkIn.getTime() <= night.getTime() &&
      STORED_BOOKING.checkOut.getTime() > where.checkOut.gt.getTime();
    return stayCovers ? [STORED_BOOKING] : [];
  });
});

// Restoring the host zone is not `delete process.env.TZ`: Node applies a zone
// when TZ is ASSIGNED and keeps it when the variable is removed, so deleting
// would leave the whole worker on whichever zone this file set last. Assigning
// the resolved starting zone first, then removing the variable, puts both the
// zone and the environment back exactly as they were found.
const ORIGINAL_TZ_ENV = process.env.TZ;
const ORIGINAL_HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function withHostTimeZone<T>(
  timeZone: string,
  run: () => Promise<T>,
): Promise<T> {
  process.env.TZ = timeZone;
  try {
    return await run();
  } finally {
    if (ORIGINAL_TZ_ENV === undefined) {
      process.env.TZ = ORIGINAL_HOST_ZONE;
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ_ENV;
    }
  }
}

async function printRoster(date = ROSTER_NIGHT) {
  // Re-import so the route is evaluated under the host zone now in force.
  vi.resetModules();
  const { GET } = await import("@/app/api/chores/roster/[date]/print/route");
  return GET(
    new Request(`http://localhost/api/chores/roster/${date}/print`) as never,
    routeParams({ date }),
  );
}

describe("GET /api/chores/roster/[date]/print — calendar-day contract (#2478)", () => {
  it.each([
    // A CI-style runner on UTC: naive parsing happened to be right here, which
    // is exactly why the bug survived the test suite.
    ["UTC", "2026-07-10T00:00:00.000Z"],
    // The production pin. Naive parsing lands on the PREVIOUS day at noon UTC.
    ["Pacific/Auckland", "2026-07-09T12:00:00.000Z"],
  ])(
    "prints the roster for the requested night with the host clock on %s",
    async (timeZone, naiveParseInstant) => {
      await withHostTimeZone(timeZone, async () => {
        // Guard the harness itself: if the platform ignored the TZ change, the
        // naive parse would not move and the boundary would never be tested.
        expect(new Date(`${ROSTER_NIGHT}T00:00:00`).toISOString()).toBe(
          naiveParseInstant,
        );

        const res = await printRoster();
        expect(res.status).toBe(200);
        const data = await res.json();

        // The filter is the calendar day itself, in every host zone.
        const assignmentArgs = mockPrisma.choreAssignment.findMany.mock
          .calls[0][0] as { where: { date: Date } };
        expect(assignmentArgs.where.date.toISOString()).toBe(NIGHT_UTC_MIDNIGHT);

        // …and the sheet is not blank under a correct heading.
        expect(data.date).toBe(ROSTER_NIGHT);
        expect(data.chores).toHaveLength(1);
        expect(data.chores[0]).toMatchObject({
          name: "Dishes",
          guests: ["Ada Lovelace"],
        });
        expect(data.guestCount).toBe(1);
      });
    },
  );

  it("rejects a value that is not a calendar day", async () => {
    const res = await printRoster("2026-07-32");

    expect(res.status).toBe(400);
    expect(mockPrisma.choreAssignment.findMany).not.toHaveBeenCalled();
  });
});
