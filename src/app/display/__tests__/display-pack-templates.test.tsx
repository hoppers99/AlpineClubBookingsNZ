// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import type { DisplayState } from "@/lib/lodge-display-state";

// Issue #2047 — the template pack renders end to end through the REAL server
// assembler (buildLayoutRender) and the REAL client layout engine (DisplayScreen
// → LayoutScreen → Area/RotatorArea), mirroring the LTV-038 parity smoke. Two
// sources of truth are exercised:
//   • the four BUILT-IN pack boards, straight from built-in-seeds.ts;
//   • the two EXTRAS boards, parsed from the committed importable bundle
//     (docs/lobby-display/seeds/display-template-pack.bundle.zip) — so the test
//     proves the shipped artifact renders, not a hand-copied duplicate.
// Each new template gets a render assertion (incl. the rotator cases and the
// chores-off degradation case), plus the welcome-kiosk no-guest-names guarantee.
//
// buildLayoutRender imports the server-only sanitiser; stub `server-only` and
// import it dynamically (mirrors display-built-in-parity.test).
vi.mock("server-only", () => ({}));

let buildLayoutRender: (typeof import("@/lib/lodge-display/layout-render"))["buildLayoutRender"];

interface Def {
  bodyHtml: string;
  defaultCss: string;
  areas: unknown;
  slotContent: unknown;
  cssOverrides: string;
  footerHtml: string;
}

/** Load the extras bundle's layouts + templates from the committed zip. */
function loadExtras(): {
  layouts: Record<string, { bodyHtml: string; defaultCss: string; areas: unknown }>;
  templates: Record<
    string,
    { layoutKey: string; slotContent: unknown; cssOverrides: string; footerHtml: string }
  >;
} {
  const zipPath = path.join(
    process.cwd(),
    "docs/lobby-display/seeds/display-template-pack.bundle.zip"
  );
  const files = unzipSync(readFileSync(zipPath));
  const layoutsJson = JSON.parse(strFromU8(files["display/layouts.json"])) as Array<{
    key: string;
    bodyHtml: string;
    defaultCss: string;
    areas: unknown;
  }>;
  const templatesJson = JSON.parse(
    strFromU8(files["display/templates.json"])
  ) as Array<{
    key: string;
    layoutKey: string;
    slotContent: unknown;
    cssOverrides: string;
    footerHtml: string;
  }>;
  const layouts = Object.fromEntries(layoutsJson.map((l) => [l.key, l]));
  const templates = Object.fromEntries(templatesJson.map((t) => [t.key, t]));
  return { layouts, templates };
}

/** Build a Def for a committed built-in by key. */
async function builtInDef(key: string): Promise<Def> {
  const { BUILT_IN_DISPLAY_LAYOUTS, BUILT_IN_DISPLAY_TEMPLATES } = await import(
    "@/lib/lodge-display/built-in-seeds"
  );
  const layout = BUILT_IN_DISPLAY_LAYOUTS.find((l) => l.key === key)!;
  const template = BUILT_IN_DISPLAY_TEMPLATES.find((t) => t.key === key)!;
  return {
    bodyHtml: layout.bodyHtml,
    defaultCss: layout.defaultCss,
    areas: layout.areas,
    slotContent: template.slotContent,
    cssOverrides: template.cssOverrides,
    footerHtml: template.footerHtml,
  };
}

const FALLBACK_TEMPLATE_FIELD = {
  key: "everyday-board",
  name: "Everyday board",
  regions: [{ key: "main", panels: [{ module: "arrivals-board" }] }],
};

const queue: Array<{ match: (url: string) => boolean; body: unknown }> = [];

