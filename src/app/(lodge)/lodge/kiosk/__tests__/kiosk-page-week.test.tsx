// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KioskPage from "../page";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import {
  buildWeekDateKeys,
  type KioskWeekDaySummary,
} from "../_components/kiosk-week-view";

// #2474 — the CLUB's zone is pinned here independently of the HOST's, because
// `src/config/operational.ts` derives `APP_TIME_ZONE` from `process.env.TZ`.
// Without this mock, moving the host zone below would drag the club along with
// it and the rollover cases would assert nothing at all (docs/TESTING.md, "the
// club zone follows process.env.TZ").
vi.mock("@/config/operational", () => ({
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
}));

vi.mock("@/components/kiosk-lodge-instructions", () => ({
  KioskLodgeInstructions: ({ date }: { date: string }) => (
    <div data-testid="kiosk-instructions">{date}</div>
  ),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

function buildWeekDays(start: string): KioskWeekDaySummary[] {
  return buildWeekDateKeys(start).map((date, index) =>
    index === 0
      ? {
          date,
          accessible: true,
          guestCount: 2,
          arrivingCount: 1,
          departingCount: 0,
          rosterStatus: "needs-roster",
        }
      : {
          date,
          accessible: false,
        }
  );
}

describe("KioskPage week view", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads the week summary by default and drills into the day endpoints", async () => {
    let servedWeekStart = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith("/api/lodge/access")) {
        return Response.json({
          tier: "admin",
          dateRange: null,
          canManageRoster: true,
          canMarkAttendance: true,
          canCompleteChores: true,
          lodgeName: "Whakapapa",
        });
      }

      if (url.startsWith("/api/lodge/week?start=")) {
        servedWeekStart = new URL(url, "http://localhost").searchParams.get("start") ?? "";
        return Response.json({
          start: servedWeekStart,
          days: buildWeekDays(servedWeekStart),
        });
      }

      if (url.startsWith(`/api/lodge/guests/${servedWeekStart}`)) {
        return Response.json({
          bookings: [],
          totalGuests: 0,
        });
      }

      if (url.startsWith(`/api/lodge/roster/${servedWeekStart}`)) {
        return Response.json({
          assignments: [],
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<KioskPage />);

    expect(await screen.findByRole("heading", { name: "Week View" })).toBeVisible();
    expect(servedWeekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/lodge/week?start="))
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/lodge/guests/"))
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Open / }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url) === `/api/lodge/guests/${servedWeekStart}?scope=lodge-list`
        )
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `/api/lodge/roster/${servedWeekStart}`
      )
    ).toBe(true);
    expect(screen.getByRole("button", { name: /Week/ })).toBeVisible();

    const weekCallCount = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/lodge/week?start=")
    ).length;
    fireEvent.click(screen.getByRole("button", { name: /Week/ }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("/api/lodge/week?start=")
        ).length
      ).toBeGreaterThan(weekCallCount);
    });
  });
});

/*
  #2474 — the kiosk's idea of "today", and its day stepping, belong to the CLUB,
  not to the display device.

  A lodge kiosk is a tablet on a wall. Nobody administers its clock, and a
  device on the wrong zone (or simply shipped on UTC) used to open the kiosk on
  the wrong night: the page read `new Date()` through local getters while every
  server route it calls resolves the night in New Zealand. The hut leader then
  saw one night's arrivals and the check-in write refused a different one.

  Both cases below therefore run the page on a HOST that is deliberately NOT in
  New Zealand, at an instant where the two calendars genuinely disagree. The
  fixture instants are absolute, so the rollover canary's shifted real clock
  cannot move them.
*/

// Restoring the host zone is not `delete process.env.TZ`: Node applies a zone
// when TZ is ASSIGNED and keeps it once the variable is removed, so deleting
// alone would strand the whole worker on whichever zone this file set last.
// Assign the resolved starting zone first, then remove the variable.
const ORIGINAL_TZ_ENV = process.env.TZ;
const ORIGINAL_HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Every day of the served week open, so any of them can be drilled into. */
function buildOpenWeekDays(start: string): KioskWeekDaySummary[] {
  return buildWeekDateKeys(start).map((date) => ({
    date,
    accessible: true as const,
    guestCount: 0,
    arrivingCount: 0,
    departingCount: 0,
    rosterStatus: "no-guests" as const,
  }));
}

/**
 * Serves every kiosk endpoint and records the date each was asked for, so a
 * test can assert on the NIGHT the page requested rather than on its own idea
 * of what should have been rendered.
 */
