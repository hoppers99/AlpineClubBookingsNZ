// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
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
});

const admin = { ...emptyAdminPermissionMatrix(), support: "edit" as const };
/** Support edit records progress; CONTENT edit publishes the site (D9). */
const publisher = { ...admin, content: "edit" as const };

function check(id: string, title: string) {
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
    // The four provider steps carry a test on their readiness check (C8, #223).
    // Attached here by id so the shell wiring is exercised through the same
    // route a real payload takes, rather than through a hand-built detail.
    ...(id === "stripe"
      ? {
          action: {
            type: "provider-test" as const,
            provider: "stripe" as const,
            label: "Test Stripe",
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
      isReachable: index < currentIndex || index <= frontierIndex,
    })),
    applicableStepIds: ids as SetupStepId[],
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
    providerTest?: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  } = {},
) {
  let call = 0;
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url).startsWith("/api/admin/site-style")) {
      if (options.publish) return options.publish();
      return { ok: true, status: 200, json: async () => ({ isComplete: true }) };
    }
    if (String(url) === "/api/admin/setup/provider-test") {
      if (options.providerTest) return options.providerTest();
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(notice.textContent).toContain("returned to the next step");

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

  // F2 at the shell: Back must target a step the operator may actually open.
  // With a locked step immediately behind the selected one, the old
  // `steps[index - 1]` handed Back an unreachable target, and the fallback then
  // teleported them to the resume point instead.
  it("skips a locked step when walking Back, rather than teleporting", async () => {
    stubFetch([
      {
        readiness: readinessWith([
          ["club-config", "Club Configuration"],
          ["runtime-env", "Runtime Environment"],
          ["seed-admin", "Administrator Account"],
        ]),
        traversal: {
          ...traversalWith(["club-config", "runtime-env", "seed-admin"], {
            currentIndex: 1,
          }),
          // club-config complete and reachable; runtime-env stale, capping the
          // frontier under it; seed-admin complete, so reachable on its own
          // account despite sitting past that frontier (#219 F2).
          steps: [
            {
              id: "club-config" as SetupStepId,
              ownerModule: "core" as const,
              order: 10,
              state: "complete" as const,
              isComplete: true,
              isStale: false,
              isDeferred: false,
              isReachable: true,
            },
            {
              id: "runtime-env" as SetupStepId,
              ownerModule: "core" as const,
              order: 20,
              state: "not-started" as const,
              isComplete: false,
              isStale: false,
              isDeferred: false,
              isReachable: false,
            },
            {
              id: "seed-admin" as SetupStepId,
              ownerModule: "core" as const,
              order: 30,
              state: "complete" as const,
              isComplete: true,
              isStale: false,
              isDeferred: false,
              isReachable: true,
            },
          ],
          currentStepId: "runtime-env" as SetupStepId,
        },
      },
    ]);
    render(<SetupWizardClient permissionMatrix={admin} />);
    fireEvent.click(await screen.findByTestId("setup-wizard-rail-row-seed-admin"));
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
      ).toBe("seed-admin"),
    );

    fireEvent.click(screen.getByTestId("setup-wizard-back"));
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
        // Not runtime-env (locked), and not the teleport to the resume point.
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
    afterwards, because a test WRITES BACK and moves the step's verdict, the
    rail and D7's percentage with it.
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
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ provider: "stripe" });
    // Two wizard reads: the mount, and the one the test's write-back forces.
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
});
