// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * C12 mounts REAL settings panels beside the frame, and two of them resolve
 * their own permissions from the client session — `ClubIdentityPanel` through
 * `useAdminAreaEditAccess("content")`, and the club-timezone pane through
 * `isFullAdmin` directly. `useSession` throws outside a `<SessionProvider>`, so
 * without this every step-frame test in the file dies on an uncaught exception
 * rather than on an assertion. The admin tree really is inside one
 * (`app-providers.tsx`); this stands in for it.
 *
 * A FULL ADMIN by default, which is the permissive end deliberately: these
 * tests are about the shell, and a session that gated the panes would hide the
 * very composition they now exercise. The gated directions are pinned in
 * `setup-wizard-panes.test.tsx`, which drives this same handle.
 */
const sessionMock = vi.hoisted(() => ({
  data: { user: { accessRoles: ["ADMIN"] } } as unknown,
  status: "authenticated" as "authenticated" | "loading" | "unauthenticated",
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: sessionMock.data, status: sessionMock.status }),
}));

import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import { SETUP_READINESS_INPUT_CHANGED_EVENT } from "@/lib/setup-readiness-events";
import type { SetupReadiness } from "@/lib/setup-readiness";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardTraversal } from "@/lib/setup-wizard-traversal";
import { SetupWizardClient } from "@/app/(admin)/admin/setup/wizard/setup-wizard-client";

/**
 * The shell (epic #213, C5): resume, the launch-panel unlock, and the rail
 * following the module flags without a page reload.
 *
 * The payload is a literal rather than a run of the real builders: this file is
 * about what the SHELL does with a traversal, and `setup-wizard-view.test.ts`
 * already pins that the real builders agree.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionMock.data = { user: { accessRoles: ["ADMIN"] } };
  sessionMock.status = "authenticated";
});

const admin = { ...emptyAdminPermissionMatrix(), support: "edit" as const };
/** Support edit records progress; CONTENT edit publishes the site (D9). */
const publisher = { ...admin, content: "edit" as const };

// The four provider steps carry a test on their readiness check (C8, #223).
// Only "stripe" and "smtp" are given one here — enough to exercise a SECOND
// provider for the cross-step race test below, without every id needing one.
const PROVIDER_BY_ID: Partial<Record<string, "stripe" | "smtp" | "sentry" | "xero">> = {
  stripe: "stripe",
  smtp: "smtp",
};

function check(id: string, title: string) {
  const provider = PROVIDER_BY_ID[id];
  return {
    id: id as SetupStepId,
    title,
    description: `${title} description`,
    status: "not_started" as const,
    required: true,
    message: `${title} message`,
    details: [],
    href: "/admin/health",
    progress: "open" as const,
    // Attached here by id so the shell wiring is exercised through the same
    // route a real payload takes, rather than through a hand-built detail.
    ...(provider
      ? {
          action: {
            type: "provider-test" as const,
            provider,
            label: `Test ${title}`,
          },
        }
      : {}),
  };
}

function readinessWith(ids: [string, string][]): SetupReadiness {
  return {
    status: "not_started",
    summary: { total: ids.length, complete: 0, warning: 0, blocked: 0, skipped: 0 },
    categories: [
      {
        id: "foundation",
        title: "Foundation",
        description: "Club identity and first-install readiness.",
        status: "not_started",
        checks: ids.map(([id, title]) => check(id, title)),
      },
    ],
    generatedAt: "2026-07-01T00:00:00.000Z",
  } as SetupReadiness;
}

function traversalWith(
  ids: string[],
  options: { currentIndex?: number; allResolved?: boolean; frontierIndex?: number } = {},
): SetupWizardTraversal<SetupStepId> {
  const currentIndex = options.currentIndex ?? 0;
  const frontierIndex = options.frontierIndex ?? currentIndex;
  return {
    steps: ids.map((id, index) => ({
      id: id as SetupStepId,
      ownerModule: "core",
      order: (index + 1) * 10,
      state:
        index < currentIndex
          ? "complete"
          : index === currentIndex && !options.allResolved
            ? "current"
            : "not-started",
      isComplete: index < currentIndex,
      isStale: false,
      isDeferred: false,
      isDefaulted: false,
      isReachable: index < currentIndex || index <= frontierIndex,
    })),
    applicableStepIds: ids as SetupStepId[],
    // D17 (#246): these fixtures are all-operator journeys, so the environment
    // half is empty and nothing holds publish shut. The panel's own behaviour is
    // exercised in `setup-wizard-environment-panel.test.tsx`, and the shell's
    // gate on `launchBlockedBy` by the tests named for it below.
    environmentFacts: [],
    launchBlockedBy: [],
    staleStepIds: [],
    outstandingStepIds: options.allResolved ? [] : (ids.slice(currentIndex) as SetupStepId[]),
    blockingStepIds: options.allResolved ? [] : (ids.slice(currentIndex) as SetupStepId[]),
    currentStepId: options.allResolved ? null : (ids[currentIndex] as SetupStepId),
    navigationFrontierStepId: ids[frontierIndex] as SetupStepId,
    allResolved: options.allResolved ?? false,
    percentComplete: options.allResolved ? 100 : 33,
  };
}

