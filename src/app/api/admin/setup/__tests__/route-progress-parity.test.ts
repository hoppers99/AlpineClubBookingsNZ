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

// Only the wizard route reads this one; the checklist route does not. Mocked
// here because both handlers are imported into one module graph.
const mockThemeState = vi.fn();
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: (...args: unknown[]) => mockThemeState(...args),
}));

import { GET as checklistGET } from "@/app/api/admin/setup/route";
import { GET as wizardGET } from "@/app/api/admin/setup/wizard/route";

/**
 * ONE PERCENTAGE, TWO SURFACES (#237 fix round, D7/D14).
 *
 * `/admin/setup`'s Progress tile and the wizard's rail answer the same question,
 * and until this round they answered it differently: the tile counted
 * `status === "complete" || progress === "completed"` in the browser — the union
 * D14 split apart — so a freshly seeded install read **56%** on the checklist
 * and **0%** one click away in the wizard.
 *
 * The tile now renders `wizardPercentComplete`, which
 * `/api/admin/setup/route.ts` takes straight off `buildSetupWizardTraversal`.
 * That leaves ONE derivation and two routes constructing it, and a Next.js route
 * file may export only handlers — so the construction cannot be lifted into one
 * route and imported by the other. This file is what stands in for that: both
 * handlers are driven over ONE set of doubles and the two numbers must match.
 *
 * It is a behavioural guard rather than a source scan on purpose. What matters
 * is that the two routes answer the same, not that they are spelled the same —
 * a future refactor that shares the construction properly should keep this test
 * passing untouched, and a lane that quietly drops `staleStepIds` or the module
 * flags from one of the two should not.
 */

const allModulesOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as ModuleSettingsValues;

/**
 * A snapshot whose checks pass — most of them because a shipped default
 * satisfies them, `clubIdentityName` deliberately not: since the seed gate
 * (#237) no installer writes a placeholder identity, so a real club only
 * reaches this value through an actual edit or a config-transfer import (see
 * `SETUP_STEP_DEFAULTED_EVIDENCE["club-config"]`, `read-from-deployment`, in
 * `setup-wizard-step-tables.ts`). Kept anyway, ON PURPOSE: the hazard this test
 * guards against is any unconfirmed check counting as progress, not only the
 * installer-defaulted ones, so a check satisfied by genuinely-chosen data has
 * to read 0% here too until somebody confirms it.
 */
function seededSnapshot() {
  return {
    adminModuleSettings: allModulesOn,
    adminCount: 1,
    ageTierSettingCount: 4,
    seasonCount: 2,
    cancellationPolicyCount: 3,
    bookingDefaultsConfigured: true,
    membershipCancellationSettingsConfigured: true,
    clubIdentityName: "Example Mountain Club",
    configuredCapacity: 20,
    defaultLodgeCapacity: 20,
  };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "default",
    completedStepIds: [],
    skippedStepIds: [],
    staleStepIds: [],
    completedAt: null,
    completedByMemberId: null,
    ...overrides,
  };
}

async function checklistBody() {
  return (await (await checklistGET()).json()) as {
    wizardPercentComplete: number;
    readiness: { summary: { total: number; complete: number } };
  };
}

async function checklistPercent() {
  return (await checklistBody()).wizardPercentComplete;
}

async function wizardPercent() {
  const body = (await (await wizardGET()).json()) as {
    traversal: { percentComplete: number };
  };
  return body.traversal.percentComplete;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true as const,
    session: { user: { id: "admin1" } },
  });
  mockFindUnique.mockResolvedValue(null);
  mockSnapshot.mockResolvedValue(seededSnapshot());
  mockThemeState.mockResolvedValue({ isComplete: false, readFailed: false });
});

describe("the checklist tile's percentage and the wizard's percentage", () => {
  /*
    THE FRESH-INSTALL PARITY TEST. A seeded install satisfies a good number of
    readiness checks on its own; nobody has confirmed one. Both surfaces must
    therefore say 0, and the tile's old union said 56.

    Mutation-verified: restoring the union in `setup-page-client.tsx` cannot fail
    this file (the derivation moved off the client entirely, which is the point),
    so the tile's own half is pinned by `setup-page-progress-tile.test.tsx`. What
    this pins is the SERVER's answer being one answer.
  */
  it("both read 0 on a fresh install whose defaults satisfy their checks", async () => {
    const body = await checklistBody();
    // NOT VACUOUS, and this is the assertion that keeps it so: the readiness
    // summary — which still counts the union, deliberately (see
    // `resolveSetupStepCompletion`'s docblock) — reports a good number of these
    // very steps as complete on the same payload. That figure is what the tile
    // used to render as a percentage.
    expect(body.readiness.summary.complete).toBeGreaterThan(3);
    expect(body.wizardPercentComplete).toBe(0);
    expect(await wizardPercent()).toBe(0);
  });

  it("agree once an operator has confirmed some steps", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({ completedStepIds: ["club-time-zone", "age-tiers"] }),
    );

    const checklist = await checklistPercent();
    expect(checklist).toBe(await wizardPercent());
    // Not a vacuous 0 === 0: the confirmations have to have moved something.
    expect(checklist).toBeGreaterThan(0);
  });

  it("agree with a module switched off, which moves the denominator", async () => {
    mockSnapshot.mockResolvedValue({
      ...seededSnapshot(),
      adminModuleSettings: { ...allModulesOn, xeroIntegration: false },
    });
    mockFindUnique.mockResolvedValue(
      storedRow({ completedStepIds: ["club-time-zone"] }),
    );

    expect(await checklistPercent()).toBe(await wizardPercent());
  });

  it("agree when the stored stale set puts a confirmed step back in question", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["club-time-zone", "age-tiers"],
        staleStepIds: ["age-tiers"],
      }),
    );

    expect(await checklistPercent()).toBe(await wizardPercent());
  });
});
