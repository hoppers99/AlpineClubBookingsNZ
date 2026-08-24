// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardView } from "@/lib/setup-wizard-view";
import { SetupWizardLaunchPanel } from "@/app/(admin)/admin/setup/wizard/setup-wizard-launch-panel";

/**
 * The launch panel (epic #213, **D9**): two independent levers, and outstanding
 * work stated rather than hidden.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const theme = {
  brandGold: "#c8a04a",
  brandDeep: "#12263a",
  brandSafety: "#d94f2b",
  headingFontKey: "inter",
  bodyFontKey: "inter",
  logoUrl: null,
  logoDataUrl: null,
  rawCss: "",
  completedAt: null as string | null,
};

function stubThemeFetch(overrides: { completedAt?: string | null; status?: number } = {}) {
  const put = vi.fn();
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      put(JSON.parse(String(init.body)));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          theme: { ...theme, completedAt: "2026-07-01T00:00:00.000Z" },
        }),
      };
    }
    const status = overrides.status ?? 200;
    return {
      ok: status === 200,
      status,
      json: async () => ({
        theme: { ...theme, completedAt: overrides.completedAt ?? null },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return { put };
}

function viewWith(
  outstanding: SetupWizardView["outstanding"] = [],
): SetupWizardView {
  return {
    groups: [],
    steps: [],
    percentComplete: 100,
    currentStepId: null,
    navigationFrontierStepId: null,
    allResolved: true,
    outstanding,
  };
}

const contentEditor = { ...emptyAdminPermissionMatrix(), content: "edit" as const };

describe("SetupWizardLaunchPanel", () => {
  it("states what the club skipped rather than hiding it (mockup 6)", async () => {
    stubThemeFetch();
    render(
      <SetupWizardLaunchPanel
        view={viewWith([
          { id: "sentry" as SetupStepId, title: "Error Monitoring", deferred: true },
        ])}
        permissionMatrix={contentEditor}
      />,
    );
    const outstanding = await screen.findByTestId("setup-wizard-outstanding");
    expect(outstanding.textContent).toContain("Error Monitoring");
    expect(outstanding.textContent).toContain("skipped for now");
  });

  it("submits the visibility lever through the existing site-style path", async () => {
    const { put } = stubThemeFetch();
    render(
      <SetupWizardLaunchPanel view={viewWith()} permissionMatrix={contentEditor} />,
    );
    const button = await screen.findByTestId("setup-wizard-make-site-visible");
    fireEvent.click(button);
    await waitFor(() => expect(put).toHaveBeenCalled());
    // The whole theme, round-tripped unchanged, plus the one flag. A partial
    // body would be rejected by the `.strict()` schema, and a body missing the
    // colours would reset them.
    expect(put.mock.calls[0][0]).toEqual({
      brandGold: theme.brandGold,
      brandDeep: theme.brandDeep,
      brandSafety: theme.brandSafety,
      headingFontKey: theme.headingFontKey,
      bodyFontKey: theme.bodyFontKey,
      logoUrl: null,
      logoDataUrl: null,
      rawCss: "",
      completeSetup: true,
    });
    expect(await screen.findByText(/The public site is live/)).toBeTruthy();
  });

  // D12. Mutation-verified: dropping `canEdit` from the lever's
  // ViewOnlyActionButton fails this test.
  it("gives an officer without content edit no way to publish the site", async () => {
    const { put } = stubThemeFetch();
    render(
      <SetupWizardLaunchPanel
        view={viewWith()}
        permissionMatrix={{ ...emptyAdminPermissionMatrix(), content: "view" }}
      />,
    );
    const button = (await screen.findByTestId(
      "setup-wizard-make-site-visible",
    )) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByTestId("admin-view-only-banner").textContent).toContain(
      ADMIN_VIEW_ONLY_SECTION_HEADING,
    );
  });

  it("reports an already-visible site as a state, not as a nag", async () => {
    stubThemeFetch({ completedAt: "2026-06-01T00:00:00.000Z" });
    render(
      <SetupWizardLaunchPanel view={viewWith()} permissionMatrix={contentEditor} />,
    );
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.queryByTestId("setup-wizard-make-site-visible")).toBeNull();
  });

  it("keeps the environment-role lever consume-only and independent", async () => {
    stubThemeFetch();
    render(
      <SetupWizardLaunchPanel view={viewWith()} permissionMatrix={contentEditor} />,
    );
    const role = await screen.findByTestId("setup-wizard-environment-role");
    // It instructs (D9: production is declared in `.env` by upstream design)
    // and offers no control at all.
    expect(role.textContent).toContain(".env");
    expect(role.querySelectorAll("button").length).toBe(0);
    // …and it does not gate the other lever.
    expect(screen.getByTestId("setup-wizard-make-site-visible")).toBeTruthy();
  });
});
