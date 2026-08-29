// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `LodgesSection`'s own behaviour, at the section boundary C19 (#250) created.
 *
 * Two of the three things below had no UI test at all while this was a page,
 * and both are now mounted in a second host — the setup wizard's `lodges` pane
 * — where a failure lands an operator mid-journey rather than on a settings
 * screen they walked to deliberately.
 *
 * 1. **The deactivation force-confirm retry.** The route refuses a deactivation
 *    that would strand future bookings, waitlist entries, hut-leader
 *    assignments or bound kiosks, and answers with the counts; the section
 *    shows them and retries with `force` only if the operator says yes. The
 *    interesting half is the DECLINE: nothing is written, and nothing is
 *    announced.
 *
 * 2. **Which writes announce themselves.** `emitSetupReadinessInputChanged()`
 *    is what makes the wizard's badge, detail lines and per-lodge links catch
 *    up on a save that never left the tab. It must fire once per SUCCESSFUL
 *    write — never on the refused pre-flight, never on a decline.
 *
 * 3. **Create still hands the operator to the per-lodge guided flow**, which
 *    C19 deliberately did not embed.
 *
 * The permission gate is driven through `use-admin-area-edit-access`, the same
 * handle the sibling admin UI suites use, rather than by assembling a session
 * whose access roles happen to resolve to `lodge: view`.
 */

const mocks = vi.hoisted(() => ({
  canEdit: vi.fn<() => boolean | undefined>(() => true),
  push: vi.fn<(href: string) => void>(),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn() }),
}));

import { LodgesSection } from "@/app/(admin)/admin/lodges/lodges-section";
import { SETUP_READINESS_INPUT_CHANGED_EVENT } from "@/lib/setup-readiness-events";

type LodgeFixture = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  address: string | null;
  doorCode: string | null;
  travelNote: string | null;
};

function lodgeFixture(overrides: Partial<LodgeFixture> = {}): LodgeFixture {
  return {
    id: "lodge-1",
    name: "Example Mountain Club Lodge",
    slug: "example-mountain-club-lodge",
    active: true,
    address: null,
    doorCode: null,
    travelNote: null,
    ...overrides,
  };
}

/** The dependency refusal `PATCH /api/admin/lodges/[id]` answers (#221). */
const DEPENDENCY_REFUSAL = {
  error: "Lodge still has dependencies",
  code: "LODGE_HAS_DEPENDENCIES",
  dependencies: {
    futureBookings: 3,
    waitlistEntries: 0,
    hutLeaderAssignments: 1,
    kioskBindings: 0,
  },
};

/**
 * The lodge list, the other-clubs list the vouched panel reads, and a PATCH/POST
 * whose answer the caller controls per test.
 */
function stubFetch(
  lodges: LodgeFixture[],
  respond: (url: string, init?: RequestInit) => { ok: boolean; status: number; body: unknown },
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === "/api/admin/other-lodges") {
      return { ok: true, status: 200, json: async () => ({ lodges: [] }) };
    }
    if (target === "/api/admin/lodges" && !init?.method) {
      return { ok: true, status: 200, json: async () => ({ lodges }) };
    }
    const answer = respond(target, init);
    return {
      ok: answer.ok,
      status: answer.status,
      json: async () => answer.body,
    };
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
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

function writesTo(
  fetchMock: { mock: { calls: readonly (readonly unknown[])[] } },
  url: string,
) {
  return fetchMock.mock.calls.filter(
    ([called, init]) =>
      String(called) === url && (init as RequestInit | undefined)?.method,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.canEdit.mockReturnValue(true);
});

