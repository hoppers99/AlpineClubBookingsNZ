// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `SeasonsSection`'s own behaviour, at the section boundary C23 (#261) created.
 *
 * The lodge-scope PIN is the reason this file exists rather than leaning on
 * the generic census/behaviour suites alone. Those prove the SHAPE
 * (`deriveSettledLodgeOptionScope`, `activeScopeRef`, a `useLayoutEffect`
 * write) is present in this file; they do not prove it actually stops a
 * late response from a lodge the operator has since left from landing. That
 * is the C6 defect class this test drives end to end: switch the lodge
 * picker mid-request, let the stale response resolve, and check nothing
 * from it reached the screen.
 *
 * `emitSetupReadinessInputChanged()` is pinned the same way
 * `lodges-section.test.tsx` pins it for `LodgesSection` — by counting the
 * DOM event, not by re-deriving the announcement from a mocked call — so a
 * write that skips the emit fails here first, before the wizard-panes suite
 * (which only proves the wizard's OWN journey re-read follows it).
 */

const mocks = vi.hoisted(() => ({
  canEdit: vi.fn<() => boolean | undefined>(() => true),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

import { SeasonsSection } from "@/app/(admin)/admin/seasons/seasons-section";
import { SETUP_READINESS_INPUT_CHANGED_EVENT } from "@/lib/setup-readiness-events";

type LodgeFixture = { id: string; name: string };

type SeasonFixture = {
  id: string;
  name: string;
  type: "WINTER" | "SUMMER";
  startDate: string;
  endDate: string;
  active: boolean;
};

function lodgeFixture(overrides: Partial<LodgeFixture> = {}): LodgeFixture {
  return { id: "lodge-1", name: "Lodge One", ...overrides };
}

function seasonFixture(overrides: Partial<SeasonFixture> = {}): SeasonFixture {
  return {
    id: "season-1",
    name: "Winter 2026",
    type: "WINTER",
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    active: true,
    ...overrides,
  };
}

/**
 * The lodge list and a per-lodge season list, with GET/PUT/DELETE all
 * routed against whichever lodge the query string or path names. `delayPut`
 * lets a test hold a PUT open so it can switch the lodge picker before the
 * response resolves — the stale-scope proof.
 */
function stubFetch(
  lodges: LodgeFixture[],
  seasonsByLodge: Record<string, SeasonFixture[]>,
  options: { delayPut?: boolean } = {},
) {
  const state = new Map(
    Object.entries(seasonsByLodge).map(([id, seasons]) => [
      id,
      seasons.map((s) => ({ ...s })),
    ]),
  );
  let releasePut: (() => void) | undefined;
  const putGate = options.delayPut
    ? new Promise<void>((resolve) => {
        releasePut = resolve;
      })
    : Promise.resolve();

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === "/api/admin/lodges") {
      return { ok: true, status: 200, json: async () => ({ lodges }) };
    }
    if (target.startsWith("/api/admin/seasons?lodgeId=")) {
      const lodgeId = decodeURIComponent(target.split("lodgeId=")[1] ?? "");
      // A FRESH array each time: React's setState bails out of re-rendering
      // when the new array is reference-equal to the last one, and the state
      // Map below mutates in place rather than replacing.
      return { ok: true, status: 200, json: async () => [...(state.get(lodgeId) ?? [])] };
    }
    if (target.startsWith("/api/admin/seasons/")) {
      const id = target.slice("/api/admin/seasons/".length);
      if (init?.method === "DELETE") {
        for (const seasons of state.values()) {
          const idx = seasons.findIndex((s) => s.id === id);
          if (idx >= 0) seasons.splice(idx, 1);
        }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (init?.method === "PUT") {
        await putGate;
        const body = JSON.parse(String(init.body ?? "{}")) as Partial<SeasonFixture>;
        let updated: SeasonFixture | undefined;
        for (const seasons of state.values()) {
          const idx = seasons.findIndex((s) => s.id === id);
          if (idx >= 0) {
            seasons[idx] = { ...seasons[idx], ...body };
            updated = seasons[idx];
          }
        }
        return { ok: true, status: 200, json: async () => updated ?? {} };
      }
    }
    throw new Error(`unhandled fetch: ${target}`);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return { fetchMock, releasePut: () => releasePut?.() };
}

/** Counts the readiness announcements this render makes. */
function countReadinessEmits() {
  const seen = { n: 0 };
  const listener = () => {
    seen.n += 1;
  };
  window.addEventListener(SETUP_READINESS_INPUT_CHANGED_EVENT, listener);
  return {
    get count() {
      return seen.n;
    },
    stop: () =>
      window.removeEventListener(SETUP_READINESS_INPUT_CHANGED_EVENT, listener),
  };
}

function selectLodge(name: string) {
  // `LodgeSelect` is a real, unmocked Radix combobox here (unlike the wizard
  // suite, which mocks it). `lodge-select.test.tsx` opens it with a keydown
  // rather than a click — Radix's open animation makes a click-then-click
  // sequence flaky in jsdom.
  // Scoped by name: the edit form's own "Type" `<select>` also resolves to
  // role "combobox", and can be open on screen at the same time.
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Lodge" }), {
    key: "ArrowDown",
  });
  fireEvent.click(screen.getByRole("option", { name }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.canEdit.mockReturnValue(true);
});

describe("editing a season window", () => {
  it("PUTs the window fields only, and announces the readiness change once saved", async () => {
    const { fetchMock } = stubFetch(
      [lodgeFixture()],
      { "lodge-1": [seasonFixture()] },
    );
    const emits = countReadinessEmits();

    render(<SeasonsSection />);
    await screen.findByText("Winter 2026");
    expect(emits.count).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Edit window" }));
    fireEvent.change(screen.getByLabelText("Season Name"), {
      target: { value: "Winter 2027" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Season" }));

    await waitFor(() => expect(screen.getByText("Winter 2027")).toBeInTheDocument());
    expect(emits.count).toBe(1);

    const put = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/admin/seasons/season-1" &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(put).toBeDefined();
    const body = JSON.parse(String((put?.[1] as RequestInit).body));
    // Window-only: no membershipTypeRates, so the route's own guard leaves
    // rates untouched (this section never sends them).
    expect(body).not.toHaveProperty("membershipTypeRates");
    emits.stop();
  });
});

describe("deleting and toggling a season", () => {
  it("deletes after the operator confirms, and announces the readiness change", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    stubFetch([lodgeFixture()], { "lodge-1": [seasonFixture()] });
    const emits = countReadinessEmits();

    render(<SeasonsSection />);
    await screen.findByText("Winter 2026");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText(/No seasons configured yet/)).toBeInTheDocument(),
    );
    expect(emits.count).toBe(1);
    emits.stop();
  });

  it("does not delete, and does not announce, when the operator declines", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    stubFetch([lodgeFixture()], { "lodge-1": [seasonFixture()] });
    const emits = countReadinessEmits();

    render(<SeasonsSection />);
    await screen.findByText("Winter 2026");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByText("Winter 2026")).toBeInTheDocument();
    expect(emits.count).toBe(0);
    emits.stop();
  });

  it("toggles active, flips the badge, and announces the readiness change", async () => {
    stubFetch([lodgeFixture()], { "lodge-1": [seasonFixture({ active: true })] });
    const emits = countReadinessEmits();

    render(<SeasonsSection />);
    await screen.findByText("Winter 2026");
    expect(screen.getByText("Active")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(screen.getByText("Inactive")).toBeInTheDocument());
    expect(emits.count).toBe(1);
    emits.stop();
  });
});

describe("the lodge-scope pin (#2887, the C6 defect class)", () => {
  it("does not apply a PUT response from a lodge the operator has since left", async () => {
    /*
      MUTATION PROBE: delete the `if (activeScopeRef.current !== requestedScope)
      return` guard in `handleSubmit` (`seasons-section.tsx`) and this fails —
      "Winter Renamed" lands under Lodge Two even though the request was made,
      and answered, while Lodge One was current.
    */
    const { releasePut } = stubFetch(
      [lodgeFixture(), lodgeFixture({ id: "lodge-2", name: "Lodge Two" })],
      {
        "lodge-1": [seasonFixture()],
        "lodge-2": [seasonFixture({ id: "season-2", name: "Summer 2026", type: "SUMMER" })],
      },
      { delayPut: true },
    );

    render(<SeasonsSection />);
    await screen.findByText("Winter 2026");

    fireEvent.click(screen.getByRole("button", { name: "Edit window" }));
    fireEvent.change(screen.getByLabelText("Season Name"), {
      target: { value: "Winter Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Season" }));

    // The PUT is in flight (gated on `releasePut`). Switch scope before it
    // resolves — the exact race `activeScopeRef` exists to fence.
    await selectLodge("Lodge Two");
    await screen.findByText("Summer 2026");

    releasePut();

    // Give the resolved-but-fenced PUT a turn to (wrongly) apply if the guard
    // were gone, then assert Lodge Two's own list is what is still on screen.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("Summer 2026")).toBeInTheDocument();
    expect(screen.queryByText("Winter Renamed")).not.toBeInTheDocument();
    expect(screen.queryByText("Winter 2026")).not.toBeInTheDocument();
  });

  it("fetches no seasons before a lodge has settled", async () => {
    const { fetchMock } = stubFetch([], {});

    render(<SeasonsSection />);

    await waitFor(() =>
      expect(screen.getByText(/lodge/i)).toBeInTheDocument(),
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).startsWith("/api/admin/seasons?lodgeId="),
      ),
    ).toBe(false);
  });
});

describe("the section carries its own view-only banner", () => {
  it("heads a bookings:view admin's screen with it, and disables every action", async () => {
    mocks.canEdit.mockReturnValue(false);
    stubFetch([lodgeFixture()], { "lodge-1": [seasonFixture()] });

    render(<SeasonsSection />);
    await screen.findByText("Winter 2026");

    expect(
      screen.getByText(
        "Bookings view access can inspect season windows. Bookings edit access is required to change them.",
      ),
    ).toBeInTheDocument();
    // #2160: no per-row action controls render at all for a view-only admin
    // (the section's own `canEdit &&` gate), rather than rendering them
    // disabled.
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit window" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});
