import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit coverage for the setup-aware admin nudge's pure predicates and its one
 * database read (epic #213, C10, #236 fix round F2/F4/F5).
 *
 * `site-style-route-gating.test.tsx` covers the wiring — the admin layout
 * rendering the right copy for the right actor — and stays the integration
 * suite of record. This file is the cheap, exhaustive complement: every
 * branch of `shouldShowSetupNudge` and `canSetupNudgeAppear` as plain function
 * calls, with no React render and no admin-permission-matrix derivation in the
 * way, plus `readSetupJourneyComplete`'s catch path.
 */

const mocks = vi.hoisted(() => ({
  setupProgressFindUnique: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    setupProgress: { findUnique: mocks.setupProgressFindUnique },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: mocks.logger,
}));

import {
  canSetupNudgeAppear,
  readSetupJourneyComplete,
  shouldShowSetupNudge,
  SETUP_WIZARD_HREF,
} from "@/lib/setup-nudge";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

function matrixWith(overrides: Partial<AdminPermissionMatrix>): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

// `/admin/setup/wizard` is a `support` area, GET (view) route — see
// `admin-permissions.ts`'s `ROUTE_AREA_PREFIXES` and the wizard's own
// `getAdminRouteRequirement` resolution.
const SUPPORT_VIEW_MATRIX = matrixWith({ support: "view" });
const NO_ACCESS_MATRIX = emptyAdminPermissionMatrix();

describe("setup-nudge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("canSetupNudgeAppear", () => {
    it("is true for a viewer who can reach the wizard, off the setup pages", () => {
      expect(
        canSetupNudgeAppear({
          requestedPath: "/admin/dashboard",
          permissionMatrix: SUPPORT_VIEW_MATRIX,
        }),
      ).toBe(true);
    });

    it("is false under the bare /admin/setup route", () => {
      expect(
        canSetupNudgeAppear({
          requestedPath: "/admin/setup",
          permissionMatrix: SUPPORT_VIEW_MATRIX,
        }),
      ).toBe(false);
    });

    it("is false under a nested /admin/setup/* route", () => {
      expect(
        canSetupNudgeAppear({
          requestedPath: "/admin/setup/wizard",
          permissionMatrix: SUPPORT_VIEW_MATRIX,
        }),
      ).toBe(false);
    });

    it("is false with the setup path carried as a query string (REQUEST_PATH_HEADER shape)", () => {
      // `REQUEST_PATH_HEADER` carries `${pathname}${search}` — a query on an
      // otherwise-unsuppressed page must not itself smuggle a `/admin/setup`
      // suppression, but `/admin/setup` itself WITH a query must still strip
      // to the suppressed path.
      expect(
        canSetupNudgeAppear({
          requestedPath: "/admin/setup?tab=finance",
          permissionMatrix: SUPPORT_VIEW_MATRIX,
        }),
      ).toBe(false);
    });

    it("is true for a near-miss path that merely starts with the same letters", () => {
      // Not a real route, but the point is `/admin/setup` matched as a full
      // path SEGMENT (`===` or `startsWith(prefix + "/")`), never a bare
      // string prefix — `/admin/setupextra` is not "under" `/admin/setup`.
      expect(
        canSetupNudgeAppear({
          requestedPath: "/admin/setupextra",
          permissionMatrix: SUPPORT_VIEW_MATRIX,
        }),
      ).toBe(true);
    });

    it("is true on an ordinary admin path outside setup, e.g. /admin/settings", () => {
      expect(
        canSetupNudgeAppear({
          requestedPath: "/admin/settings",
          permissionMatrix: SUPPORT_VIEW_MATRIX,
        }),
      ).toBe(true);
    });

    it("is false for a viewer whose matrix cannot reach the wizard (no support access)", () => {
      expect(
        canSetupNudgeAppear({
          requestedPath: "/admin/dashboard",
          permissionMatrix: NO_ACCESS_MATRIX,
        }),
      ).toBe(false);
    });

    it("is false for null/undefined requestedPath treated as not-under-setup but still gated on the matrix", () => {
      // A missing path is not "under /admin/setup" (isUnderSetupArea returns
      // false for null/undefined), so the outcome here turns entirely on the
      // permission matrix.
      expect(
        canSetupNudgeAppear({
          requestedPath: null,
          permissionMatrix: SUPPORT_VIEW_MATRIX,
        }),
      ).toBe(true);
      expect(
        canSetupNudgeAppear({
          requestedPath: undefined,
          permissionMatrix: NO_ACCESS_MATRIX,
        }),
      ).toBe(false);
    });
  });

  describe("shouldShowSetupNudge", () => {
    const baseInput = {
      requestedPath: "/admin/dashboard",
      permissionMatrix: SUPPORT_VIEW_MATRIX,
    };

    it("returns 'journey-incomplete' when the journey is unfinished", () => {
      expect(
        shouldShowSetupNudge({
          ...baseInput,
          journeyComplete: false,
          journeyReadFailed: false,
          themeComplete: false,
        }),
      ).toBe("journey-incomplete");
    });

    it("returns 'journey-incomplete' even when the theme happens to be launched already", () => {
      // Journey state takes priority — an unfinished journey is the more
      // pressing fact regardless of what the (unrelated) launch lever reads.
      expect(
        shouldShowSetupNudge({
          ...baseInput,
          journeyComplete: false,
          journeyReadFailed: false,
          themeComplete: true,
        }),
      ).toBe("journey-incomplete");
    });

    it("returns 'launch-pending' when the journey is finished but the site is not launched (F1)", () => {
      expect(
        shouldShowSetupNudge({
          ...baseInput,
          journeyComplete: true,
          journeyReadFailed: false,
          themeComplete: false,
        }),
      ).toBe("launch-pending");
    });

    it("returns null when both the journey and the launch are finished", () => {
      expect(
        shouldShowSetupNudge({
          ...baseInput,
          journeyComplete: true,
          journeyReadFailed: false,
          themeComplete: true,
        }),
      ).toBeNull();
    });

    it("returns null under /admin/setup even with the journey unfinished", () => {
      expect(
        shouldShowSetupNudge({
          ...baseInput,
          requestedPath: "/admin/setup",
          journeyComplete: false,
          journeyReadFailed: false,
          themeComplete: false,
        }),
      ).toBeNull();
    });

    it("returns null for a viewer the wizard would not admit, even with the journey unfinished", () => {
      expect(
        shouldShowSetupNudge({
          ...baseInput,
          permissionMatrix: NO_ACCESS_MATRIX,
          journeyComplete: false,
          journeyReadFailed: false,
          themeComplete: false,
        }),
      ).toBeNull();
    });

    it("returns null on a journey read failure, regardless of the launch state (F2 — fail toward HIDDEN)", () => {
      expect(
        shouldShowSetupNudge({
          ...baseInput,
          journeyComplete: false,
          journeyReadFailed: true,
          themeComplete: false,
        }),
      ).toBeNull();

      // The note in the module doc, made concrete: a read failure hides the
      // 'launch-pending' branch too, even though `journeyComplete: true` +
      // `themeComplete: false` would otherwise be exactly that case.
      expect(
        shouldShowSetupNudge({
          ...baseInput,
          journeyComplete: true,
          journeyReadFailed: true,
          themeComplete: false,
        }),
      ).toBeNull();
    });
  });

  describe("readSetupJourneyComplete", () => {
    it("reports complete:true, readFailed:false when SetupProgress.completedAt is set", async () => {
      mocks.setupProgressFindUnique.mockResolvedValue({
        completedAt: new Date("2026-01-01T00:00:00Z"),
      });

      await expect(readSetupJourneyComplete()).resolves.toEqual({
        complete: true,
        readFailed: false,
      });
    });

    it("reports complete:false, readFailed:false when the row is null (never finished)", async () => {
      mocks.setupProgressFindUnique.mockResolvedValue(null);

      await expect(readSetupJourneyComplete()).resolves.toEqual({
        complete: false,
        readFailed: false,
      });
    });

    it("reports complete:false, readFailed:true and logs when the read throws (F2)", async () => {
      const dbError = new Error("connection reset");
      mocks.setupProgressFindUnique.mockRejectedValue(dbError);

      await expect(readSetupJourneyComplete()).resolves.toEqual({
        complete: false,
        readFailed: true,
      });
      expect(mocks.logger.error).toHaveBeenCalledTimes(1);
      const [meta, message] = mocks.logger.error.mock.calls[0];
      expect(meta).toEqual({ err: dbError });
      expect(message).toMatch(/setup nudge/i);
    });
  });

  it("SETUP_WIZARD_HREF is the wizard route, never Site Style", () => {
    expect(SETUP_WIZARD_HREF).toBe("/admin/setup/wizard");
  });
});
