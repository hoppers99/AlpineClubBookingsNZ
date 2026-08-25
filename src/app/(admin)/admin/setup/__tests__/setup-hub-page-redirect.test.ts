import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The four retired hubs' route half of #223's acceptance criterion 3: WHERE the
 * legacy-surfaces setting is hidden, the hub pages are ABSENT.
 *
 * Absent, not removed. Each route still exists and still answers — it answers by
 * sending the operator to `/admin/setup`, which stays reachable in both
 * positions and carries the switch, so a stale bookmark lands somewhere that
 * explains itself instead of on a 404. The other candidate, the 404 a disabled
 * module's route returns, is the wrong shape here and the page comments say why.
 *
 * MOCKED AT THE SEAM, not at the database: this is about the guard's decision,
 * so `loadSetupSurfaceSettings` is the thing stubbed. `redirect()` is stubbed to
 * throw the way Next's own does — it never returns — which is also what proves
 * the guard runs BEFORE the page's data loads: if the redirect did not short
 * out, the permission-matrix and module-flag loaders below would be called, and
 * each test asserts they were not.
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

const HUB_PAGES = [
  ["Initial Setup", () => import("../foundations/page")],
  ["Finance", () => import("../finance/page")],
  ["Booking Rules", () => import("../booking-rules/page")],
  ["Operational Integrations", () => import("../integrations/page")],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  loadAdminSetupPermissionMatrix.mockResolvedValue({});
  loadEffectiveModuleFlags.mockResolvedValue({});
});

describe("the four retired setup hubs (#223 AC3)", () => {
  for (const [name, load] of HUB_PAGES) {
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

    it(`${name} renders normally when the legacy surfaces are shown`, async () => {
      loadSetupSurfaceSettings.mockResolvedValue({
        legacySurfacesHidden: false,
      });
      const { default: Page } = await load();

      await expect(Page()).resolves.toBeTruthy();
      expect(redirect).not.toHaveBeenCalled();
    });

    it(`${name} renders normally when the setting cannot be read`, async () => {
      // FAIL OPEN. The loader itself catches and returns the default, so this
      // is the belt to that braces: even handed a record with the field absent,
      // the predicate must not hide a surface an operator is relying on.
      loadSetupSurfaceSettings.mockResolvedValue({});
      const { default: Page } = await load();

      await expect(Page()).resolves.toBeTruthy();
      expect(redirect).not.toHaveBeenCalled();
    });
  }
});
