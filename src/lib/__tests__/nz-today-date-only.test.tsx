// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * "Today" is an NZ calendar day, never a UTC one (#2682).
 *
 * New Zealand runs 12-13 hours ahead of UTC, so for roughly the first half of
 * every NZ day, "today in UTC" is still YESTERDAY in New Zealand. Several
 * places derived today's lodge night as `new Date().toISOString().slice(0, 10)`
 * — the UTC date — which `docs/DOMAIN_INVARIANTS.md` already forbids and
 * `todayDateOnlyForTimeZone()` (`src/lib/date-only.ts`) already answers
 * correctly.
 *
 * Every case here runs at **09:00 on 1 July 2026 in New Zealand**, which is
 * `2026-06-30T21:00:00.000Z` — inside the divergence window, where the UTC date
 * (2026-06-30) and the NZ date (2026-07-01) differ. Each assertion fails
 * against the pre-#2682 code, which returned the UTC day.
 */

// 09:00 NZST on 2026-07-01. NZ is UTC+12 in July, so this is the PREVIOUS UTC
// day — the window in which a UTC "today" is a day behind the club.
const NZ_MORNING = new Date("2026-06-30T21:00:00.000Z");
const NZ_DAY = "2026-07-01";
const UTC_DAY = "2026-06-30";

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({
    lodgeName: "Test Alpine Lodge",
    lodgeCapacity: 20,
    hutLeaderLabel: "Hut Leader",
  }),
}));

const financeMocks = vi.hoisted(() => ({
  prisma: {
    booking: { findMany: vi.fn() },
    lodgeSettings: { findUnique: vi.fn() },
  },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  requireFinanceViewerApiAccess: vi.fn(),
  getLegacyDashboardBookingExport: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: financeMocks.prisma }));
vi.mock("@/lib/logger", () => ({ default: financeMocks.logger }));
vi.mock("@/lib/finance-api-auth", () => ({
  requireFinanceViewerApiAccess: financeMocks.requireFinanceViewerApiAccess,
}));
vi.mock("@/lib/finance-legacy-dashboard-export", () => ({
  getLegacyDashboardBookingExport: financeMocks.getLegacyDashboardBookingExport,
}));

import BookingRequestPage from "@/app/(public)/booking-requests/page";
import SchoolBookingRequestPage from "@/app/(public)/school-bookings/page";
import { getFinanceBookingMetrics } from "@/lib/finance-booking-metrics";
import { GET as getLegacyDashboardBookings } from "@/app/api/finance/legacy-dashboard/bookings/route";
import { todayDateOnlyForTimeZone } from "@/lib/date-only";

function mockPublicSettingsFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/settings")) {
      return {
        ok: true,
        json: async () => ({ showPricingToNonMembers: false, lodges: [] }),
      } as Response;
    }
    return { ok: true, json: async () => ({ settings: [] }) } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NZ_MORNING);
  vi.clearAllMocks();
  mockPublicSettingsFetch();
  financeMocks.prisma.booking.findMany.mockResolvedValue([]);
  financeMocks.prisma.lodgeSettings.findUnique.mockResolvedValue({ capacity: 20 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#2682 the fixture really is inside the UTC/NZ divergence window", () => {
  it("is a different calendar day in UTC than in New Zealand", () => {
    expect(new Date().toISOString().slice(0, 10)).toBe(UTC_DAY);
    expect(todayDateOnlyForTimeZone()).toBe(NZ_DAY);
    expect(UTC_DAY).not.toBe(NZ_DAY);
  });
});

describe("#2682 public lodge-night pickers offer the NZ day, not the UTC day", () => {
  it("the public booking-request form's earliest selectable night is the NZ day", async () => {
    render(<BookingRequestPage />);

    const checkIn = (await screen.findByLabelText(/check-?in/i)) as HTMLInputElement;
    await waitFor(() => expect(checkIn.getAttribute("min")).toBeTruthy());

    // Before #2682 this was the UTC day, so between NZ midnight and roughly NZ
    // midday the form offered a night that had already started and the server
    // then refused.
    expect(checkIn.getAttribute("min")).toBe(NZ_DAY);
    expect(checkIn.getAttribute("min")).not.toBe(UTC_DAY);
  });

  it("the public school-booking form's earliest selectable night is the NZ day", async () => {
    render(<SchoolBookingRequestPage />);

    const checkIn = (await screen.findByLabelText(/check-?in/i)) as HTMLInputElement;
    await waitFor(() => expect(checkIn.getAttribute("min")).toBeTruthy());

    expect(checkIn.getAttribute("min")).toBe(NZ_DAY);
    expect(checkIn.getAttribute("min")).not.toBe(UTC_DAY);
  });
});

