/**
 * The club-calendar day boundaries on the member dashboard (#2838).
 *
 * The dashboard decides two member-facing things from "today": whether the
 * viewer is a STAYING GUEST, and whether they are an ACTIVE HUT LEADER. Both
 * compare `@db.Date` columns — `Booking.checkIn` / `Booking.checkOut` and the
 * hut-leader assignment dates — and both are documented as granting access from
 * the DAY BEFORE (`checkIn - 1 <= today <= checkOut`).
 *
 * ## Why the assertions below are about calendar DAYS
 *
 * A `@db.Date` column holds an NZ calendar day encoded at UTC midnight
 * (INV-DATE-010). `@prisma/adapter-pg` narrows whatever `Date` is bound against
 * such a column with `formatDate`, which reads `getUTCFullYear/Month/Date` and
 * throws the time away — so Postgres compares two calendar days, and a bound
 * instant of `(D-1)T12:00Z` arrives as the day `D-1`, not as a moment partway
 * through it. `dateFilterAdmits` below models exactly that narrowing, which is
 * what makes these tests answer the product question ("can this member see the
 * surface today?") rather than the shape question ("what Date object was
 * built?").
 *
 * That mechanism is the whole defect. `new Date()` + `setHours(0, 0, 0, 0)` is
 * NZ-LOCAL midnight, which under the `TZ=Pacific/Auckland` server pin
 * (`Dockerfile`, `docker-compose*.yml`) is `(D-1)T12:00Z` and therefore narrows
 * to D-1 — running every window here a full day behind.
 *
 * ## Why this instant
 *
 * `2026-07-01T13:30:00.000Z` is 01:30 on 2 July in New Zealand (NZST, UTC+12)
 * and 23:30 on 1 July in Brisbane (UTC+10) — so the club day is 2026-07-02 but
 * the UTC day, and the day in any zone below about UTC+11, is 2026-07-01. A
 * comfortable mid-morning instant would agree across all of those and pin
 * nothing; this one goes red under a wrong zone, which is the point. The
 * `expectClubTimeZonePremise()` guard makes that failure say so out loud
 * instead of arriving as a bare date mismatch (docs/TESTING.md rule 6).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_HUT_LEADER_LABEL } from "@/config/club-identity";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingFindMany: vi.fn(),
  calendarEventFindMany: vi.fn(),
  checkCapacity: vi.fn(),
  getAvailablePromoCodesForMember: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  hasAccessRole: vi.fn(),
  isHutLeader: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  lockerFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: mocks.bookingFindFirst,
      findMany: mocks.bookingFindMany,
    },
    locker: { findMany: mocks.lockerFindMany },
    member: { findUnique: mocks.memberFindUnique },
    calendarEvent: { findMany: mocks.calendarEventFindMany },
  },
}));

vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: mocks.getMemberCreditBalance,
}));
vi.mock("@/lib/promo", () => ({
  getAvailablePromoCodesForMember: mocks.getAvailablePromoCodesForMember,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/access-roles", () => ({ hasAccessRole: mocks.hasAccessRole }));
vi.mock("@/lib/hut-leader", () => ({ isHutLeader: mocks.isHutLeader }));
vi.mock("@/lib/capacity", () => ({ checkCapacity: mocks.checkCapacity }));

import DashboardPage from "../page";

/** The instant every test in this file runs at — see the file comment. */
const PINNED_INSTANT = "2026-07-01T13:30:00.000Z";
/** The club calendar day at that instant. */
const CLUB_TODAY = "2026-07-02";

type DateFilter = { gte?: Date; lte?: Date };

/**
 * The calendar day Postgres actually receives for a value bound against a
 * `@db.Date` column: its UTC date, time discarded. This mirrors `formatDate` in
 * `@prisma/adapter-pg` (`mapArg`, `case "DATE"`), which is the single step that
 * turns the encoding bug into an off-by-a-day access bug.
 */
function boundDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Answer a `@db.Date` filter the way Postgres would, given the stored day as a
 * `yyyy-MM-dd` string. Lexicographic order on that format is chronological
 * order, so plain string comparison is exact here.
 */
function dateFilterAdmits(storedDay: string, filter: DateFilter): boolean {
  if (filter.gte && storedDay < boundDay(filter.gte)) return false;
  if (filter.lte && storedDay > boundDay(filter.lte)) return false;
  return true;
}

function moduleFlags() {
  return {
    kiosk: false,
    chores: false,
    financeDashboard: false,
    waitlist: false,
    xeroIntegration: false,
    bedAllocation: false,
    internetBankingPayments: false,
    addressAutocomplete: false,
    groupBookings: false,
    lockers: false,
    induction: false,
    workParties: false,
    promoCodes: false,
    hutLeaders: true,
    communications: false,
    skifieldConditions: false,
    twoFactor: false,
    analytics: false,
  };
}

/**
 * Serve the staying-guest read from one fixture stay, evaluating the route's
 * own `where` clause against it exactly as the database would.
 */
function withStay(stay: { checkIn: string; checkOut: string } | null) {
  mocks.bookingFindFirst.mockImplementation(async (args: unknown) => {
    const where = (args as { where: { checkIn: DateFilter; checkOut: DateFilter } })
      .where;
    if (!stay) return null;
    const admitted =
      dateFilterAdmits(stay.checkIn, where.checkIn) &&
      dateFilterAdmits(stay.checkOut, where.checkOut);
    return admitted ? { id: "stay-1" } : null;
  });
}

/**
 * Serve `isHutLeader(memberId, date)` from one fixture assignment. The real
 * helper counts rows with `startDate <= date AND endDate >= date`, both
 * `@db.Date`, so the same narrowing applies to the date the page hands it —
 * which is the value under test here.
 */
