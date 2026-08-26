import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(),
}));
vi.mock("@/app/(admin)/admin/setup/permission-matrix", () => ({
  loadAdminSetupPermissionMatrix: vi.fn(),
}));
/*
  #223. The four `/admin/setup/*` hubs now consult the legacy-surfaces switch
  before they render anything, so this suite has to say which position it is
  testing. Left unstubbed, the real loader reached for a database that is not
  there, caught its own error and failed open — so every assertion below was
  passing through an ERROR PATH and would have gone on passing if the shown
  branch broke. Stubbed to the shown position, which is what these tests are
  about; the hidden position's redirect is pinned in
  `setup-hub-page-redirect.test.ts` and, for the one hub that differs, below.

  PARTIAL MOCK: `areLegacySetupSurfacesHidden` is the pure predicate the pages
  call on whatever the loader returned, and stubbing it too would test nothing
  but the mock.
*/
vi.mock("@/lib/setup-surface-settings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/setup-surface-settings")>();
  return { ...actual, loadSetupSurfaceSettings: vi.fn() };
});
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/components/admin/finance-report-mappings-panel", () => ({
  FinanceReportMappingsPanel: () => <div>Finance mappings editor</div>,
}));
// #2307 (MG2-M-1): the Bookings Setup hub now carries the Member guests policy
// card, a client component whose view-only gate reads `useSession`. Stubbed for
// the same reason the finance panel above is — this suite renders SERVER pages
// to static markup with no SessionProvider, and what it is testing is which
// cards a hub page renders, not how any of them behaves. The card's own three
// states are covered by `member-guest-settings-card.test.tsx`.
vi.mock("@/components/admin/member-guest-settings-card", () => ({
  MemberGuestSettingsCard: ({ moduleEnabled }: { moduleEnabled: boolean }) => (
    <div>Member guests settings card (module {moduleEnabled ? "on" : "off"})</div>
  ),
}));
// #2573: the Integrations hub now carries the Google Analytics card, stubbed for
// exactly the same reason as the two above — it is a client component whose
// view-only gate reads `useSession`, and this suite renders SERVER pages to static
// markup with no SessionProvider. What is under test here is WHICH cards a hub
// renders and whether the hub survives a module being off; the card's own status
// states, validation, warnings and re-consent flow are covered by
// `analytics-integration-card.test.tsx`.
vi.mock("@/components/admin/analytics-integration-card", () => ({
  AnalyticsIntegrationCard: () => <div>Google Analytics integration card</div>,
}));

import AppearanceHubPage from "@/app/(admin)/admin/appearance/page";
import DisplayHubPage from "@/app/(admin)/admin/display/page";
import BookingsSetupHubPage from "@/app/(admin)/admin/bookings-setup/page";
import BookingRulesSetupHubPage from "@/app/(admin)/admin/setup/booking-rules/page";
import CancellationSetupHubPage from "@/app/(admin)/admin/setup/cancellation/page";
import FinanceSetupPage from "@/app/(admin)/admin/setup/finance/page";
import FoundationsSetupHubPage from "@/app/(admin)/admin/setup/foundations/page";
import OperationalIntegrationsSetupHubPage from "@/app/(admin)/admin/setup/integrations/page";
import IntegrationsHubPage from "@/app/(admin)/admin/integrations/page";
import MembershipSetupHubPage from "@/app/(admin)/admin/membership-setup/page";
import { loadAdminSetupPermissionMatrix } from "@/app/(admin)/admin/setup/permission-matrix";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadSetupSurfaceSettings } from "@/lib/setup-surface-settings";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;
const allAreasView: AdminPermissionMatrix = {
  ...emptyAdminPermissionMatrix(),
  overview: "view",
  bookings: "view",
  membership: "view",
  finance: "view",
  lodge: "view",
  content: "view",
  support: "view",
};

async function renderPage(Page: () => Promise<React.ReactNode>) {
  return renderToStaticMarkup(await Page());
}

