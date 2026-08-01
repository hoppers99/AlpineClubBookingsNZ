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
    netCollectedCents: 0,
    outstandingAdditionalCents: 0,
    outstandingAdditionalBookings: 0,
    totalGuests: 0,
    avgOccupancyRate: 0,
    memberGuests: 0,
    nonMemberGuests: 0,
  },
  statusBreakdown: {
    pending: 0,
    paymentPending: 0,
    confirmed: 0,
    paid: 0,
    awaitingReview: 0,
    completed: 0,
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

  it("renders booked revenue, payment-derived cash, and outstanding additions as distinct figures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ...EMPTY_REPORT,
            summary: {
              ...EMPTY_REPORT.summary,
              totalBookings: 1,
              totalRevenueCents: 10_000,
              netCollectedCents: 7_500,
              outstandingAdditionalCents: 2_500,
              outstandingAdditionalBookings: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    render(<ReportsPage />);
    expect(await screen.findByText("Booked Revenue")).toBeVisible();
    expect(screen.getByText("Net Collected Cash")).toBeVisible();
    expect(screen.getByText("Outstanding Additions")).toBeVisible();
    expect(screen.getByText("Booked Revenue by Month")).toBeVisible();
    expect(screen.getByText(/Price allocated to selected stay nights/)).toBeVisible();
  });

  it("exports stay-night booked revenue and collected cash with unambiguous CSV labels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ...EMPTY_REPORT,
            summary: {
              ...EMPTY_REPORT.summary,
              totalRevenueCents: 10_000,
              netCollectedCents: 7_500,
              outstandingAdditionalCents: 2_500,
              outstandingAdditionalBookings: 1,
            },
            revenue: [
              {
                periodStart: "2026-04-01",
                periodEnd: "2026-04-30",
                label: "Apr 2026",
                tooltipLabel: "April 2026",
                revenueCents: 10_000,
                bookingCount: 1,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const createObjectUrl = vi.fn(() => "blob:report");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<ReportsPage />);
    const csvButton = await screen.findByRole("button", { name: "CSV" });
    await waitFor(() => expect(csvButton).toBeEnabled());
    fireEvent.click(csvButton);

    const blob = createObjectUrl.mock.calls[0][0] as Blob;
    const csv = await blob.text();
    expect(csv).toContain("Booked Revenue,100.00");
    expect(csv).toContain("Net Collected Cash,75.00");
    expect(csv).toContain("Outstanding Additional Payments,25.00");
    expect(csv).toContain("Booked Revenue by Month");
    expect(csv).toContain("Month,Booked Revenue,Distinct Bookings");
    expect(csv).not.toContain("Booked Revenue Less Outstanding");
  });
});