function withAssignment(assignment: { startDate: string; endDate: string } | null) {
  mocks.isHutLeader.mockImplementation(async (_memberId: string, date: Date) => {
    if (!assignment) return false;
    const day = boundDay(date);
    return assignment.startDate <= day && assignment.endDate >= day;
  });
}

async function renderDashboard() {
  return renderToStaticMarkup(await DashboardPage());
}

// Both lodge-access buttons link to /lodge/kiosk, so they are told apart by
// their label — which is what the member actually sees.
function showsStayingGuestSurface(html: string): boolean {
  return html.includes("View Lodge");
}

function showsHutLeaderSurface(html: string): boolean {
  return html.includes(CLUB_HUT_LEADER_LABEL);
}

describe("dashboard club-day boundaries (#2838)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(PINNED_INSTANT));
    expectClubTimeZonePremise();

    mocks.auth.mockResolvedValue({ user: { id: "member-1", name: "Mere Member" } });
    mocks.hasAccessRole.mockReturnValue(true);
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.getMemberCreditBalance.mockResolvedValue(0);
    mocks.getAvailablePromoCodesForMember.mockResolvedValue([]);
    mocks.lockerFindMany.mockResolvedValue([]);
    mocks.calendarEventFindMany.mockResolvedValue([]);
    mocks.memberFindUnique.mockResolvedValue({
      requiresInduction: false,
      inductions: [],
    });
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags());
    mocks.checkCapacity.mockResolvedValue({
      available: true,
      minAvailable: 0,
      nightDetails: [],
    });
    withStay(null);
    withAssignment(null);
  });

  describe("the club's calendar day, not the process clock", () => {
    it("asks the @db.Date columns about today and tomorrow as date-only days", async () => {
      await renderDashboard();

      const where = mocks.bookingFindFirst.mock.calls[0]?.[0] as {
        where: { checkIn: DateFilter; checkOut: DateFilter };
      };
      // Both ends are UTC midnight, so the adapter's narrowing is lossless and
      // the day Postgres compares against is the day intended.
      expect(where.where.checkOut.gte?.toISOString()).toBe(
        "2026-07-02T00:00:00.000Z",
      );
      expect(where.where.checkIn.lte?.toISOString()).toBe(
        "2026-07-03T00:00:00.000Z",
      );
      expect(boundDay(where.where.checkOut.gte as Date)).toBe(CLUB_TODAY);
      expect(boundDay(where.where.checkIn.lte as Date)).toBe("2026-07-03");
    });

    it("asks the hut-leader assignment about tomorrow first, then today", async () => {
      await renderDashboard();

      const days = mocks.isHutLeader.mock.calls.map(([, date]) =>
        boundDay(date as Date),
      );
      expect(days).toEqual(["2026-07-03", CLUB_TODAY]);
    });
  });

  describe("staying guest", () => {
    it("admits the member the DAY BEFORE check-in, as the rule says", async () => {
      // Club today is 2 July; the stay starts on the 3rd.
      withStay({ checkIn: "2026-07-03", checkOut: "2026-07-05" });

      expect(showsStayingGuestSurface(await renderDashboard())).toBe(true);
    });

    it("still admits the member on the CHECK-OUT day itself", async () => {
      withStay({ checkIn: "2026-06-30", checkOut: CLUB_TODAY });

      expect(showsStayingGuestSurface(await renderDashboard())).toBe(true);
    });

    it("does NOT admit the member the day after check-out", async () => {
      withStay({ checkIn: "2026-06-29", checkOut: "2026-07-01" });

      expect(showsStayingGuestSurface(await renderDashboard())).toBe(false);
    });

    it("does NOT admit the member two days before check-in", async () => {
      withStay({ checkIn: "2026-07-04", checkOut: "2026-07-06" });

      expect(showsStayingGuestSurface(await renderDashboard())).toBe(false);
    });
  });

  describe("hut leader", () => {
    it("admits a SINGLE-DAY assignment on the day it runs", async () => {
      withAssignment({ startDate: CLUB_TODAY, endDate: CLUB_TODAY });

      expect(showsHutLeaderSurface(await renderDashboard())).toBe(true);
    });

    it("admits a SINGLE-DAY assignment the day before it runs (day-before access)", async () => {
      withAssignment({ startDate: "2026-07-03", endDate: "2026-07-03" });

      expect(showsHutLeaderSurface(await renderDashboard())).toBe(true);
    });

    it("does NOT admit a SINGLE-DAY assignment that finished yesterday", async () => {
      withAssignment({ startDate: "2026-07-01", endDate: "2026-07-01" });

      expect(showsHutLeaderSurface(await renderDashboard())).toBe(false);
    });
  });

  describe("the two encodings stay separate", () => {
    it("keeps the DateTime reads on the start-of-club-day INSTANT, not the date-only day", async () => {
      await renderDashboard();

      // `Booking.draftExpiresAt` and `CalendarEvent.startsAt` are real
      // instants. A date-only value would push both to club MIDDAY and hide a
      // draft expiring this morning, so they take 00:00 NZ = the previous day
      // at 12:00Z — the same instant `setHours(0, 0, 0, 0)` produced under the
      // server's NZ pin, now derived from the club's calendar instead.
      const draftCall = mocks.bookingFindMany.mock.calls.find(
        ([args]) => (args as { where?: { draftExpiresAt?: unknown } }).where
          ?.draftExpiresAt,
      );
      const draftExpiresAt = (
        draftCall?.[0] as { where: { draftExpiresAt: { gt: Date } } }
      ).where.draftExpiresAt.gt;
      expect(draftExpiresAt.toISOString()).toBe("2026-07-01T12:00:00.000Z");
    });
  });
});
