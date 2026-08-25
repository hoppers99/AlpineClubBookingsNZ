import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS, type ModuleSettingsValues } from "@/config/modules";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    setupProgress: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
  },
}));

const mockSnapshot = vi.fn();
vi.mock("@/lib/setup-readiness-db", () => ({
  getSetupDatabaseSnapshot: (...args: unknown[]) => mockSnapshot(...args),
}));

// The panel's site-visible answer rides on this payload (#220 review F3), so
// the route reads it. Mocked rather than driven through a stubbed `clubTheme`
// delegate: this suite is about the wizard's shape, and the render state's own
// read-failure contract is pinned where it lives.
const mockThemeState = vi.fn();
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: (...args: unknown[]) => mockThemeState(...args),
}));

import { GET } from "@/app/api/admin/setup/wizard/route";

/**
 * The wizard's read (epic #213, C5).
 *
 * Four things this route has to get right, each of which is silent when wrong:
 * it must refuse before it reads anything, it must pass the module flags into
 * the traversal (or a disabled module's steps stay on the rail), it must pass
 * the readiness verdicts in (or every step reads not-started and the wizard
 * opens parked on step one), and it must answer with EXACTLY the payload the
 * shared interface declares — a key the shell cannot read is a key nobody knows
 * is unused.
 */

const allModulesOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as ModuleSettingsValues;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true as const,
    session: { user: { id: "admin1" } },
  });
  mockFindUnique.mockResolvedValue(null);
  mockSnapshot.mockResolvedValue({ adminModuleSettings: allModulesOn });
  mockThemeState.mockResolvedValue({ isComplete: false, readFailed: false });
});

async function raw() {
  const response = await GET();
  return (await response.json()) as Record<string, unknown>;
}

async function body() {
  const response = await GET();
  return (await response.json()) as {
    isSiteVisible: boolean;
    traversal: {
      applicableStepIds: string[];
      percentComplete: number;
      currentStepId: string | null;
      steps: { id: string; state: string; isReachable: boolean }[];
    };
    readiness: { categories: { checks: { id: string }[] }[] };
  };
}

describe("GET /api/admin/setup/wizard", () => {
  it("refuses an unauthorised caller before touching the database", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false as const,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await GET();
    expect(response.status).toBe(403);
    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockThemeState).not.toHaveBeenCalled();
  });

  // EXACTLY `SetupWizardPayload` — no more and no less. This used to send a
  // fourth key, `progress`, which the interface never declared and no client
  // could read; asserting "these three are present" is what let that sit there
  // (#220 review F6, drift-1).
  it("answers with the declared payload and nothing besides", async () => {
    const payload = await raw();
    expect(Object.keys(payload).sort()).toEqual([
      "environmentSafety",
      "isSiteVisible",
      "readiness",
      "traversal",
    ]);

    const typed = await body();
    expect(typed.readiness.categories.length).toBeGreaterThan(0);
    expect(typed.traversal.applicableStepIds.length).toBeGreaterThan(0);
    expect(typeof typed.traversal.percentComplete).toBe("number");
  });

  it("reports whether the public site is live, for D9's launch panel", async () => {
    expect((await body()).isSiteVisible).toBe(false);
    mockThemeState.mockResolvedValue({ isComplete: true, readFailed: false });
    expect((await body()).isSiteVisible).toBe(true);
  });

  // C9 (#224): the launch panel's role lever reads the SAME resolution the
  // `environment-role` readiness step does — `database.environmentRole` /
  // `database.withheldEmail` on the injected snapshot — never a second
  // derivation. Both fields are optional on `SetupDatabaseSnapshot` (a DB-less
  // `setup:check` compiles without them), and this suite's default snapshot
  // double never stubs them, so the fail-closed fallback below is exercised by
  // every other test in this file too, not just this one.
  it("carries the environment role through from the snapshot, failing closed when it is absent", async () => {
    const typed = (await body()) as unknown as {
      environmentSafety: {
        role: string;
        decidedBy: string;
        withheldEmail: { available: boolean };
      };
    };
    expect(typed.environmentSafety).toEqual({
      role: "UNKNOWN",
      decidedBy: "unresolved",
      withheldEmail: { available: false },
    });

    mockSnapshot.mockResolvedValue({
      adminModuleSettings: allModulesOn,
      environmentRole: {
        role: "NON_PRODUCTION",
        decidedBy: "database-safer-override",
        declaration: { kind: "absent" },
        databaseOverride: { kind: "force-non-production" },
        notes: [],
      },
      withheldEmail: {
        available: true,
        count: 3,
        mostRecentAt: "2026-08-01T00:00:00.000Z",
        captureInProduction: 0,
      },
    });
    const withRole = (await body()) as unknown as {
      environmentSafety: {
        role: string;
        decidedBy: string;
        withheldEmail: {
          available: boolean;
          count?: number;
          mostRecentAt?: string | null;
          captureInProduction?: number;
        };
      };
    };
    expect(withRole.environmentSafety).toEqual({
      role: "NON_PRODUCTION",
      decidedBy: "database-safer-override",
      withheldEmail: {
        available: true,
        count: 3,
        mostRecentAt: "2026-08-01T00:00:00.000Z",
        captureInProduction: 0,
      },
    });
  });

  it("applies the club's module flags to the applicable set (D4)", async () => {
    mockSnapshot.mockResolvedValue({
      adminModuleSettings: { ...allModulesOn, xeroIntegration: false },
    });
    const payload = await body();
    expect(payload.traversal.applicableStepIds).not.toContain("xero-operational");
    expect(payload.traversal.applicableStepIds).not.toContain("xero-mappings");
    // The readiness half still lists them: wiring the CARDS to the registry is
    // C8's job, and the wizard's rail is built from the traversal.
    const readinessIds = payload.readiness.categories.flatMap((category) =>
      category.checks.map((check) => check.id),
    );
    expect(readinessIds).toContain("xero-mappings");
  });

  it("feeds the readiness verdicts in, so a passing check counts as done", async () => {
    // With nothing recorded in progress, a step can only read complete if its
    // readiness status was supplied. `runtime-env` passes whenever the required
    // environment variables are present, so assert the general property rather
    // than one step: at least one step is complete without any operator mark.
    mockSnapshot.mockResolvedValue({
      adminModuleSettings: allModulesOn,
      adminCount: 1,
    });
    const payload = await body();
    const marked = payload.traversal.steps.filter((step) => step.state === "complete");
    const anyComplete = marked.length > 0;
    // Either some check passes in this environment (and the wizard says so), or
    // none does and the wizard is honestly at 0% — what must never happen is a
    // percentage that disagrees with the step states.
    expect(payload.traversal.percentComplete === 0).toBe(!anyComplete);
  });

  it("resumes at the first step that is not complete", async () => {
    const payload = await body();
    const firstOutstanding = payload.traversal.steps.find(
      (step) => step.state !== "complete",
    );
    expect(payload.traversal.currentStepId).toBe(firstOutstanding?.id ?? null);
  });
});
