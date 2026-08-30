// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

/*
  The page now calls `useAdminAreaEditAccess("support")` for the setup-surfaces
  section (epic #213, C8 #223), which reads the session. Mocked here rather than
  wrapped in a real `SessionProvider` because this file is about the page's
  matrix-driven conditionals, not about auth: the matrix arrives as a prop, and
  the session only has to resolve. `support: "edit"` keeps the section in its
  ordinary editable state so a view-only banner never changes what the
  assertions below can see.
*/
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "u1", adminPermissionMatrix: { support: "edit" } } },
    status: "authenticated",
  }),
}));

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

/*
  Carries `membership-cancellation` so the Cancellation hub card is not hidden
  by the APPLICABILITY gate in a test whose subject is the RETIREMENT gate. The
  two gates are independent and a test that let one stand in for the other would
  pass for the wrong reason.
*/
const bookingCategory = {
  id: "booking",
  title: "Booking Rules",
  description: "Booking policy and membership cancellation.",
  status: "warning",
  checks: [
    {
      id: "membership-cancellation",
      title: "Membership Cancellation",
      description: "Cancellation policy and its message copy.",
      status: "warning",
      required: false,
      message: "Review the cancellation settings.",
      details: [],
      href: "/admin/setup/cancellation",
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
    // The wizard's own percentage, which the Progress tile renders rather than
    // deriving one (#237 fix round). Nothing in this file asserts on it; it is
    // here so the stub stays a faithful payload. The tile's behaviour is pinned
    // in `setup-page-progress-tile.test.tsx`.
    wizardPercentComplete: 0,
  };
}

/*
  URL-AWARE, and it has to be. The page makes TWO reads now (epic #213, C8
  #223): the readiness payload, and the setup-surfaces setting the new section
  loads. A stub that answered both with the readiness body handed the section an
  `undefined` settings object, which threw inside its loader and took the whole
  page down — so every assertion below failed for a reason that had nothing to
  do with what it was testing.
*/
function stubSetupFetch(
  body: unknown = setupBodyWith([foundationCategory, financeCategory]),
  surfaces: { legacySurfacesHidden: boolean } = { legacySurfacesHidden: false },
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/api/admin/setup/surfaces")
          ? { settings: surfaces }
          : body,
    };
  }) as unknown as typeof fetch;
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

