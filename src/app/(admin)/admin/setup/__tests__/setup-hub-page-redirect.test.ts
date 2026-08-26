import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSetupSurfaceSettings } from "@/lib/setup-surface-settings";

/**
 * The four retired hubs' route half of #223's acceptance criterion 3: WHERE the
 * legacy-surfaces setting is hidden, the hub pages are ABSENT.
 *
 * Absent, not removed. Each route still exists and still answers — three of them
 * by sending the operator to `/admin/setup`, which stays reachable in both
 * positions and carries the switch, so a stale bookmark lands somewhere that
 * explains itself instead of on a 404. The other candidate, the 404 a disabled
 * module's route returns, is the wrong shape here and
 * `areLegacySetupSurfacesHidden`'s docblock says why.
 *
 * FINANCE IS THE FOURTH AND IT DIFFERS (D-C8-1): its report-mapping editor moved
 * to `/finance`, so that is where its bookmark goes — with a fallback to
 * `/admin/setup` when the `financeDashboard` module is off, because `/finance`
 * is module-gated and redirecting into a 404 would be worse than the 403 the
 * decision set out to remove. Both branches are pinned below.
 *
 * MOCKED AT THE SEAM, not at the database: this is about the guard's decision,
 * so `loadSetupSurfaceSettings` is the thing stubbed. `redirect()` is stubbed to
 * throw the way Next's own does — it never returns — which is also what proves
 * the guard runs BEFORE the page RENDERS: if the redirect did not short out, the
 * permission matrix would be consulted for the visible links.
 */

const redirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
const loadSetupSurfaceSettings = vi.fn();
const loadAdminSetupPermissionMatrix = vi.fn();
const loadEffectiveModuleFlags = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

vi.mock("@/lib/setup-surface-settings", async (importOriginal) => {
  // Partial mock: `areLegacySetupSurfacesHidden` is the pure predicate the
  // pages call on whatever the loader returned, and stubbing it too would mean
  // testing nothing but the mock.
  const actual =
    await importOriginal<typeof import("@/lib/setup-surface-settings")>();
  return { ...actual, loadSetupSurfaceSettings: () => loadSetupSurfaceSettings() };
});

vi.mock("../permission-matrix", () => ({
  loadAdminSetupPermissionMatrix: () => loadAdminSetupPermissionMatrix(),
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: () => loadEffectiveModuleFlags(),
}));

/**
 * The three whose target does not depend on anything else, and which therefore
 * still redirect before loading a single thing.
 */
const SETUP_PAGE_HUBS = [
  ["Initial Setup", () => import("../foundations/page")],
  ["Booking Rules", () => import("../booking-rules/page")],
  ["Operational Integrations", () => import("../integrations/page")],
] as const;

const ALL_HUBS = [
  ...SETUP_PAGE_HUBS,
  ["Finance", () => import("../finance/page")],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  loadAdminSetupPermissionMatrix.mockResolvedValue({ finance: "edit" });
  loadEffectiveModuleFlags.mockResolvedValue({ financeDashboard: true });
});

describe("the four retired setup hubs (#223 AC3)", () => {
  for (const [name, load] of SETUP_PAGE_HUBS) {
    it(`${name} redirects to /admin/setup when the legacy surfaces are hidden`, async () => {
      loadSetupSurfaceSettings.mockResolvedValue({
        legacySurfacesHidden: true,
      });
      const { default: Page } = await load();

      await expect(Page()).rejects.toThrow("NEXT_REDIRECT:/admin/setup");
      expect(redirect).toHaveBeenCalledWith("/admin/setup");
      // The guard runs FIRST: nothing else was loaded on the way out.
      expect(loadAdminSetupPermissionMatrix).not.toHaveBeenCalled();
      expect(loadEffectiveModuleFlags).not.toHaveBeenCalled();
    });
  }

  /*
    D-C8-1's redirect, and the reason it is not simply "/finance": with the
    finance dashboard module off, `/finance` is module-gated and the proxy
    freezes it to a 404, so a bookmark would land somewhere strictly worse than
    the 403 the decision set out to remove.
  */
  it("Finance redirects to /finance, where its report-mapping editor now lives", async () => {
    loadSetupSurfaceSettings.mockResolvedValue({ legacySurfacesHidden: true });
    const { default: Page } = await import("../finance/page");

    await expect(Page()).rejects.toThrow("NEXT_REDIRECT:/finance");
    expect(redirect).toHaveBeenCalledWith("/finance");
  });

  it("Finance falls back to /admin/setup when the finance dashboard is off", async () => {
    loadSetupSurfaceSettings.mockResolvedValue({ legacySurfacesHidden: true });
    loadEffectiveModuleFlags.mockResolvedValue({ financeDashboard: false });
    const { default: Page } = await import("../finance/page");

    await expect(Page()).rejects.toThrow("NEXT_REDIRECT:/admin/setup");
    expect(redirect).toHaveBeenCalledWith("/admin/setup");
  });

  for (const [name, load] of ALL_HUBS) {
    it(`${name} renders normally when the legacy surfaces are shown`, async () => {
      loadSetupSurfaceSettings.mockResolvedValue({
        legacySurfacesHidden: false,
      });
      const { default: Page } = await load();

      await expect(Page()).resolves.toBeTruthy();
      expect(redirect).not.toHaveBeenCalled();
    });

    it(`${name} renders normally when the club has never saved the setting`, async () => {
      // FAIL OPEN, at the shape the loader really hands these pages: it catches
      // its own errors and normalises, so what arrives is always a complete
      // record — and on a club that never opened the section, the default. The
      // predicate must read that as "shown".
      loadSetupSurfaceSettings.mockResolvedValue(
        normalizeSetupSurfaceSettings(null),
      );
      const { default: Page } = await load();

      await expect(Page()).resolves.toBeTruthy();
      expect(redirect).not.toHaveBeenCalled();
    });
  }
});
