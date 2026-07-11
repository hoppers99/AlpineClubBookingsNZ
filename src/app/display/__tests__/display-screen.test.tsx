// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayScreen } from "@/app/display/display-screen";

// Issue #32 (LTV-007): the display page lifecycle — pairing (code shown,
// claim polled), active (template rendered from the payload), transient
// failure (last good payload retained, stale badge past the threshold), and
// revocation (back to pairing within one poll).

const PAYLOAD = {
  lodge: { name: "Silverpeak Lodge" },
  generatedAt: "2026-04-13T00:00:00.000Z",
  window: { start: "2026-04-13", days: 3 },
  rooms: null,
  bookings: [
    {
      key: "row-1-0",
      label: "Olive O",
      wholeLodge: false,
      roomId: null,
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
  chores: [],
  rules: null,
  notice: null,
  config: { "wifi-code": "alpine1234" },
  template: {
    key: "everyday-board",
    name: "Everyday board",
    regions: [
      { key: "header", panels: [{ module: "lodge-header" }] },
      { key: "main", panels: [{ module: "arrivals-board", options: { days: 3 } }] },
      { key: "footer", panels: [{ module: "info-footer" }] },
    ],
  },
};

type QueuedResponse =
  | { status: number; body: unknown }
  | { reject: true };

const queue: Array<{ match: (url: string, init?: RequestInit) => boolean; response: QueuedResponse }> = [];

function enqueue(
  match: (url: string, init?: RequestInit) => boolean,
  response: QueuedResponse
) {
  queue.push({ match, response });
}

beforeEach(() => {
  vi.useFakeTimers();
  queue.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const index = queue.findIndex((entry) => entry.match(url, init));
      if (index === -1) throw new Error(`no queued response for ${url}`);
      const [entry] = queue.splice(index, 1);
      if ("reject" in entry.response) throw new Error("network down");
      return new Response(JSON.stringify(entry.response.body), {
        status: entry.response.status,
        headers: { "content-type": "application/json" },
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const isState = (url: string) => url.includes("/api/display/state");
const isPairStart = (url: string, init?: RequestInit) =>
  url.includes("/api/display/pair") && String(init?.body).includes("start");
const isPairClaim = (url: string, init?: RequestInit) =>
  url.includes("/api/display/pair") && String(init?.body).includes("claim");

describe("display page render mode", () => {
  it("forces dynamic rendering so inline scripts carry the CSP nonce (issue #54)", async () => {
    // A statically prerendered /display ships Next's inline bootstrap
    // scripts without the per-request nonce; the production nonce-only CSP
    // then blocks hydration and the page renders blank on real TVs.
    const page = await import("@/app/display/page");
    expect(page.dynamic).toBe("force-dynamic");
  });
});

describe("DisplayScreen lifecycle", () => {
  it("walks pairing → claim → active, keeps the last payload on failure, and re-pairs on revocation", async () => {
    // 1. unauthorised → pairing start shows the code
    enqueue(isState, { status: 401, body: { error: "Unauthorised" } });
    enqueue(isPairStart, {
      status: 200,
      body: { code: "ABCDEF", expiresAt: "2026-04-13T00:15:00.000Z" },
    });

    render(<DisplayScreen />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText("ABCDEF")).toBeDefined();

    // 2. first claim poll: not yet bound → still pairing
    enqueue(isPairClaim, { status: 200, body: { paired: false } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByText("ABCDEF")).toBeDefined();

    // 3. second claim poll: paired → state fetch → active board renders
    enqueue(isPairClaim, { status: 200, body: { paired: true } });
    enqueue(isState, { status: 200, body: PAYLOAD });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    expect(screen.getByText(/Jane S/)).toBeDefined();
    expect(screen.getByText(/Wi-Fi · alpine1234/)).toBeDefined();

    // 4. transient network failure → last payload retained, no stale badge yet
    enqueue(isState, { reject: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    expect(screen.queryByText(/out of date/)).toBeNull();

    // 5. keep failing past the staleness threshold → badge appears, board stays
    for (let i = 0; i < 3; i++) {
      enqueue(isState, { reject: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    expect(screen.getByText(/out of date/)).toBeDefined();

    // 6. token revoked → 401 → back to the pairing screen within one poll
    enqueue(isState, { status: 401, body: { error: "Unauthorised" } });
    enqueue(isPairStart, {
      status: 200,
      body: { code: "QRSTUV", expiresAt: "2026-04-13T01:15:00.000Z" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText("QRSTUV")).toBeDefined();
    expect(screen.queryByText("Silverpeak Lodge")).toBeNull();
  });

  it("preview mode never pairs: denied shows the admin-login prompt, an admin session renders the board (issue #52)", async () => {
    window.history.pushState({}, "", "/display?previewDevice=dev-9");
    try {
      // The preview query is forwarded verbatim to the state API.
      const isPreviewState = (url: string) =>
        url.includes("/api/display/state?previewDevice=dev-9");

      // 1. not signed in as an admin → denied prompt, NO pairing start
      enqueue(isPreviewState, { status: 401, body: { error: "Unauthorised" } });
      render(<DisplayScreen />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByText("Display preview")).toBeDefined();
      expect(screen.getByText(/administrator login/)).toBeDefined();
      expect(screen.queryByText("Pair this display")).toBeNull();

      // 2. admin signs in elsewhere → the next poll renders the board
      enqueue(isPreviewState, { status: 200, body: PAYLOAD });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    } finally {
      window.history.pushState({}, "", "/display");
    }
  });

  it("renders a neutral placeholder for a module with no renderer yet", async () => {
    enqueue(isState, {
      status: 200,
      body: {
        ...PAYLOAD,
        template: {
          key: "future",
          name: "Future",
          // A name with no renderer (defensive path — real templates are
          // validated against the registry server-side).
          regions: [{ key: "main", panels: [{ module: "future-module" }] }],
        },
      },
    });
    const { container } = render(<DisplayScreen />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(
      container.querySelector('.display-module-placeholder[data-module="future-module"]')
    ).not.toBeNull();
  });
});