describe("#2682 finance windows default their cut-off to the NZ day", () => {
  it("getFinanceBookingMetrics defaults forward.asOfDate to the NZ day", async () => {
    const result = await getFinanceBookingMetrics({
      forward: { from: "2026-07-01", to: "2026-07-31" },
    });

    // asOfDate decides which stays count as realised. A UTC default made the
    // morning's figures a day behind the afternoon's, with no input changed.
    expect(result.forward?.window.asOfDate).toBe(NZ_DAY);
    expect(result.forward?.window.asOfDate).not.toBe(UTC_DAY);
  });

  it("the legacy dashboard export defaults asOfDate to the NZ day", async () => {
    process.env.LEGACY_DASHBOARD_EXPORT_TOKEN = "test-export-token";
    financeMocks.requireFinanceViewerApiAccess.mockResolvedValue({
      ok: true,
      member: { id: "finance-viewer-1", financeAccessLevel: "VIEWER" },
    });
    financeMocks.getLegacyDashboardBookingExport.mockResolvedValue({
      generatedAt: "2026-07-01T00:00:00.000Z",
      historyStartDate: "2020-04-01",
      asOfDate: NZ_DAY,
      bookings: [],
      forward_bookings: [],
    });

    await getLegacyDashboardBookings(
      new NextRequest(
        "https://example.org/api/finance/legacy-dashboard/bookings",
        { headers: { authorization: "Bearer test-export-token" } },
      ),
    );

    expect(financeMocks.getLegacyDashboardBookingExport).toHaveBeenCalledWith(
      expect.objectContaining({ asOfDate: NZ_DAY }),
    );
    expect(financeMocks.getLegacyDashboardBookingExport).not.toHaveBeenCalledWith(
      expect.objectContaining({ asOfDate: UTC_DAY }),
    );
  });
});

describe("#2682 no surface derives today from UTC any more", () => {
  const SOURCE_ROOT = path.resolve(process.cwd(), "src");

  function listSourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "__tests__" ? [] : listSourceFiles(entryPath);
      }
      if (!/\.tsx?$/.test(entry.name)) return [];
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) return [];
      return [path.relative(process.cwd(), entryPath).split(path.sep).join("/")];
    });
  }

  it("leaves no `new Date().toISOString()` date-only slice in non-test src/", () => {
    // All three truncations, not just the two the audit found: `.slice(0, 10)`,
    // `.split("T")[0]` and `.substring(0, 10)` are the same mistake written
    // three ways, and two of the fifteen sites used the third form.
    const utcToday =
      /new Date\(\)\s*\.toISOString\(\)\s*\.(slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\)|split\(\s*"T"\s*\)\s*\[\s*0\s*\])/;

    const offenders = listSourceFiles(SOURCE_ROOT).filter((file) =>
      utcToday.test(fs.readFileSync(path.resolve(process.cwd(), file), "utf8")),
    );

    expect(
      offenders,
      "These files derive today's date in UTC. Lodge nights and finance windows are NZ calendar days — use todayDateOnlyForTimeZone() from @/lib/date-only (#2682).",
    ).toEqual([]);
  });

  it("leaves neither public booking form defining a date helper of its own", () => {
    for (const page of [
      "src/app/(public)/booking-requests/page.tsx",
      "src/app/(public)/school-bookings/page.tsx",
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), page), "utf8");
      // The byte-identical private `todayDateOnly()` in both files is what made
      // this a copy-paste defect rather than a one-off; a third public form
      // would have copied it again.
      expect(
        /function\s+\w*[Tt]oday\w*\s*\(/.test(source),
        `${page} must not define its own "today" helper — import todayDateOnlyForTimeZone from @/lib/date-only`,
      ).toBe(false);
      expect(source).toContain(
        'import { todayDateOnlyForTimeZone } from "@/lib/date-only";',
      );
    }
  });
});