beforeEach(async () => {
  vi.useFakeTimers();
  queue.length = 0;
  ({ buildLayoutRender } = await import("@/lib/lodge-display/layout-render"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const index = queue.findIndex((entry) => entry.match(url));
      if (index === -1) throw new Error(`no queued response for ${url}`);
      const [entry] = queue.splice(index, 1);
      return new Response(JSON.stringify(entry.body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Render a (layout+template) def against a DisplayState through the real
 * server assembly + client layout engine; returns the mounted container. */
async function renderBoard(def: Def, state: DisplayState) {
  const layoutRender = buildLayoutRender(
    {
      bodyHtml: def.bodyHtml,
      defaultCss: def.defaultCss,
      areas: def.areas as never,
      slotContent: def.slotContent as never,
      cssOverrides: def.cssOverrides,
      footerHtml: def.footerHtml,
    },
    state
  );
  queue.push({
    match: (url) => url.includes("/api/display/state"),
    body: { ...state, template: FALLBACK_TEMPLATE_FIELD, layoutRender },
  });
  const { DisplayScreen } = await import("@/app/display/display-screen");
  const utils = render(<DisplayScreen />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  return utils;
}

// --- state fixtures --------------------------------------------------------

const WINDOW3 = ["2026-04-13", "2026-04-14", "2026-04-15"];

function baseState(overrides: Partial<DisplayState> = {}): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: WINDOW3.map((date) => ({ date, arriving: 0, departing: 0, staying: 0 })),
    chores: [],
    rules: null,
    notice: null,
    config: {},
    capabilities: { bedAllocation: false, chores: false },
    ...overrides,
  } as DisplayState;
}

describe("issue #2047 pack — built-in boards", () => {
  it("room-by-room renders the room cards main + arrivals side rail", async () => {
    const def = await builtInDef("room-by-room");
    const state = baseState({
      rooms: [
        { id: "r1", name: "Kea" },
        { id: "r2", name: "Tui" },
      ],
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: "r1",
          guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 1, departing: 0, staying: 1 },
        { date: "2026-04-14", arriving: 0, departing: 0, staying: 1 },
        { date: "2026-04-15", arriving: 0, departing: 1, staying: 1 },
      ],
      capabilities: { bedAllocation: true, chores: false },
    });
    const { container } = await renderBoard(def, state);

    const rooms = container.querySelector(".display-room-cards");
    const arrivals = container.querySelector(".display-arrivals-board");
    expect(rooms).not.toBeNull();
    expect(arrivals).not.toBeNull();
    // The room cards sit in the main column, the arrivals board in the rail.
    expect(rooms?.closest(".rbr-main")).not.toBeNull();
    expect(arrivals?.closest(".rbr-rail")).not.toBeNull();
  });

  it("week-ahead renders the next-nights planner and the notice band when a notice is set", async () => {
    const def = await builtInDef("week-ahead");
    const state = baseState({
      rooms: [{ id: "r1", name: "Kea" }],
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: "r1",
          guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 1, departing: 0, staying: 1 },
        { date: "2026-04-14", arriving: 0, departing: 0, staying: 1 },
        { date: "2026-04-15", arriving: 0, departing: 1, staying: 1 },
      ],
      notice: "Snow report at 8am",
      capabilities: { bedAllocation: true, chores: false },
    });
    const { container } = await renderBoard(def, state);

    expect(container.querySelector(".display-night-columns")).not.toBeNull();
    const notice = container.querySelector(".display-notice-board");
    expect(notice).not.toBeNull();
    expect(notice?.closest(".wa-band")).not.toBeNull();
    expect(screen.getByText(/Snow report at 8am/)).toBeDefined();
  });

  it("week-ahead drops the notice band when no notice is set (conditional area)", async () => {
    const def = await builtInDef("week-ahead");
    const { container } = await renderBoard(def, baseState({ notice: null }));
    expect(container.querySelector(".display-night-columns")).not.toBeNull();
    expect(container.querySelector(".display-notice-board")).toBeNull();
  });

  it("operations-board renders status + chores + notice with the Chores module on", async () => {
    const def = await builtInDef("operations-board");
    const state = baseState({
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: null,
          guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
        },
      ],
      chores: [
        { date: "2026-04-13", title: "Sweep the bunkroom", assigneeLabels: ["Sam T"] },
      ],
      notice: "Committee meeting Friday",
      capabilities: { bedAllocation: false, chores: true },
    });
    const { container } = await renderBoard(def, state);

    expect(container.querySelector(".display-status-board")).not.toBeNull();
    expect(container.querySelector(".display-chores-board")).not.toBeNull();
    expect(container.querySelector(".display-notice-board")).not.toBeNull();
    // No disabled placeholder while chores are on.
    expect(container.querySelector("[data-module-disabled]")).toBeNull();
  });

  it("operations-board auto-degrades gracefully when the Chores module is off", async () => {
    const def = await builtInDef("operations-board");
    const state = baseState({
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: null,
          guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
        },
      ],
      chores: [],
      notice: "Committee meeting Friday",
      capabilities: { bedAllocation: false, chores: false },
    });
    const { container } = await renderBoard(def, state);

    // The status board and the notice still render; the chores card hides itself
    // to an empty placeholder so the rail keeps its shape (no empty card, no crash).
    expect(container.querySelector(".display-status-board")).not.toBeNull();
    expect(container.querySelector(".display-notice-board")).not.toBeNull();
    expect(container.querySelector(".display-chores-board")).toBeNull();
    expect(
      container.querySelector("[data-module-disabled='chores-board']")
    ).not.toBeNull();
  });

  it("welcome-kiosk renders the welcome hero + rotator (house rules first) and NO guest names", async () => {
    const def = await builtInDef("welcome-kiosk");
    // A whole-lodge group (label only) AND a named individual booking present:
    // the kiosk must surface neither the individual's name nor any board of names.
    const state = baseState({
      bookings: [
        {
          key: "wl",
          label: "Harakeke College",
          wholeLodge: true,
          roomId: null,
          guests: null,
          guestCount: 20,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
        },
        {
          key: "ind",
          label: "Priya N",
          wholeLodge: false,
          roomId: null,
          guests: [{ label: "Priya Nathan", stayStart: "2026-04-13", stayEnd: "2026-04-14" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-14",
        },
      ],
      rules: [{ title: "House rules", html: "<p>Boots off at the door.</p>" }],
      notice: "Committee meeting Friday",
    });
    const { container } = await renderBoard(def, state);

    // Welcome hero present; the rotator's first eligible child (house rules) shows.
    expect(container.querySelector(".display-welcome")).not.toBeNull();
    expect(container.querySelector(".display-lodge-rules")).not.toBeNull();
    expect(screen.getByText(/Boots off at the door/)).toBeDefined();

    // No individual guest name anywhere — the maximum-privacy guarantee. The only
    // name-bearing modules (arrivals/room/status/singles/night) are never embedded.
    const text = container.textContent ?? "";
    expect(text).not.toContain("Priya");
    expect(container.querySelector(".display-arrivals-board")).toBeNull();
    expect(container.querySelector(".display-room-cards")).toBeNull();
    expect(container.querySelector(".display-status-board")).toBeNull();
    expect(container.querySelector(".display-singles-board")).toBeNull();
    expect(container.querySelector(".display-night-columns")).toBeNull();
  });
});

