// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club", bookingsName: "Bookings" }),
}));

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [
      { id: "lodge-1", name: "Lodge One" },
      { id: "lodge-2", name: "Lodge Two" },
    ],
    loading: false,
  }),
}));

vi.mock("@/lib/date-only", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/date-only")>();
  return {
    ...actual,
    getTodayDateOnly: () => new Date("2026-04-13T00:00:00.000Z"),
    todayDateOnlyForTimeZone: () => "2026-04-13",
  };
});

import ReportsPage from "@/app/(admin)/admin/reports/page";

const EMPTY_REPORT = {
  summary: {
    totalBookings: 0,
    totalRevenueCents: 0,
    outstandingAdditionalCents: 0,
    outstandingAdditionalBookings: 0,
    totalGuests: 0,
    avgOccupancyRate: 0,
    memberGuests: 0,
    nonMemberGuests: 0,
  },
  statusBreakdown: {
    confirmed: 0,
    paid: 0,
    completed: 0,
    pending: 0,
    cancelled: 0,
    bumped: 0,
  },
  memberStats: {
    totalActiveMembers: 0,
    paidMembers: 0,
    unpaidMembers: 0,
    overdueMembers: 0,
    newMembers: 0,
    currentSeasonYear: 2026,
    currentSeasonLabel: "2026",
  },
  occupancy: [],
  revenueGranularity: "monthly",
  revenue: [],
  trends: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ReportsPage quick ranges", () => {
  it("preserves lodge and deleted scope when Next Month changes only the dates", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify(EMPTY_REPORT), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    render(<ReportsPage />);
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    fireEvent.change(screen.getByDisplayValue("All lodges"), {
      target: { value: "lodge-2" },
    });
    fireEvent.change(screen.getByDisplayValue("Hide deleted"), {
      target: { value: "include" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Quick Range" }), {
      target: { value: "next_month" },
    });

    await waitFor(() => {
      const latest = requests.at(-1);
      expect(latest).toContain("from=2026-05-01");
      expect(latest).toContain("to=2026-05-31");
      expect(latest).toContain("lodgeId=lodge-2");
      expect(latest).toContain("deleted=include");
    });
  });
});
