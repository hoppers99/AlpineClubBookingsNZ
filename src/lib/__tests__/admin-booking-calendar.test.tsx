// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminBookingCalendar } from "@/components/admin-booking-calendar";

// The component reads router/search params from next/navigation; provide
// minimal stand-ins so it renders outside the App Router.
const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(),
}));

// The calendar initially shows the current month, so build booking dates
// inside it (days 5-12 exist in every month).
const now = new Date();
const isoDay = (day: number) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const calendarResponse = {
  bookings: [
    {
      id: "booking-paid",
      memberName: "Paula Paid",
      checkIn: isoDay(5),
      checkOut: isoDay(7),
      status: "PAID",
      guestCount: 2,
    },
    {
      id: "booking-cancelled",
      memberName: "Casey Cancelled",
      checkIn: isoDay(10),
      checkOut: isoDay(12),
      status: "CANCELLED",
      guestCount: 1,
    },
  ],
  availability: {},
};

describe("AdminBookingCalendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => calendarResponse,
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("hides cancelled bookings by default with the Cancelled pill off", async () => {
    render(<AdminBookingCalendar />);

    // Non-cancelled bookings render once the fetch resolves.
    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });

    // The CANCELLED toggle pill starts in the off state; others stay on.
    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: "Paid" }).getAttribute("aria-pressed")
    ).toBe("true");

    // The cancelled booking bar is not rendered.
    expect(screen.queryByText(/Casey Cancelled/)).toBeNull();
  });

  it("shows cancelled bookings after the Cancelled pill is toggled on", async () => {
    render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancelled" }));

    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByText(/Casey Cancelled/)).toBeTruthy();
  });

  it("persists the status toggles across visits (#1039)", async () => {
    const { unmount } = render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelled" }));
    unmount();

    // A fresh mount (new visit) restores the stored choice instead of the
    // hide-cancelled default.
    render(<AdminBookingCalendar />);
    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByText(/Casey Cancelled/)).toBeTruthy();
  });

  it("falls back to the hide-cancelled default when storage holds garbage (#1039)", async () => {
    window.localStorage.setItem(
      "admin-calendar-enabled-statuses",
      "not json at all",
    );

    render(<AdminBookingCalendar />);
    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("false");
    expect(screen.queryByText(/Casey Cancelled/)).toBeNull();
  });
});

// A day that exists in every month; days 5..19 are covered by the fixtures.
const CONCURRENT_START = 5;
const CONCURRENT_CHECKOUT = 9; // covers nights 5..8

function concurrentResponse(
  count: number,
  opts?: { spanning?: boolean },
) {
  const bookings = Array.from({ length: count }, (_, i) => ({
    id: `busy-${i}`,
    memberName: `Member ${i}`,
    checkIn: isoDay(CONCURRENT_START),
    checkOut: isoDay(CONCURRENT_CHECKOUT),
    status: "PAID",
    guestCount: 2,
  }));
  if (opts?.spanning) {
    // Spans ~two weeks so it crosses at least one week boundary in any month.
    bookings.push({
      id: "spanner",
      memberName: "Spanner Sam",
      checkIn: isoDay(CONCURRENT_START),
      checkOut: isoDay(20),
      status: "PAID",
      guestCount: 3,
    });
  }
  return { bookings, availability: {} };
}

function stubCalendar(response: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => response }),
  );
}

function assertBarsWithinBands(container: HTMLElement) {
  const bars = container.querySelectorAll<HTMLElement>("[data-booking-id]");
  expect(bars.length).toBeGreaterThan(0);
  bars.forEach((bar) => {
    const rowTop = Number(bar.getAttribute("data-row-top"));
    const rowHeight = Number(bar.getAttribute("data-row-height"));
    const top = parseFloat(bar.style.top);
    const height = parseFloat(bar.style.height);
    // Every bar segment sits inside its own week row band, so nothing paints
    // over the row below (#2088).
    expect(top).toBeGreaterThanOrEqual(rowTop);
    expect(top + height).toBeLessThanOrEqual(rowTop + rowHeight + 0.01);
  });
}

describe("AdminBookingCalendar overflow layout (#2088)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  for (const count of [4, 6, 10]) {
    it(`keeps every bar inside its week band with ${count} concurrent bookings`, async () => {
      stubCalendar(concurrentResponse(count, { spanning: true }));
      const { container } = render(<AdminBookingCalendar />);

      await waitFor(() => {
        expect(container.querySelectorAll("[data-booking-id]").length).toBeGreaterThan(0);
      });

      assertBarsWithinBands(container);
    });
  }

  it("shows no '+N more' affordance when bookings stay within the lane cap", async () => {
    stubCalendar(concurrentResponse(4));
    const { container } = render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(container.querySelectorAll("[data-booking-id]").length).toBeGreaterThan(0);
    });

    expect(container.querySelector("[data-more-day]")).toBeNull();
  });

  it("collapses the surplus into '+N more' and opens the complete day list", async () => {
    stubCalendar(concurrentResponse(10));
    const { container } = render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(container.querySelectorAll("[data-booking-id]").length).toBeGreaterThan(0);
    });

    // Only 5 of the 10 lanes render as bars; the remainder collapse to a chip.
    const more = container.querySelector<HTMLElement>("[data-more-day]");
    expect(more).not.toBeNull();
    expect(more?.textContent).toMatch(/\+5 more/);

    // A hidden booking (lane 5+) is not painted anywhere until the list opens.
    expect(screen.queryByText("Member 9")).toBeNull();

    fireEvent.click(more as HTMLElement);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/10 bookings/)).toBeTruthy();
    // The full list includes the bookings that were collapsed under the cap.
    expect(within(dialog).getByText("Member 9")).toBeTruthy();
    expect(within(dialog).getByText("Member 0")).toBeTruthy();
  });
});

describe("AdminBookingCalendar past-day greying (#2088 D-G2)", () => {
  // Fake only Date so React Testing Library's real timers still drive waitFor.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // NZ (UTC+12) reads this instant as 2026-06-15, and a UTC test runner reads
    // the same calendar month, so the visible month is June 2026 either way.
    vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
    stubCalendar({ bookings: [], availability: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  const dataPast = (container: HTMLElement, day: string) =>
    container
      .querySelector(`[data-day="${day}"]`)
      ?.getAttribute("data-past") ?? null;

  it("greys strictly-past days but leaves today and future days live", () => {
    const { container } = render(<AdminBookingCalendar />);

    // Today (NZ) stays live.
    expect(container.querySelector('[data-day="2026-06-15"]')).not.toBeNull();
    expect(dataPast(container, "2026-06-15")).toBeNull();

    // A finished day earlier in the month is greyed.
    expect(dataPast(container, "2026-06-14")).toBe("true");
    // The first of the month (a month-boundary day) is greyed when past.
    expect(dataPast(container, "2026-06-01")).toBe("true");

    // A future day stays live.
    expect(dataPast(container, "2026-06-20")).toBeNull();
  });

  it("greys an entire finished previous month across the boundary", async () => {
    const { container } = render(<AdminBookingCalendar />);

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(screen.getByText("May 2026")).toBeTruthy());

    // The previous month is wholly in the past — its last day greys too.
    expect(dataPast(container, "2026-05-31")).toBe("true");
    expect(dataPast(container, "2026-05-01")).toBe("true");
  });

  it("leaves a future month entirely live", async () => {
    const { container } = render(<AdminBookingCalendar />);

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() => expect(screen.getByText("July 2026")).toBeTruthy());

    expect(dataPast(container, "2026-07-01")).toBeNull();
    expect(dataPast(container, "2026-07-15")).toBeNull();
  });
});
