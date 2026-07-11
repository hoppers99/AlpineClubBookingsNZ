// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DisplayState, DisplayStateBooking } from "@/lib/lodge-display-state";
import {
  ArrivalsBoard,
  barNames,
  computeBarLayout,
} from "@/components/lodge-display/modules/arrivals-board";
import { OccupancyGrid } from "@/components/lodge-display/modules/occupancy-grid";
import { SinglesBoard } from "@/components/lodge-display/modules/singles-board";
import { WelcomePanel } from "@/components/lodge-display/modules/welcome-panel";
import { DISPLAY_MODULE_COMPONENTS } from "@/components/lodge-display/modules";
import { intOption } from "@/components/lodge-display/modules/module-options";

// Issue #30 (LTV-005): the booking/occupancy display modules — pure functions
// of the privacy-reduced DisplayState. Fixtures mirror the payload the
// serialiser emits; no module ever queries anything.

const WINDOW = ["2026-04-13", "2026-04-14", "2026-04-15"];

function row(overrides: Partial<DisplayStateBooking>): DisplayStateBooking {
  return {
    key: "row-1-0",
    label: "Olive O",
    wholeLodge: false,
    roomId: null,
    guests: [
      { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
    ],
    guestCount: 1,
    stayStart: "2026-04-13",
    stayEnd: "2026-04-15",
    ...overrides,
  };
}

function state(overrides: Partial<DisplayState>): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: WINDOW.map((date) => ({
      date,
      arriving: 0,
      departing: 0,
      staying: 0,
    })),
    chores: [],
    rules: null,
    notice: null,
    config: {},
    ...overrides,
  };
}

describe("bar layout maths (clipping regression surface)", () => {
  it("places an in-window stay on the right columns", () => {
    expect(
      computeBarLayout({ stayStart: "2026-04-14", stayEnd: "2026-04-15" }, WINDOW)
    ).toEqual({
      startColumn: 2,
      spanColumns: 2,
      startsBeforeWindow: false,
      endsAfterWindow: false,
    });
  });

  it("clamps stays that started earlier or run past the window, and flags them", () => {
    expect(
      computeBarLayout({ stayStart: "2026-04-10", stayEnd: "2026-04-20" }, WINDOW)
    ).toEqual({
      startColumn: 1,
      spanColumns: 3,
      startsBeforeWindow: true,
      endsAfterWindow: true,
    });
  });

  it("returns null for a stay entirely outside the window", () => {
    expect(
      computeBarLayout({ stayStart: "2026-05-01", stayEnd: "2026-05-03" }, WINDOW)
    ).toBeNull();
  });
});

describe("bar names overflow (AC2)", () => {
  it("shows up to the max then an explicit +N", () => {
    const guests = ["A", "B", "C", "D", "E", "F", "G"].map((n) => ({
      label: `${n} X`,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-14",
    }));
    const result = barNames(row({ guests, guestCount: 7 }), 5);
    expect(result.names).toHaveLength(5);
    expect(result.overflow).toBe(2);
  });

  it("falls back to the booking label when names are withheld", () => {
    const result = barNames(row({ guests: null, label: "Harakeke College", guestCount: 14 }), 5);
    expect(result.names).toEqual(["Harakeke College"]);
    expect(result.overflow).toBe(0);
  });
});

describe("ArrivalsBoard", () => {
  it("renders room rows when allocation is on, including an Unassigned lane", () => {
    render(
      <ArrivalsBoard
        state={state({
          rooms: [
            { id: "r1", name: "Kea" },
            { id: "r2", name: "Tui" },
          ],
          bookings: [
            row({ key: "a", roomId: "r1" }),
            row({ key: "b", roomId: null, label: "Rewi P" }),
          ],
        })}
      />
    );
    expect(screen.getByText("Kea")).toBeDefined();
    expect(screen.getByText("Unassigned")).toBeDefined();
    expect(screen.queryByText("Tui")).toBeDefined(); // empty room still shows its lane
  });

  it("renders overflow with an explicit +N and never throws on bad options (AC6)", () => {
    const guests = ["A", "B", "C", "D", "E", "F"].map((n) => ({
      label: `${n} X`,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-14",
    }));
    render(
      <ArrivalsBoard
        state={state({ bookings: [row({ guests, guestCount: 6 })] })}
        options={{ days: "banana", "max-names": -3 }}
      />
    );
    // max-names clamps to 1 → 5 overflow
    expect(screen.getByText("+5")).toBeDefined();
  });
});

describe("OccupancyGrid / WelcomePanel (whole-lodge treatment, AC3/AC5)", () => {
  const blockoutState = state({
    bookings: [
      row({
        wholeLodge: true,
        label: "Harakeke College",
        guests: null,
        guestCount: 14,
        stayEnd: "2026-04-15",
      }),
    ],
  });

  it("blockout shows the group label only — no individual names exist to leak", () => {
    const { container } = render(<OccupancyGrid state={blockoutState} />);
    expect(screen.getByText("Harakeke College")).toBeDefined();
    expect(container.textContent).toContain("14 guests");
  });

  it("welcome renders with zero options and greets the group when present", () => {
    render(<WelcomePanel state={blockoutState} />);
    expect(screen.getByText(/Welcome to Silverpeak Lodge/)).toBeDefined();
    expect(screen.getByText("Harakeke College")).toBeDefined();
  });
});

describe("SinglesBoard (AC4)", () => {
  it("renders one row per guest with their own check-out when rooms is null", () => {
    render(
      <SinglesBoard
        state={state({
          bookings: [
            row({
              guests: [
                { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-14" },
                { label: "Rewi P", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
              ],
              guestCount: 2,
            }),
          ],
        })}
      />
    );
    expect(screen.getByText("Jane S")).toBeDefined();
    expect(screen.getByText("out 2026-04-14")).toBeDefined();
    expect(screen.getByText("out 2026-04-15")).toBeDefined();
  });

  it("keeps reduced labels for counts-only rows", () => {
    render(
      <SinglesBoard
        state={state({
          bookings: [row({ guests: null, label: "Guests · 3", guestCount: 3 })],
        })}
      />
    );
    expect(screen.getByText(/Guests · 3/)).toBeDefined();
  });
});

describe("module map and options (AC6/AC7)", () => {
  it("maps this task's four registry names to components (later tasks add theirs)", () => {
    const keys = Object.keys(DISPLAY_MODULE_COMPONENTS);
    for (const name of ["arrivals-board", "occupancy-grid", "singles-board", "welcome"]) {
      expect(keys).toContain(name);
    }
  });

  it("intOption clamps and falls back per documented defaults", () => {
    expect(intOption(undefined, "days", 3, { min: 1, max: 7 })).toBe(3);
    expect(intOption({ days: "4" }, "days", 3, { min: 1, max: 7 })).toBe(4);
    expect(intOption({ days: 99 }, "days", 3, { min: 1, max: 7 })).toBe(7);
    expect(intOption({ days: "banana" }, "days", 3, { min: 1, max: 7 })).toBe(3);
  });
});
