// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

// The two cross-area cards are mocked to cheap markers: this test exercises the
// client's matrix-driven conditional (#1548), not the cards' own fetches.
vi.mock("@/components/admin/lodge-capacity-card", () => ({
  LodgeCapacityCard: () => <div data-testid="lodge-card" />,
}));
vi.mock("@/components/admin/finance-report-mappings-panel", () => ({
  FinanceReportMappingsPanel: () => <div data-testid="finance-panel" />,
}));

import { SetupPageClient } from "@/app/(admin)/admin/setup/setup-page-client";

const foundationCategory = {
  id: "foundation",
  title: "Foundation",
  description: "Club identity and first-install readiness.",
  status: "blocked",
  checks: [
    {
      id: "runtime-env",
      title: "Runtime Environment",
      description: "Database, auth, app origin, cron, and seed admin.",
      status: "blocked",
      required: true,
      message: "Required runtime variables are missing or invalid.",
      details: ["Fix DATABASE_URL"],
      href: "/admin/setup/foundations",
      progress: "open",
    },
  ],
};

/*
  What a club with xeroIntegration ON gets back. It is in the DEFAULT payload
  deliberately (epic #213, C8 #223): the Finance hub card is now gated on the
  registry's applicable set as well as on modules and permissions, so a payload
  with no finance step would hide that card for a reason this file is not
  testing — and the permission assertions below would then pass while
  exercising nothing.
*/
const financeCategory = {
  id: "finance",
  title: "Finance",
  description: "Finance dashboard module and Xero chart/item mappings.",
  status: "warning",
  checks: [
    {
      id: "xero-mappings",
      title: "Xero Mappings",
      description: "Chart of accounts, hut fee item codes, joining fees.",
      status: "warning",
      required: false,
      message: "Map Xero accounts and item codes before using live Xero sync.",
      details: [],
      href: "/admin/xero#xero-section-mappings",
      progress: "open",
    },
  ],
};

function setupBodyWith(categories: unknown[]) {
  return {
    readiness: {
      status: "blocked",
      summary: { total: 1, complete: 0, warning: 0, blocked: 1, skipped: 0 },
      categories,
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
    progress: {
      completedStepIds: [],
      skippedStepIds: [],
      completedAt: null,
      completedByMemberId: null,
    },
  };
}

function stubSetupFetch(
  body: unknown = setupBodyWith([foundationCategory, financeCategory]),
) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

function renderSetup(overrides: Partial<AdminPermissionMatrix>) {
  return render(
    <SetupPageClient
      permissionMatrix={matrix(overrides)}
      features={allOn}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SetupPageClient — permission-aware cross-area cards (#1548)", () => {
  beforeEach(() => {
    stubSetupFetch();
  });

  it("hides the lodge card when the viewer lacks lodge access", async () => {
    renderSetup({ support: "view" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Setup checklist" })).toBeTruthy();
    });
    expect(screen.queryByTestId("lodge-card")).toBeNull();
  });

  it("renders the lodge card when the viewer has lodge view", async () => {
    renderSetup({ support: "view", lodge: "view" });

    await waitFor(() => {
      expect(screen.getByTestId("lodge-card")).toBeTruthy();
    });
  });

  it("hides the finance drill-down when the viewer lacks finance access", async () => {
    const { container } = renderSetup({ support: "view" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Setup checklist" })).toBeTruthy();
    });
    expect(screen.queryByTestId("finance-panel")).toBeNull();
    expect(container.querySelector('a[href="/admin/setup/finance"]')).toBeNull();
  });

  it("links to finance setup without rendering mappings on the main page", async () => {
    const { container } = renderSetup({ support: "view", finance: "view" });

    await waitFor(() => {
      expect(screen.getByText("Setup hubs")).toBeTruthy();
    });
    expect(container.querySelector('a[href="/admin/setup/finance"]')).toBeTruthy();
    expect(screen.queryByTestId("finance-panel")).toBeNull();
  });

  // Epic #213, C5: the wizard's entry point. Per D6 it ships ALONGSIDE the
  // cards — C8 (#223) owns replacing them — so this asserts both halves: the
  // launcher is there, and the readiness checks it sits beside are still there.
  //
  // The old version of this waited on `getByText("Setup Wizard")` — which was
  // this page's OWN h1 at the time, so it asserted nothing about the launcher
  // and would have passed with no wizard in the product at all. Two surfaces
  // both called "Setup Wizard" is also what made the assertion look sound; the
  // checklist is now named for what it is (#220 review F4).
  it("offers the setup wizard without displacing the readiness cards", async () => {
    renderSetup({ support: "view" });
    const launcher = await screen.findByRole("link", {
      name: /Open the setup wizard/,
    });
    expect(launcher.getAttribute("href")).toBe("/admin/setup/wizard");
    // …alongside the checklist, per D6: the cards stay until C8 (#223).
    expect(screen.getByRole("heading", { name: "Setup checklist" })).toBeTruthy();
    expect(screen.getByText("Readiness checks")).toBeTruthy();
  });

  /*
    Epic #213, C8 (#223), D4 reaching the hub cards. The server's readiness
    payload IS the registry's applicable set, so a club with xeroIntegration
    and financeDashboard off gets no finance step back — and must not then be
    offered a Finance drill-down whose page can only tell it that nothing in
    there is available. The viewer here has FULL finance permission and every
    module flag on, so permissions and modules are both ruled out as the
    reason: the only thing that changed is the applicable set.
  */
  it("hides a hub card whose every covered step belongs to a disabled module", async () => {
    vi.unstubAllGlobals();
    stubSetupFetch(setupBodyWith([foundationCategory]));
    const { container } = renderSetup({ support: "view", finance: "edit" });

    await waitFor(() => {
      expect(screen.getByText("Setup hubs")).toBeTruthy();
    });
    expect(container.querySelector('a[href="/admin/setup/finance"]')).toBeNull();
    // …and the hubs that still have applicable steps, or cover none at all,
    // are untouched. This is the half that proves the gate is selective rather
    // than simply blanking the section.
    expect(
      container.querySelector('a[href="/admin/setup/foundations"]'),
    ).toBeTruthy();
  });

  it("places KPIs, blockers, hubs, and checks in the expected order", async () => {
    const { container } = renderSetup({
      support: "view",
      finance: "view",
      bookings: "view",
      lodge: "view",
      membership: "view",
    });

    await waitFor(() => {
      expect(screen.getByText("Setup hubs")).toBeTruthy();
    });

    const html = container.innerHTML;
    expect(html.indexOf("Overall")).toBeLessThan(
      html.indexOf("Resolve or explicitly skip"),
    );
    expect(html.indexOf("Resolve or explicitly skip")).toBeLessThan(
      html.indexOf("Setup hubs"),
    );
    expect(html.indexOf("Setup hubs")).toBeLessThan(
      html.indexOf("Readiness checks"),
    );
  });
});
