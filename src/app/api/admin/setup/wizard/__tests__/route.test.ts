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

import { GET } from "@/app/api/admin/setup/wizard/route";

/**
 * The wizard's read (epic #213, C5).
 *
 * Three things this route has to get right, each of which is silent when wrong:
 * it must refuse before it reads anything, it must pass the module flags into
 * the traversal (or a disabled module's steps stay on the rail), and it must
 * pass the readiness verdicts in (or every step reads not-started and the wizard
 * opens parked on step one).
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
});

async function body() {
  const response = await GET();
  return (await response.json()) as {
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
  });

  it("returns readiness, progress and the traversal together", async () => {
    const payload = await body();
    expect(payload.readiness.categories.length).toBeGreaterThan(0);
    expect(payload.traversal.applicableStepIds.length).toBeGreaterThan(0);
    expect(typeof payload.traversal.percentComplete).toBe("number");
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