describe("deactivating a lodge that still has dependencies", () => {
  it("names them, and retries with force when the operator confirms", async () => {
    let refused = false;
    const fetchMock = stubFetch([lodgeFixture()], (url, init) => {
      if (url === "/api/admin/lodges/lodge-1") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          force?: boolean;
        };
        if (!body.force && !refused) {
          refused = true;
          return { ok: false, status: 409, body: DEPENDENCY_REFUSAL };
        }
        return { ok: true, status: 200, body: { ok: true } };
      }
      return { ok: true, status: 200, body: { lodges: [] } };
    });
    const emits = countReadinessEmits();
    // Typed with the argument `window.confirm` really takes, so the assertion
    // on the message below reads a parameter the mock's own type knows about
    // rather than indexing an empty tuple.
    const confirm = vi.fn((_message?: string) => true);
    vi.stubGlobal("confirm", confirm);

    render(<LodgesSection />);
    await screen.findByText("Example Mountain Club Lodge");
    fireEvent.click(screen.getByRole("button", { name: /Deactivate/ }));

    await waitFor(() =>
      expect(writesTo(fetchMock, "/api/admin/lodges/lodge-1")).toHaveLength(2),
    );

    // The counts the operator was shown are the ones the route sent, and the
    // zero-valued dependencies are left out rather than listed as "0".
    const message = String(confirm.mock.calls[0]?.[0]);
    expect(message).toContain("3 future booking(s)");
    expect(message).toContain("1 hut-leader assignment(s)");
    expect(message).not.toContain("waitlist");

    const [first, second] = writesTo(fetchMock, "/api/admin/lodges/lodge-1");
    expect(
      JSON.parse(String((first[1] as RequestInit).body)),
    ).toEqual({ active: false });
    expect(
      JSON.parse(String((second[1] as RequestInit).body)),
    ).toEqual({ active: false, force: true });

    // Announced ONCE, by the retry that actually wrote — the refused
    // pre-flight changed nothing for the wizard to re-read.
    await waitFor(() => expect(emits.count).toBe(1));
    emits.stop();
  });

  it("writes nothing, and announces nothing, when the operator declines", async () => {
    const fetchMock = stubFetch([lodgeFixture()], (url) => {
      if (url === "/api/admin/lodges/lodge-1") {
        return { ok: false, status: 409, body: DEPENDENCY_REFUSAL };
      }
      return { ok: true, status: 200, body: { lodges: [] } };
    });
    const emits = countReadinessEmits();
    vi.stubGlobal("confirm", vi.fn(() => false));

    render(<LodgesSection />);
    await screen.findByText("Example Mountain Club Lodge");
    fireEvent.click(screen.getByRole("button", { name: /Deactivate/ }));

    await waitFor(() =>
      expect(writesTo(fetchMock, "/api/admin/lodges/lodge-1")).toHaveLength(1),
    );
    // Give a (wrongly-sent) forced retry a turn of the event loop to land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writesTo(fetchMock, "/api/admin/lodges/lodge-1")).toHaveLength(1);
    expect(emits.count).toBe(0);
    // And no error banner: a declined confirmation is not a failure.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    emits.stop();
  });
});

describe("adding a lodge", () => {
  it("says it will be created closed, then hands the operator to its guided setup", async () => {
    const fetchMock = stubFetch([lodgeFixture()], (url, init) => {
      if (url === "/api/admin/lodges" && init?.method === "POST") {
        return {
          ok: true,
          status: 201,
          body: { lodge: { ...lodgeFixture(), id: "lodge-new", active: false } },
        };
      }
      return { ok: true, status: 200, body: { lodges: [] } };
    });
    const emits = countReadinessEmits();

    render(<LodgesSection />);
    await screen.findByText("Example Mountain Club Lodge");
    fireEvent.click(screen.getByRole("button", { name: /Add lodge/ }));

    // #221's warning, before the button is pressed rather than after.
    expect(screen.getByTestId("lodge-create-inactive-hint")).toHaveTextContent(
      /not open for booking until you activate it/,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ruapehu Hut" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/admin/lodges/lodge-new/setup"),
    );
    expect(
      JSON.parse(
        String(
          (writesTo(fetchMock, "/api/admin/lodges")[0][1] as RequestInit).body,
        ),
      ),
    ).toMatchObject({ name: "Ruapehu Hut" });
    // A lodge that now exists is a fact the lodges check reads, whether or not
    // this component survives the route change.
    expect(emits.count).toBe(1);
    emits.stop();
  });
});

describe("the section carries the lodge-area banner itself", () => {
  it("heads a view-only admin's screen with it, above the vouched other-clubs panel", async () => {
    /*
      The banner is not decoration here. `<OtherLodgesPanel
      ancestorRendersViewOnlyBanner />` renders no banner of its own and its
      controls opt out of the per-button reason, on the strength of a promise
      made at this render site — so the section that mounts the panel is the
      section that must carry the banner. The AST half of this is
      `view-only-banner-contract.test.ts`; this is the rendered half.

      MUTATION PROBE: delete the banner from `lodges-section.tsx` and the
      contract test names the broken vouch, while this one loses its banner.
    */
    mocks.canEdit.mockReturnValue(false);
    stubFetch([lodgeFixture()], () => ({
      ok: true,
      status: 200,
      body: { lodges: [] },
    }));

    render(<LodgesSection />);
    await screen.findByText("Example Mountain Club Lodge");

    const banners = screen.getAllByTestId("admin-view-only-banner");
    expect(
      banners.some((banner) =>
        banner.textContent?.includes(
          "can view the lodge properties but cannot change them",
        ),
      ),
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /Deactivate/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