describe("admin setup hub pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue(allOn);
    vi.mocked(loadAdminSetupPermissionMatrix).mockResolvedValue(allAreasView);
    vi.mocked(loadSetupSurfaceSettings).mockResolvedValue({
      legacySurfacesHidden: false,
    });
  });

  it("renders the Membership & Members hub cards", async () => {
    const html = await renderPage(MembershipSetupHubPage);

    expect(html).toContain("Membership &amp; Members");
    expect(html).toContain("Membership Types");
    expect(html).toContain("Member Fields");
    expect(html).toContain("Subscription Lockout");
  });

  it("renders the Lobby Display hub cards (fork issue #109)", async () => {
    const html = await renderPage(DisplayHubPage);

    expect(html).toContain("Lobby Display");
    // The four surfaces the old four-item sidebar group linked, now cards.
    expect(html).toContain("Devices");
    expect(html).toContain("/admin/display/devices");
    expect(html).toContain("Layouts");
    expect(html).toContain("/admin/display/layouts");
    expect(html).toContain("Templates");
    expect(html).toContain("/admin/display/templates");
    expect(html).toContain("Reference");
    expect(html).toContain("/admin/display/reference");
    // #2249: the guided setup wizard is reachable from the hub at all times.
    // These renders have no database, so the readiness counts fall back to
    // "already set up" and it appears as an ordinary card rather than the gold
    // lead card — which is exactly the always-available half of the entry-point
    // decision (the lead-vs-ordinary switch itself is pinned in
    // `src/app/(admin)/admin/display/__tests__/display-setup-entry.test.tsx`).
    expect(html).toContain("/admin/display/setup");
  });

  it("hides Lobby Display hub cards when the module is disabled", async () => {
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({
      ...allOn,
      lobbyDisplay: false,
    });

    const html = await renderPage(DisplayHubPage);

    expect(html).not.toContain("/admin/display/devices");
    expect(html).not.toContain("/admin/display/layouts");
  });

  it("renders the Bookings Setup hub without the removed sidebar duplicate", async () => {
    const html = await renderPage(BookingsSetupHubPage);

    expect(html).toContain("Bookings Setup");
    expect(html).toContain("Rooms &amp; Beds");
    expect(html).toContain("Booking Messages");
    // MG2-M-1 as ticked: the member-guest policy lives HERE rather than on a
    // new admin route, and it is threaded the module flag so it can render its
    // own not-in-use banner (MG2-M-4).
    expect(html).toContain("Member guests settings card (module on)");
  });

  it("shows feature-gated cards when their modules are enabled", async () => {
    const html = await renderPage(AppearanceHubPage);

    expect(html).toContain("Mountain Conditions");
    expect(html).toContain("/admin/mountain-conditions");
  });

  it("hides feature-gated cards when their modules are disabled", async () => {
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({
      ...allOn,
      skifieldConditions: false,
    });

    const html = await renderPage(AppearanceHubPage);

    expect(html).not.toContain("Mountain Conditions");
    expect(html).not.toContain("/admin/mountain-conditions");
  });

  it("keeps the Integrations hub reachable with Xero off, hiding only the Xero card (#2216)", async () => {
    // The hub is no longer gated on xeroIntegration (#2216): it renders whenever
    // any integration module is on, and AdminHubPage filters each card by its
    // own feature href — so the Xero card drops out while the hub (and every
    // other integration card / back-link) stays reachable.
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({
      ...allOn,
      xeroIntegration: false,
    });

    const html = await renderPage(IntegrationsHubPage);

    expect(html).toContain("Integrations");
    expect(html).not.toContain("Xero Setup");
    expect(html).not.toContain("/admin/xero/setup");
    // Other integration cards remain reachable from the hub.
    expect(html).toContain("/admin/stripe/setup");
    expect(html).toContain("/admin/backups");
  });

  it("renders the new setup drill-down hub pages", async () => {
    const foundationHtml = await renderPage(FoundationsSetupHubPage);
    const bookingHtml = await renderPage(BookingRulesSetupHubPage);
    const integrationsHtml = await renderPage(
      OperationalIntegrationsSetupHubPage,
    );
    const cancellationHtml = await renderPage(CancellationSetupHubPage);

    expect(foundationHtml).toContain("Initial Setup");
    expect(foundationHtml).toContain("/admin/modules");
    // E3 follow-up #1966: foundations cross-links the content-gated Club
    // Identity cards under Admin > Appearance.
    expect(foundationHtml).toContain("Club Identity");
    expect(foundationHtml).toContain("/admin/appearance/identity");
    expect(bookingHtml).toContain("Booking Rules");
    expect(bookingHtml).toContain("/admin/booking-policies");
    expect(integrationsHtml).toContain("Operational Integrations");
    expect(integrationsHtml).toContain("/admin/xero/setup");
    expect(cancellationHtml).toContain("Cancellation");
    expect(cancellationHtml).toContain("/admin/membership-cancellation");
  });

  it("hides the Club Identity cross-link without content access (#1966)", async () => {
    vi.mocked(loadAdminSetupPermissionMatrix).mockResolvedValue({
      ...allAreasView,
      content: "none",
    });

    const html = await renderPage(FoundationsSetupHubPage);

    expect(html).not.toContain("Club Identity");
    expect(html).not.toContain("/admin/appearance/identity");
  });

  it("renders a back link to the setup checklist on every setup sub-hub", async () => {
    // The sub-hubs are drilled into from /admin/setup, so each gets the shared
    // BackLink, and its label MATCHES THE DESTINATION PAGE'S HEADING — which is
    // why both moved together in #220: "Setup Wizard" was that page's h1 and is
    // now the guided journey's name, one route along at /admin/setup/wizard.
    // Distinct from Foundations' own "Setup Checklist" card, which is a grid link.
    const pages = [
      FoundationsSetupHubPage,
      BookingRulesSetupHubPage,
      CancellationSetupHubPage,
      OperationalIntegrationsSetupHubPage,
      FinanceSetupPage,
    ];
    for (const Page of pages) {
      const html = await renderPage(Page);
      expect(html).toContain("Setup checklist");
      expect(html).toContain('href="/admin/setup"');
    }
  });

  /*
    D-C8-1. The report-mapping editor moved to `/finance`, so the finance hub no
    longer carries it — it links to the dashboard that does. Asserted here as
    well as on the destination because "no longer renders it" is the half a
    render test on the new home cannot see.
  */
  it("no longer renders the report-mapping editor, and links to where it went", async () => {
    const html = await renderPage(FinanceSetupPage);

    expect(html).toContain("Finance Dashboard");
    expect(html).toContain("Xero Mappings");
    expect(html).toContain('href="/finance"');
    expect(html).not.toContain("Finance Report Mappings");
    expect(html).not.toContain("Finance mappings editor");
  });

  it("hides finance drill-down cards without finance access", async () => {
    vi.mocked(loadAdminSetupPermissionMatrix).mockResolvedValue({
      ...allAreasView,
      finance: "none",
    });

    const html = await renderPage(FinanceSetupPage);

    expect(html).not.toContain("Finance Dashboard");
    expect(html).toContain(
      "Finance setup pages are not available for your current permissions",
    );
  });

  /*
    One hidden-position case here as well as in the redirect suite, because
    everything else in this file now runs with the switch stubbed OFF — and a
    stub that is never exercised in the other position is a stub that could be
    wired to the wrong thing without anybody noticing.
  */
  it("redirects the finance hub to /finance when the legacy surfaces are hidden", async () => {
    vi.mocked(loadSetupSurfaceSettings).mockResolvedValue({
      legacySurfacesHidden: true,
    });

    await expect(renderPage(FinanceSetupPage)).rejects.toThrow(
      "NEXT_REDIRECT:/finance",
    );
  });
});