function renderSetup(
  overrides: Partial<AdminPermissionMatrix>,
  legacySurfacesHidden = false,
) {
  return render(
    <SetupPageClient
      permissionMatrix={matrix(overrides)}
      features={allOn}
      legacySurfacesHidden={legacySurfacesHidden}
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

  /*
    Epic #213 D8, C8 (#223) acceptance criterion 3: WHERE the legacy-surfaces
    setting is hidden, the cards and hub pages are absent — and every capability
    they exposed stays reachable. The four hub ROUTES are covered by their own
    server-side redirect (`setup-hub-page-redirect.test.ts`); this is the page
    half.
  */
  describe("with the legacy setup surfaces hidden", () => {
    beforeEach(() => {
      vi.unstubAllGlobals();
      stubSetupFetch(setupBodyWith([foundationCategory, financeCategory]), {
        legacySurfacesHidden: true,
      });
    });

    it("renders no readiness cards and none of the four retired hubs", async () => {
      const { container } = renderSetup(
        {
          support: "edit",
          finance: "edit",
          bookings: "edit",
          lodge: "edit",
          membership: "edit",
        },
        true,
      );

      await waitFor(() => {
        expect(screen.getByText(/readiness checklist/i)).toBeTruthy();
      });
      // The readiness cards' own section heading and one of its cards.
      expect(screen.queryByText("Readiness checks")).toBeNull();
      expect(screen.queryByText("Runtime Environment")).toBeNull();
      for (const href of [
        "/admin/setup/foundations",
        "/admin/setup/finance",
        "/admin/setup/booking-rules",
        "/admin/setup/integrations",
      ]) {
        expect(container.querySelector(`a[href="${href}"]`)).toBeNull();
      }
    });

    it("keeps the wizard, and the three hubs the wizard does not replace", async () => {
      // COVERAGE PARITY, at the render layer. The wizard is the destination, so
      // its launcher must survive; and the destinations the wizard offers no
      // route to must keep their entry point rather than disappear with the
      // four it does replace.
      vi.unstubAllGlobals();
      stubSetupFetch(
        setupBodyWith([foundationCategory, bookingCategory, financeCategory]),
        { legacySurfacesHidden: true },
      );
      const { container } = renderSetup(
        { support: "edit", membership: "edit" },
        true,
      );

      const launcher = await screen.findByRole("link", {
        name: /Open the setup wizard/,
      });
      expect(launcher.getAttribute("href")).toBe("/admin/setup/wizard");
      expect(
        container.querySelector('a[href="/admin/membership-setup"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('a[href="/admin/notifications"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('a[href="/admin/setup/cancellation"]'),
      ).toBeTruthy();
    });

    /*
      THE PAGE MUST NOT KEEP THE CHECKLIST'S CHROME WITHOUT THE CHECKLIST
      (#223 fix round). The first build of the hidden position kept the "Setup
      checklist" heading, the four KPI tiles and the readiness sub-heading over
      a page that no longer held a checklist — a standing report on a list that
      was not there, and a second progress display competing with the wizard's
      own rail.
    */
    it("describes what the page now is, and drops the checklist's KPI tiles", async () => {
      renderSetup({ support: "edit" }, true);

      await waitFor(() => {
        expect(
          screen.getByTestId("setup-surfaces-hidden-notice"),
        ).toBeTruthy();
      });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        "Setup",
      );
      expect(screen.queryByTestId("setup-kpis")).toBeNull();
      // The four tiles' own labels, so a tile moved rather than removed still
      // fails this.
      for (const label of ["Overall", "Progress", "Blocked", "Skipped"]) {
        expect(screen.queryByText(label)).toBeNull();
      }
      expect(
        screen.queryByText(/Finish first-install readiness/),
      ).toBeNull();
    });

    /*
      …and the other direction, which is the one D8's parity rule is about.
      Mark Setup Complete finishes the SETUP JOURNEY (`SetupProgress.
      completedAt`, `PATCH /api/admin/setup/progress`). The wizard's launch
      panel publishes the PUBLIC SITE (the theme's `completedAt`,
      `POST /api/admin/site-style/complete-setup`) — a different column through
      a different API — so it is not an equivalent, and hiding this button would
      remove a capability rather than relocate one.
    */
    it("keeps Mark Setup Complete, which the wizard has no equivalent for", async () => {
      renderSetup({ support: "edit" }, true);

      const button = await screen.findByRole("button", {
        name: /Mark Setup Complete/,
      });
      expect(button).toBeTruthy();
    });

    it("keeps the blocker notice — it is that button's disabled reason", async () => {
      // Hiding the explanation while keeping the control it explains would
      // leave a dead button saying nothing. The wording moves instead: with the
      // checklist gone, the steps are resolved or skipped in the wizard.
      renderSetup({ support: "edit" }, true);

      await waitFor(() => {
        expect(
          screen.getByText(/Resolve them in the setup wizard/),
        ).toBeTruthy();
      });
      expect(screen.queryByText(/Resolve or explicitly skip/)).toBeNull();
    });

    it("still offers the switch that put them away", async () => {
      // The placement argument, asserted rather than assumed: hiding the
      // surfaces must not hide the control that un-hides them. `getAllByText`
      // because the hidden-state notice names the section too, which is the
      // point of the notice.
      renderSetup({ support: "edit" }, true);

      await waitFor(() => {
        expect(screen.getAllByText("Setup surfaces").length).toBeGreaterThan(0);
      });
      expect(
        await screen.findByLabelText(
          "Hide the readiness checklist and the setup hubs",
        ),
      ).toBeTruthy();
    });
  });

  it("shows the setup-surfaces switch when the surfaces are shown too", async () => {
    renderSetup({ support: "edit" });

    await waitFor(() => {
      expect(screen.getAllByText("Setup surfaces").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Readiness checks")).toBeTruthy();
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