function installKioskFetchMock() {
  const accessDates: string[] = [];
  const weekStarts: string[] = [];
  const dayDates: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;

    if (path === "/api/lodge/access") {
      accessDates.push(url.searchParams.get("date") ?? "");
      return Response.json({
        tier: "admin",
        dateRange: null,
        canManageRoster: true,
        canMarkAttendance: true,
        canCompleteChores: true,
        lodgeName: "Whakapapa",
      });
    }

    if (path === "/api/lodge/week") {
      const start = url.searchParams.get("start") ?? "";
      weekStarts.push(start);
      return Response.json({ start, days: buildOpenWeekDays(start) });
    }

    const guests = path.match(/^\/api\/lodge\/guests\/(\d{4}-\d{2}-\d{2})$/);
    if (guests) {
      dayDates.push(guests[1]);
      return Response.json({ bookings: [], totalGuests: 0 });
    }

    const roster = path.match(/^\/api\/lodge\/roster\/(\d{4}-\d{2}-\d{2})$/);
    if (roster) {
      return Response.json({ assignments: [] });
    }

    throw new Error(`Unexpected fetch ${url}`);
  });

  global.fetch = fetchMock as typeof fetch;
  return { accessDates, weekStarts, dayDates };
}

describe("KioskPage club-time dates (#2474)", () => {
  beforeEach(() => {
    // A kiosk tablet whose clock is on UTC — the shipped default, and the
    // common case on a device nobody administers.
    process.env.TZ = "UTC";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // The root re-freeze restores the DEFAULT instant only when nothing is
    // mocking Date, and these tests leave their own pin in place — so hand the
    // harness instant back explicitly rather than leaking a pin into the next
    // file-level test (docs/TESTING.md, rule 4).
    vi.setSystemTime(frozenTestNow());
    if (ORIGINAL_TZ_ENV === undefined) {
      process.env.TZ = ORIGINAL_HOST_ZONE;
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ_ENV;
    }
  });

  it("opens on the club's day, not the display device's, after the NZ rollover", async () => {
    // 13:00 UTC on Sunday 2 August 2026 is 01:00 on MONDAY 3 August in
    // Pacific/Auckland (NZST, UTC+12). The tablet still says 2 August; the club
    // — and every lodge route the kiosk calls — is already on the 3rd.
    vi.setSystemTime(new Date("2026-08-02T13:00:00.000Z"));
    const { accessDates, weekStarts } = installKioskFetchMock();

    render(<KioskPage />);

    expect(await screen.findByRole("heading", { name: "Week View" })).toBeVisible();

    // The night asked for is the club's, and never the host's.
    expect(accessDates).toContain("2026-08-03");
    expect(accessDates).not.toContain("2026-08-02");
    // 3 August 2026 is itself a Monday, so it is also the week start.
    expect(weekStarts).toEqual(["2026-08-03"]);

    // ...and the strip marks the club's day as today. A host-derived "today"
    // would be 2 August, which is not even in this week, so no day would carry
    // the marker at all.
    expect(
      screen.getByRole("button", { name: "Open Monday, 3 August" })
    ).toHaveTextContent("Today");
    // Selector-scoped: the week header also carries a "Today" jump BUTTON, and
    // the marker under test is the chip inside a day tile.
    expect(screen.getAllByText("Today", { selector: "p" })).toHaveLength(1);
  });

  it("steps a day across a month boundary and back", async () => {
    // 13:00 UTC on 30 July 2026 is FRIDAY 31 July in Pacific/Auckland.
    vi.setSystemTime(new Date("2026-07-30T13:00:00.000Z"));
    const { dayDates } = installKioskFetchMock();

    render(<KioskPage />);

    expect(await screen.findByRole("heading", { name: "Week View" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Friday, 31 July" }));

    expect(
      await screen.findByRole("heading", { name: "Friday, 31 July 2026" })
    ).toBeVisible();
    await waitFor(() => expect(dayDates).toContain("2026-07-31"));

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(
      await screen.findByRole("heading", { name: "Saturday, 1 August 2026" })
    ).toBeVisible();
    await waitFor(() => expect(dayDates).toContain("2026-08-01"));

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(
      await screen.findByRole("heading", { name: "Friday, 31 July 2026" })
    ).toBeVisible();

    // Nothing stepped into a neighbouring night: a local-midnight round trip on
    // a host west of the club lands on 30 July / 31 July instead.
    expect(dayDates).not.toContain("2026-07-30");
    expect(dayDates).not.toContain("2026-08-02");
  });
});