describe("issue #2047 pack — extras bundle boards (from the committed zip)", () => {
  it("busy-weekend rotates the occupancy blockout in first while the lodge is booked out", async () => {
    const { layouts, templates } = loadExtras();
    const t = templates["busy-weekend"];
    const l = layouts[t.layoutKey];
    const def: Def = {
      bodyHtml: l.bodyHtml,
      defaultCss: l.defaultCss,
      areas: l.areas,
      slotContent: t.slotContent,
      cssOverrides: t.cssOverrides,
      footerHtml: t.footerHtml,
    };
    const state = baseState({
      rooms: [
        { id: "r1", name: "Kea" },
        { id: "r2", name: "Tui" },
      ],
      bookings: [
        {
          key: "wl",
          label: "Harakeke College",
          wholeLodge: true,
          roomId: null,
          guests: null,
          guestCount: 20,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 20, departing: 0, staying: 20 },
        { date: "2026-04-14", arriving: 0, departing: 0, staying: 20 },
        { date: "2026-04-15", arriving: 0, departing: 20, staying: 0 },
      ],
      capabilities: { bedAllocation: true, chores: false },
    });
    const { container } = await renderBoard(def, state);
    // occupancy child is condition-eligible (a whole-lodge booking is in window),
    // so it is the first rotator child rendered.
    expect(container.querySelector(".display-occupancy-grid, .display-blockout-board")).not.toBeNull();
    expect(screen.getByText("Harakeke College")).toBeDefined();
  });

  it("busy-weekend falls to the arrivals board when no whole-lodge booking is in the window", async () => {
    const { layouts, templates } = loadExtras();
    const t = templates["busy-weekend"];
    const l = layouts[t.layoutKey];
    const def: Def = {
      bodyHtml: l.bodyHtml,
      defaultCss: l.defaultCss,
      areas: l.areas,
      slotContent: t.slotContent,
      cssOverrides: t.cssOverrides,
      footerHtml: t.footerHtml,
    };
    const state = baseState({
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: null,
          guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-14" }],
          guestCount: 1,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-14",
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 1, departing: 0, staying: 1 },
        { date: "2026-04-14", arriving: 0, departing: 1, staying: 0 },
        { date: "2026-04-15", arriving: 0, departing: 0, staying: 0 },
      ],
    });
    const { container } = await renderBoard(def, state);
    // occupancy child is filtered out (no whole-lodge booking) → arrivals is first.
    expect(container.querySelector(".display-arrivals-board")).not.toBeNull();
    expect(container.querySelector(".display-blockout-board")).toBeNull();
  });

  it("arrivals-strip renders the arrivals strip + welcome panel (small-screen board)", async () => {
    const { layouts, templates } = loadExtras();
    const t = templates["arrivals-strip"];
    const l = layouts[t.layoutKey];
    const def: Def = {
      bodyHtml: l.bodyHtml,
      defaultCss: l.defaultCss,
      areas: l.areas,
      slotContent: t.slotContent,
      cssOverrides: t.cssOverrides,
      footerHtml: t.footerHtml,
    };
    const state = baseState({
      bookings: [
        {
          key: "a",
          label: "Jane O",
          wholeLodge: false,
          roomId: null,
          guests: [
            { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-14" },
            { label: "Rewi P", stayStart: "2026-04-13", stayEnd: "2026-04-14" },
          ],
          guestCount: 2,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-14",
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 2, departing: 0, staying: 2 },
        { date: "2026-04-14", arriving: 0, departing: 2, staying: 0 },
        { date: "2026-04-15", arriving: 0, departing: 0, staying: 0 },
      ],
    });
    const { container } = await renderBoard(def, state);
    expect(container.querySelector(".display-arrivals-board")).not.toBeNull();
    expect(container.querySelector(".display-welcome")).not.toBeNull();
    // lead-count name style (arrivals-board splits the lead name + overflow into
    // sibling spans): the lead name shows and the rest fold into a "+N" overflow,
    // rather than the second guest being spelled out.
    expect(screen.getByText("Jane S")).toBeDefined();
    expect(container.querySelector(".display-bar-overflow")?.textContent).toContain("+1");
    expect(screen.queryByText(/Rewi P/)).toBeNull();
  });
});