/**
 * A fetch stub answering the wizard read — and, when a test asks for it, the
 * launch panel's publish.
 *
 * Successive `payloads` are handed out one per wizard read, so a test can make
 * the world change under a refetch; the last one repeats.
 */
function stubFetch(
  payloads: {
    readiness: SetupReadiness;
    traversal: unknown;
    isSiteVisible?: boolean;
  }[],
  options: {
    publish?: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
    providerTest?: (
      init?: RequestInit,
    ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  } = {},
) {
  let call = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    /*
      C12's inline panes fetch for themselves, and they must be answered ABOVE
      the payload branch below — that branch hands out one `payloads` entry per
      call, so an unrouted pane read would silently consume the entry a
      refetch test staged for the wizard and the test would fail describing the
      wrong thing entirely.
    */
    if (String(url) === "/api/admin/club-identity") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          settings: {
            name: "Alpine Sports Club",
            shortName: "",
            hutLeaderLabel: "",
            facebookUrl: "",
          },
        }),
      };
    }
    if (String(url) === "/api/admin/club-time-zone") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: {
            timeZone: "Pacific/Auckland",
            source: "persisted",
            updatedAt: null,
            updatedByName: null,
            unusableStoredValue: null,
          },
        }),
      };
    }
    if (String(url).startsWith("/api/admin/site-style")) {
      if (options.publish) return options.publish();
      return { ok: true, status: 200, json: async () => ({ isComplete: true }) };
    }
    if (String(url) === "/api/admin/setup/provider-test") {
      if (options.providerTest) return options.providerTest(init);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          provider: "stripe",
          checkedAt: "2026-07-01T00:00:00.000Z",
          message: "Stripe reachable.",
        }),
      };
    }
    const payload = payloads[Math.min(call, payloads.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ isSiteVisible: false, ...payload }),
    };
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe("SetupWizardClient", () => {
  it("resumes at the traversal's current step", async () => {
    stubFetch([
      {
        readiness: readinessWith([
          ["club-config", "Club Configuration"],
          ["runtime-env", "Runtime Environment"],
          ["seed-admin", "Administrator Account"],
        ]),
        traversal: traversalWith(
          ["club-config", "runtime-env", "seed-admin"],
          { currentIndex: 1 },
        ),
      },
    ]);
    render(<SetupWizardClient permissionMatrix={admin} />);
    const frame = await screen.findByTestId("setup-wizard-step-frame");
    expect(frame.getAttribute("data-step-id")).toBe("runtime-env");
    expect(screen.getByTestId("setup-wizard-percent").textContent).toBe("33%");
  });

  it("moves the frame when a reachable rail row is clicked", async () => {
    stubFetch([
      {
        readiness: readinessWith([
          ["club-config", "Club Configuration"],
          ["runtime-env", "Runtime Environment"],
        ]),
        traversal: traversalWith(["club-config", "runtime-env"], { currentIndex: 1 }),
      },
    ]);
    render(<SetupWizardClient permissionMatrix={admin} />);
    fireEvent.click(await screen.findByTestId("setup-wizard-rail-row-club-config"));
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
      ).toBe("club-config"),
    );
  });

  // D9's unlock is the traversal's `allResolved` and nothing the shell decides.
  // Mutation-verified: replacing `view.allResolved` with `true` in the shell
  // fails this test.
  it("unlocks the launch panel only once the traversal resolves everything", async () => {
    stubFetch([
      {
        readiness: readinessWith([["club-config", "Club Configuration"]]),
        traversal: traversalWith(["club-config"], { currentIndex: 0 }),
      },
    ]);
    render(<SetupWizardClient permissionMatrix={admin} />);
    const locked = await screen.findByTestId("setup-wizard-rail-row-launch");
    expect(locked.getAttribute("data-reachable")).toBe("false");
    fireEvent.click(locked);
    expect(screen.queryByTestId("setup-wizard-launch-panel")).toBeNull();

    cleanup();
    stubFetch([
      {
        readiness: readinessWith([["club-config", "Club Configuration"]]),
        traversal: traversalWith(["club-config"], { allResolved: true }),
      },
    ]);
    render(<SetupWizardClient permissionMatrix={admin} />);
    fireEvent.click(await screen.findByTestId("setup-wizard-rail-row-launch"));
    expect(await screen.findByTestId("setup-wizard-launch-panel")).toBeTruthy();
  });

  // D4/D5: a module switched off on the modules page removes its steps here on
  // the operator's return, with no page reload.
  it("re-reads the journey when the tab is focused again", async () => {
    const fetchMock = stubFetch([
      {
        readiness: readinessWith([
          ["club-config", "Club Configuration"],
          ["xero-operational", "Operational Xero"],
        ]),
        traversal: traversalWith(["club-config", "xero-operational"], {
          currentIndex: 0,
          frontierIndex: 1,
        }),
      },
      {
        readiness: readinessWith([["club-config", "Club Configuration"]]),
        traversal: traversalWith(["club-config"], { currentIndex: 0 }),
      },
    ]);
    render(<SetupWizardClient permissionMatrix={admin} />);
    expect(await screen.findByTestId("setup-wizard-rail-row-xero-operational")).toBeTruthy();

    fireEvent.focus(window);
    await waitFor(() =>
      expect(screen.queryByTestId("setup-wizard-rail-row-xero-operational")).toBeNull(),
    );
    // Counted by URL rather than as a bare call total, the same way the
    // provider-test case below does it: the current step is `club-config`, so
    // C12's inline pane makes a read of its own and a bare total would be
    // measuring the pane as well as the journey.
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => String(url) === "/api/admin/setup/wizard",
      ),
    ).toHaveLength(2);
  });

  /*
    F6 (#238 fix round). `load()` has THREE independent triggers — mount,
    focus/visibility, and C12's readiness-input-changed event — and nothing
    serialised them before this fix: two overlapping reads resolved in
    NETWORK order, so a slower OLDER call settling after a faster NEWER one
    could silently overwrite the newer result with stale state. Concretely: a
    pane save fires the readiness-input-changed refetch, and if a focus
    refetch from moments before is still in flight and happens to resolve
    later, the operator would watch the exact repaint their save just
    produced flicker back to what it replaced.
  */
  it("applies only the most recently STARTED load, dropping an older one that resolves later", async () => {
    type WizardResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
    const wizardResolvers: Array<(value: WizardResponse) => void> = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url) !== "/api/admin/setup/wizard") {
        throw new Error(`unexpected fetch in this test: ${String(url)}`);
      }
      return new Promise<WizardResponse>((resolve) => {
        wizardResolvers.push(resolve);
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // `runtime-env`/`seed-admin` carry no C12 pane, so the only fetches in
    // this test are the wizard reads under test — nothing else to route.
    render(<SetupWizardClient permissionMatrix={admin} />);

    // Mount's load() is call #1, left in flight. Trigger a second, overlapping
    // load before it resolves — the readiness-input-changed event, unconditional
    // and exactly what a pane save dispatches.
    await waitFor(() => expect(wizardResolvers).toHaveLength(1));
    window.dispatchEvent(new Event(SETUP_READINESS_INPUT_CHANGED_EVENT));
    await waitFor(() => expect(wizardResolvers).toHaveLength(2));

    // Call #2 — the LATEST — resolves FIRST, reporting the operator on
    // `seed-admin`.
    await act(async () => {
      wizardResolvers[1]({
        ok: true,
        status: 200,
        json: async () => ({
          isSiteVisible: false,
          readiness: readinessWith([["seed-admin", "Administrator Account"]]),
          traversal: traversalWith(["seed-admin"], { currentIndex: 0 }),
        }),
      });
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
      ).toBe("seed-admin"),
    );

    // Call #1 — the OLDER call, started first — now resolves LAST, reporting
    // the mount-time state. Before F6 this overwrote the screen purely
    // because it settled later on the network.
    await act(async () => {
      wizardResolvers[0]({
        ok: true,
        status: 200,
        json: async () => ({
          isSiteVisible: false,
          readiness: readinessWith([["runtime-env", "Runtime Environment"]]),
          traversal: traversalWith(["runtime-env"], { currentIndex: 0 }),
        }),
      });
      // Flush the awaited `response.json()` inside the stale call's `load()`
      // before asserting — this is exactly the window in which the pre-F6
      // code applied the stale result.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
    ).toBe("seed-admin");
  });

  // The permission AXIS, at the only place the matrix meets a step: the three
  // transitions are `PATCH /api/admin/setup/progress`, which the server enforces
  // at support:edit for every step. Both directions of the old per-step-area
  // gate were live on shipped role bundles, so both are pinned.
  //
  // Mutation-verified: gating on the step's own area again fails both of these.
  it("disables the progress buttons for an officer with the step's area but not support", async () => {
    // `booking-policies` maps to the BOOKINGS area, and this officer holds
    // bookings edit — the old gate enabled the buttons here, and the PATCH
    // behind them answers 403.
    stubFetch([
      {
        readiness: readinessWith([["booking-policies", "Booking Policy"]]),
        traversal: traversalWith(["booking-policies"], { currentIndex: 0 }),
      },
    ]);
    render(
      <SetupWizardClient
        permissionMatrix={{
          ...emptyAdminPermissionMatrix(),
          bookings: "edit",
          support: "view",
        }}
      />,
    );
    const button = (await screen.findByRole("button", {
      name: /Mark this step done/,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("admin-view-only-banner").textContent).toContain(
      "Support edit access is required",
    );
  });

  it("enables them for a support editor on a step whose settings are another area's", async () => {
    // The mirror-image failure: the old gate DISABLED this, withholding a
    // transition the server would have accepted.
    stubFetch([
      {
        readiness: readinessWith([["booking-policies", "Booking Policy"]]),
        traversal: traversalWith(["booking-policies"], { currentIndex: 0 }),
      },
    ]);
    render(
      <SetupWizardClient
        permissionMatrix={{ ...emptyAdminPermissionMatrix(), support: "edit" }}
      />,
    );
    const button = (await screen.findByRole("button", {
      name: /Mark this step done/,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    // The banner element is the section's always-mounted live region; with edit
    // access it says nothing at all.
    expect(screen.getByTestId("admin-view-only-banner").textContent).toBe("");
  });

  // F3c. The panel is rendered only while the traversal says `allResolved`, and
  // a refetch can stop saying that at any moment — a step going stale under an
  // upgrade. Unmounting mid-publish DISCARDS the result: the panel vanishes and
  // the operator never learns whether the site went live.
  it("keeps the launch panel mounted across a refetch while publishing", async () => {
    const publishGate: { settle: () => void } = { settle: () => {} };
    stubFetch(
      [
        {
          readiness: readinessWith([["club-config", "Club Configuration"]]),
          traversal: traversalWith(["club-config"], { allResolved: true }),
        },
        // The refetch that would otherwise pull the panel out from under them.
        {
          readiness: readinessWith([["club-config", "Club Configuration"]]),
          traversal: traversalWith(["club-config"], { currentIndex: 0 }),
        },
      ],
      {
        publish: () =>
          new Promise((resolve) => {
            publishGate.settle = () =>
              resolve({ ok: true, status: 200, json: async () => ({ isComplete: true }) });
          }),
      },
    );
    render(<SetupWizardClient permissionMatrix={publisher} />);
    fireEvent.click(await screen.findByTestId("setup-wizard-rail-row-launch"));
    expect(await screen.findByTestId("setup-wizard-launch-panel")).toBeTruthy();

    fireEvent.click(screen.getByTestId("setup-wizard-make-site-visible"));
    // Mid-flight, and the world moves: allResolved is now false.
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-rail-row-launch").getAttribute("data-reachable"),
      ).toBe("false"),
    );
    // …and the panel is still there to receive the answer.
    expect(screen.getByTestId("setup-wizard-launch-panel")).toBeTruthy();

    publishGate.settle();
    expect(await screen.findByText(/The public site is live/)).toBeTruthy();

    // The pin is the operator's to release: choosing another step drops it, and
    // the panel goes.
    fireEvent.click(screen.getByTestId("setup-wizard-rail-row-club-config"));
    await waitFor(() =>
      expect(screen.queryByTestId("setup-wizard-launch-panel")).toBeNull(),
    );
  });

  // F9's other half: the fallback is right, and it used to be SILENT. An
  // operator who chose a step and then found a different one on screen had
  // watched the pane change under them for no stated reason.
  it("says so when a refetch moves the operator off the step they chose", async () => {
    stubFetch([
      {
        readiness: readinessWith([
          ["club-config", "Club Configuration"],
          ["xero-operational", "Operational Xero"],
        ]),
        traversal: traversalWith(["club-config", "xero-operational"], {
          currentIndex: 0,
          frontierIndex: 1,
        }),
      },
      {
        readiness: readinessWith([["club-config", "Club Configuration"]]),
        traversal: traversalWith(["club-config"], { currentIndex: 0 }),
      },
    ]);
    render(<SetupWizardClient permissionMatrix={admin} />);
    fireEvent.click(await screen.findByTestId("setup-wizard-rail-row-xero-operational"));
    // Nothing to announce while the operator is where they asked to be.
    expect(screen.queryByTestId("setup-wizard-moved-notice")).toBeNull();

    fireEvent.focus(window);
    const notice = await screen.findByTestId("setup-wizard-moved-notice");
    expect(notice.textContent).toContain("moved to the next one");
    // C13 (#239) retired "changed elsewhere": the operator can now switch off
    // the module owning the step they are standing on, from the pane on that
    // very screen, and be moved by their own save. The notice states the
    // outcome and claims nothing about where the change happened.
    expect(notice.textContent).not.toContain("elsewhere");
    // F4 (#239 fix round): this move came from a plain focus refetch, not a
    // readiness-input-changed event — no local save happened on this screen
    // at all — so the notice must NOT claim one did. See
    // setup-wizard-panes.test.tsx's "switching off the module that owns the
    // step you are standing on" block for the positive case.
    expect(notice.textContent).not.toContain("Your module settings were saved.");

    // Dismissible, and it does not come back on the next refetch — the
    // selection was cleared when it fired, so there is nothing left to
    // re-invalidate.
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(screen.queryByTestId("setup-wizard-moved-notice")).toBeNull();
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
      ).toBe("club-config"),
    );
    expect(screen.queryByTestId("setup-wizard-moved-notice")).toBeNull();
  });

  it("falls back to the current step when the selected one disappears", async () => {
    stubFetch([
      {
        readiness: readinessWith([
          ["club-config", "Club Configuration"],
          ["xero-operational", "Operational Xero"],
        ]),
        traversal: traversalWith(["club-config", "xero-operational"], {
          currentIndex: 0,
          frontierIndex: 1,
        }),
      },
      {
        readiness: readinessWith([["club-config", "Club Configuration"]]),
        traversal: traversalWith(["club-config"], { currentIndex: 0 }),
      },
    ]);
    render(<SetupWizardClient permissionMatrix={admin} />);
    fireEvent.click(await screen.findByTestId("setup-wizard-rail-row-xero-operational"));
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
      ).toBe("xero-operational"),
    );

    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
      ).toBe("club-config"),
    );
  });

  /*
    The provider test's other half (C8, #223). The frame's own suite pins that
    the button appears and calls back; this pins the wiring the operator
    actually depends on — that it reaches the SAME endpoint the readiness cards
    call, with the provider the check named, and that the wizard re-reads
    afterwards. The test itself is read-only (only an AuditLog row), and the
    step's verdict is always derived fresh from the stored credential
    snapshot — the re-read is for parity with the cards, and because the
    credential state can have changed in another tab.
  */
  it("runs a step's provider test against the shared endpoint, then re-reads", async () => {
    const fetchMock = stubFetch([
      {
        readiness: readinessWith([["stripe", "Stripe"]]),
        traversal: traversalWith(["stripe"], { currentIndex: 0 }),
      },
    ]);
    render(<SetupWizardClient permissionMatrix={admin} />);
    fireEvent.click(await screen.findByTestId("setup-wizard-provider-test"));

    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-provider-test-result").textContent,
      ).toContain("Stripe reachable."),
    );

    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/admin/setup/provider-test",
    );
    expect(call).toBeTruthy();
    const init = call?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ provider: "stripe" });
    // Two wizard reads: the mount, and the parity refetch after the test
    // settles (the test itself writes nothing — see the run handler's comment).
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => String(url) === "/api/admin/setup/wizard",
      ),
    ).toHaveLength(2);
  });

  it("reports a failed provider test in the step, not as a page error", async () => {
    stubFetch(
      [
        {
          readiness: readinessWith([["stripe", "Stripe"]]),
          traversal: traversalWith(["stripe"], { currentIndex: 0 }),
        },
      ],
      {
        providerTest: async () => ({
          ok: false,
          status: 502,
          json: async () => ({ error: "Stripe key rejected." }),
        }),
      },
    );
    render(<SetupWizardClient permissionMatrix={admin} />);
    fireEvent.click(await screen.findByTestId("setup-wizard-provider-test"));

    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-provider-test-result").textContent,
      ).toContain("Stripe key rejected."),
    );
    // The question was "does this provider work"; "the request did not get
    // through" answers it, so it belongs in the panel rather than in the
    // page-level banner that reports a failure to LOAD the wizard.
    expect(screen.getByTestId("setup-wizard-step-frame")).toBeTruthy();
  });

  /*
    F5 (#223 delta review): `providerRunning` holds ONE provider name, not one
    flag per provider. A test left running on a step the operator has since
    navigated away from must not clear a NEWER test's running flag when it
    finally settles — an unconditional `setProviderRunning(null)` in the
    `finally` clause does exactly that, wrongly re-enabling a button whose own
    fetch is still in flight.
  */
  it("a slower test settling on an abandoned step does not clear a newer test's running flag", async () => {
    type ProviderTestResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
    let resolveStripe!: (value: ProviderTestResponse) => void;
    const stripeTest = new Promise<ProviderTestResponse>((resolve) => {
      resolveStripe = resolve;
    });
    let resolveSmtp!: (value: ProviderTestResponse) => void;
    const smtpTest = new Promise<ProviderTestResponse>((resolve) => {
      resolveSmtp = resolve;
    });

    stubFetch(
      [
        {
          readiness: readinessWith([
            ["stripe", "Stripe"],
            ["smtp", "Email"],
          ]),
          traversal: traversalWith(["stripe", "smtp"], {
            currentIndex: 0,
            frontierIndex: 1,
          }),
        },
      ],
      {
        providerTest: (init) => {
          const { provider } = JSON.parse(String(init?.body)) as { provider: string };
          return provider === "stripe" ? stripeTest : smtpTest;
        },
      },
    );

    render(<SetupWizardClient permissionMatrix={admin} />);

    // Start Stripe's test and leave it in flight — nothing here resolves it.
    fireEvent.click(await screen.findByTestId("setup-wizard-provider-test"));

    // Navigate away to the Email step. `providerRunning` is still "stripe",
    // so Email's own button is NOT disabled by Stripe's in-flight test, and
    // starting Email's test overwrites providerRunning to "smtp".
    fireEvent.click(screen.getByTestId("setup-wizard-rail-row-smtp"));
    fireEvent.click(await screen.findByTestId("setup-wizard-provider-test"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-provider-test")).toBeDisabled(),
    );

    // Stripe's slower test settles now. Before the F5 fix this unconditionally
    // cleared providerRunning to null, which would re-enable Email's button
    // here — even though Email's own fetch has NOT resolved yet.
    await act(async () => {
      resolveStripe({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          provider: "stripe",
          checkedAt: "2026-07-01T00:00:00.000Z",
          message: "Stripe reachable.",
        }),
      });
      await stripeTest;
      // Flush the awaited `response.json()` and `load()` inside
      // `runProviderTest`'s try block before its `finally` clause runs.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Email's button is STILL disabled: its own fetch has not resolved yet,
    // and Stripe settling must not have cleared providerRunning out from
    // under it.
    expect(screen.getByTestId("setup-wizard-provider-test")).toBeDisabled();

    // Email's OWN test settling is what re-enables its button — not Stripe's.
    await act(async () => {
      resolveSmtp({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          provider: "smtp",
          checkedAt: "2026-07-01T00:00:00.000Z",
          message: "Email reachable.",
        }),
      });
      await smtpTest;
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-provider-test-result").textContent,
      ).toContain("Email reachable."),
    );
    expect(screen.getByTestId("setup-wizard-provider-test")).not.toBeDisabled();
  });
});
