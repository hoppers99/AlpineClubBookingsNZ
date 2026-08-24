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

/** A fetch stub that answers the wizard read, and the launch panel's theme read. */
function stubFetch(payloads: { readiness: SetupReadiness; traversal: unknown }[]) {
  let call = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).startsWith("/api/admin/site-style")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          theme: {
            brandGold: "#c8a04a",
            brandDeep: "#12263a",
            brandSafety: "#d94f2b",
            headingFontKey: "inter",
            bodyFontKey: "inter",
            logoUrl: null,
            logoDataUrl: null,
            rawCss: "",
            completedAt: null,
          },
        }),
      };
    }
    const payload = payloads[Math.min(call, payloads.length - 1)];
    call += 1;
    return { ok: true, status: 200, json: async () => payload };
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
});
