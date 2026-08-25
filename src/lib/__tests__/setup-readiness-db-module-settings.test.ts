import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

/*
  A whole-client stand-in, same shape as club-time-zone-backfill.test.ts's
  readiness-snapshot suite: every delegate other than `clubModuleSettings`
  answers with the empty shape its caller already tolerates (a `count` of 0,
  an empty `findMany`, a null `findUnique`), and `clubModuleSettings.findUnique`
  is a real spy the tests drive.
*/
const { clubModuleSettingsFindUnique, mockPrisma } = vi.hoisted(() => {
  const clubModuleSettingsFindUnique = vi.fn();
  const emptyDelegate = new Proxy(
    {},
    {
      get: (_target, method: string) => {
        if (method === "count") return async () => 0;
        if (method === "findMany") return async () => [];
        return async () => null;
      },
    },
  );
  const mockPrisma = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        model === "clubModuleSettings"
          ? { findUnique: clubModuleSettingsFindUnique }
          : emptyDelegate,
    },
  );
  return { clubModuleSettingsFindUnique, mockPrisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lodge-capacity")>()),
  getDefaultLodgeCapacity: vi.fn(async () => 12),
}));
vi.mock("@/lib/stripe-config", () => ({
  getStripeSetupState: vi.fn(async () => ({
    secretKeySet: false,
    publishableKeySet: false,
    webhookSecretSet: false,
    needsReentry: false,
  })),
}));
vi.mock("@/lib/xero-token-store", () => ({
  getXeroTokenReadability: vi.fn(async () => "readable"),
}));

import { MODULE_KEYS } from "@/config/modules";
import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";

/**
 * The `ClubModuleSettings` singleton is always read via the canonical select
 * (`CLUB_MODULE_SETTINGS_COLUMN_SELECT`, `src/config/modules.ts`), which — for
 * good reason (see that constant's doc) — also carries the two audit columns
 * `updatedAt` and `updatedByMemberId`. `SetupDatabaseSnapshot.adminModuleSettings`
 * is typed `Record<ModuleKey, boolean> | null`, and TypeScript's structural
 * typing lets a wider runtime object satisfy that narrower type silently — no
 * assignment-time error tells you the audit columns rode along. This test
 * exercises the REAL projection in `getSetupDatabaseSnapshot`
 * (`src/lib/setup-readiness-db.ts`), not a mock of it, so a regression that
 * removes the projection and goes back to handing the raw Prisma row straight
 * through is caught here rather than merely typechecking clean.
 */
describe("getSetupDatabaseSnapshot — adminModuleSettings is projected onto MODULE_KEYS", () => {
  beforeEach(() => {
    clubModuleSettingsFindUnique.mockReset();
  });

  it("has exactly MODULE_KEYS as keys, even though the canonical select's row also carries the audit columns", async () => {
    const allModulesOn = Object.fromEntries(
      MODULE_KEYS.map((key) => [key, true]),
    );
    clubModuleSettingsFindUnique.mockResolvedValue({
      ...allModulesOn,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedByMemberId: "member-1",
    });

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.adminModuleSettings).not.toBeNull();
    const keys = Object.keys(snapshot.adminModuleSettings ?? {}).sort();
    expect(keys).toEqual([...MODULE_KEYS].sort());
    expect(keys).not.toContain("updatedAt");
    expect(keys).not.toContain("updatedByMemberId");
  });

  it("preserves each module's actual value through the projection", async () => {
    const allModulesOff = Object.fromEntries(
      MODULE_KEYS.map((key) => [key, false]),
    );
    clubModuleSettingsFindUnique.mockResolvedValue({
      ...allModulesOff,
      xeroIntegration: true,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedByMemberId: null,
    });

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.adminModuleSettings).toMatchObject({
      ...allModulesOff,
      xeroIntegration: true,
    });
  });

  it("stays null when there is no saved ClubModuleSettings row", async () => {
    clubModuleSettingsFindUnique.mockResolvedValue(null);

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.adminModuleSettings).toBeNull();
  });
});
