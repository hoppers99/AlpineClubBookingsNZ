import { describe, expect, it } from "vitest";
import { MODULE_KEYS, type ModuleSettingsValues } from "@/config/modules";
import {
  buildSetupReadiness,
  type SetupDatabaseSnapshot,
  type SetupProgressState,
} from "@/lib/setup-readiness";
import {
  SETUP_STEP_IDS,
  SETUP_STEP_REGISTRY,
  findSetupStepRegistryViolations,
  getApplicableSetupStepIds,
  isSetupStepComplete,
  type SetupStepDefinition,
} from "@/lib/setup-step-registry";
import { SETUP_STEP_DEFINITIONS } from "@/lib/setup-step-registry-definitions";

/**
 * The C1 contract tests (epic #213). "The build fails" in this repository means
 * a test in the `verify` job fails, so the registry guards are asserted here
 * rather than thrown at module load — a malformed declaration should redden CI,
 * not crash a running club's admin pages.
 */

// The step set as it stood when the registry replaced the hand-maintained array
// (17 ids, `club-time-zone` added upstream by #2989). Written out rather than
// derived: a pin that recomputes itself from the thing it is pinning proves
// nothing. C1 must not change what the readiness cards show, so a diff here is
// either a deliberate journey change or the regression this test exists to
// catch.
const EXPECTED_STEP_IDS = [
  "club-config",
  "club-time-zone",
  "runtime-env",
  "auth-secret-strength",
  "seed-admin",
  "feature-flags",
  "booking-policies",
  "membership-cancellation",
  "age-tiers",
  "seasons-rates",
  "stripe",
  "email-ses",
  "sentry",
  "address-autocomplete",
  "xero-operational",
  "finance-dashboard",
  "xero-mappings",
];

function moduleFlags(
  overrides: Partial<ModuleSettingsValues> = {},
): ModuleSettingsValues {
  const allEnabled = Object.fromEntries(
    MODULE_KEYS.map((key) => [key, true]),
  ) as ModuleSettingsValues;
  return { ...allEnabled, ...overrides };
}

function databaseSnapshot(
  adminModuleSettings: ModuleSettingsValues,
): SetupDatabaseSnapshot {
  return {
    adminCount: 1,
    adminModuleSettings,
    ageTierSettingCount: 4,
    seasonCount: 2,
    cancellationPolicyCount: 1,
    bookingDefaultsConfigured: true,
    groupDiscountConfigured: true,
    membershipCancellationSettingsConfigured: true,
    membershipCancellationXeroGroupCount: 1,
    membershipCancellationArchiveContacts: true,
    operationalXeroConnected: true,
    operationalXeroTokenExpiresAt: "2026-09-01T00:00:00.000Z",
    xeroAccountMappingCount: 1,
    xeroHutFeeItemMappingCount: 1,
    xeroEntranceFeeMappingCount: 1,
  };
}

function stepIdsOnTheCards(
  database: SetupDatabaseSnapshot | undefined,
  progress?: Partial<SetupProgressState> | null,
) {
  return buildSetupReadiness({
    env: {},
    // Deliberately absent: the club-config check reports on a missing config
    // rather than throwing, and no step's PRESENCE depends on the file.
    configDir: "/nonexistent-setup-step-registry-fixture",
    database,
    progress,
  });
}

describe("setup step registry", () => {
  it("derives SETUP_STEP_IDS as today's 17 ids in today's order", () => {
    expect([...SETUP_STEP_IDS]).toEqual(EXPECTED_STEP_IDS);
  });

  it("derives every id positionally from its declaration", () => {
    // Covers the one unchecked step in the derivation: `map` cannot return a
    // tuple, so the arity is asserted in the registry.
    expect([...SETUP_STEP_IDS]).toEqual(
      SETUP_STEP_DEFINITIONS.map((definition) => definition.id),
    );
    expect(SETUP_STEP_IDS).toHaveLength(SETUP_STEP_DEFINITIONS.length);
  });

  it("gives every step an owning module id or `core`", () => {
    const owners = new Set<string>([...MODULE_KEYS, "core"]);
    for (const entry of SETUP_STEP_REGISTRY) {
      expect(owners.has(entry.ownerModule)).toBe(true);
    }
  });

  it("gives every step a possibly-empty prerequisite list", () => {
    for (const entry of SETUP_STEP_REGISTRY) {
      expect(Array.isArray(entry.prerequisites)).toBe(true);
    }
  });

  it("declares no prerequisites today", () => {
    // Epic #213 open question 1: the current 17 steps are independent, and the
    // journey's ordering is editorial. If a future step needs a real
    // prerequisite, change this expectation deliberately — do not let one
    // arrive by accident, because D2 makes a prerequisite block navigation.
    const withPrerequisites = SETUP_STEP_REGISTRY.filter(
      (entry) => entry.prerequisites.length > 0,
    ).map((entry) => entry.id);
    expect(withPrerequisites).toEqual([]);
  });

  it("has no registry violations", () => {
    // This assertion IS the build failure for a bad declaration.
    expect(findSetupStepRegistryViolations(SETUP_STEP_DEFINITIONS)).toEqual([]);
  });
});

describe("setup step registry — the readiness cards are unchanged", () => {
  it("shows exactly the registry's steps, in registry order, with every module enabled", () => {
    const readiness = stepIdsOnTheCards(databaseSnapshot(moduleFlags()));
    const displayed = readiness.categories.flatMap((category) =>
      category.checks.map((check) => check.id),
    );

    expect(displayed).toEqual(EXPECTED_STEP_IDS);
    expect(readiness.summary.total).toBe(EXPECTED_STEP_IDS.length);
  });

  it("still shows every step when a module is disabled, because nothing is wired yet", () => {
    // C1 is the substrate: applicability is computed and tested, and NOTHING
    // consumes it. The card behaviour change lands with C8. If this test starts
    // failing, that wiring arrived early and D4's removal rules need reviewing
    // with it rather than being discovered in production.
    const readiness = stepIdsOnTheCards(
      databaseSnapshot(
        moduleFlags({
          xeroIntegration: false,
          financeDashboard: false,
          addressAutocomplete: false,
        }),
      ),
    );
    const displayed = readiness.categories.flatMap((category) =>
      category.checks.map((check) => check.id),
    );

    expect(displayed).toEqual(EXPECTED_STEP_IDS);
  });
});

describe("setup step applicability", () => {
  it("includes every step when every module is enabled", () => {
    expect(getApplicableSetupStepIds(moduleFlags())).toEqual(EXPECTED_STEP_IDS);
  });

  it("excludes a step whose owning module is disabled", () => {
    const applicable = getApplicableSetupStepIds(
      moduleFlags({ xeroIntegration: false }),
    );

    expect(applicable).not.toContain("xero-operational");
    expect(applicable).not.toContain("xero-mappings");
    // The finance dashboard is its own module and is unaffected by Xero's flag.
    expect(applicable).toContain("finance-dashboard");
  });

  it("keeps every core step when every module is disabled", () => {
    const allOff = Object.fromEntries(
      MODULE_KEYS.map((key) => [key, false]),
    ) as ModuleSettingsValues;
    const applicable = getApplicableSetupStepIds(allOff);
    const coreIds = SETUP_STEP_REGISTRY.filter(
      (entry) => entry.ownerModule === "core",
    ).map((entry) => entry.id);

    expect(applicable).toEqual(coreIds);
    expect(applicable).toContain("feature-flags");
  });

  it("treats an unsaved Modules page as the first-install defaults", () => {
    // Mirrors buildModuleLayerState: no row (or no snapshot) resolves to
    // DEFAULT_MODULE_SETTINGS, where the four module-owned steps' modules are
    // all OFF.
    expect(getApplicableSetupStepIds(null)).toEqual(
      getApplicableSetupStepIds(
        moduleFlags({
          xeroIntegration: false,
          financeDashboard: false,
          addressAutocomplete: false,
        }),
      ),
    );
    expect(getApplicableSetupStepIds(undefined)).toEqual(
      getApplicableSetupStepIds(null),
    );
  });

  it("returns applicable steps in presentation order", () => {
    const applicable = getApplicableSetupStepIds(
      moduleFlags({ addressAutocomplete: false }),
    );
    const expectedOrder = EXPECTED_STEP_IDS.filter(
      (id) => id !== "address-autocomplete",
    );

    expect(applicable).toEqual(expectedOrder);
  });
});

describe("setup step completion", () => {
  it("agrees with the readiness summary's own complete count", () => {
    // The behavioural pin between `isSetupStepComplete` and the rule
    // buildSetupReadiness applies, which the registry cannot import without a
    // cycle. A mixed scenario: some checks pass on their own, one is marked
    // done by the operator, one is deferred.
    const readiness = stepIdsOnTheCards(databaseSnapshot(moduleFlags()), {
      completedStepIds: ["runtime-env"],
      skippedStepIds: ["sentry"],
    });
    const entriesById = new Map(
      SETUP_STEP_REGISTRY.map((entry) => [entry.id, entry]),
    );

    const complete = readiness.categories
      .flatMap((category) => category.checks)
      .filter((check) => {
        const entry = entriesById.get(check.id);
        if (!entry) throw new Error(`No registry entry for check ${check.id}`);
        return isSetupStepComplete(entry, {
          status: check.status,
          progress: check.progress,
        });
      }).length;

    expect(complete).toBe(readiness.summary.complete);
  });

  it("does not treat a deferred step as complete", () => {
    const entry = SETUP_STEP_REGISTRY[0];

    expect(
      isSetupStepComplete(entry, { status: "warning", progress: "skipped" }),
    ).toBe(false);
    expect(
      isSetupStepComplete(entry, { status: "warning", progress: "completed" }),
    ).toBe(true);
    expect(
      isSetupStepComplete(entry, { status: "complete", progress: "open" }),
    ).toBe(true);
  });
});

describe("setup step registry guards", () => {
  const stepDefinition = (
    id: string,
    overrides: Partial<SetupStepDefinition> = {},
  ): SetupStepDefinition => ({
    id,
    ownerModule: "core",
    prerequisites: [],
    order: 10,
    completion: "readiness-check",
    ...overrides,
  });

  it("names the step and the id when a prerequisite does not exist", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("club-config"),
      stepDefinition("seed-admin", {
        order: 20,
        prerequisites: ["not-a-real-step"],
      }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("seed-admin");
    expect(violations[0]).toContain("not-a-real-step");
  });

  it("names every step in a prerequisite cycle", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("a", { prerequisites: ["c"] }),
      stepDefinition("b", { order: 20, prerequisites: ["a"] }),
      stepDefinition("c", { order: 30, prerequisites: ["b"] }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("a");
    expect(violations[0]).toContain("b");
    expect(violations[0]).toContain("c");
  });

  it("names a step that is its own prerequisite", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("club-config", { prerequisites: ["club-config"] }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("cycle");
    expect(violations[0]).toContain("club-config");
  });

  it("reports one cycle once however many steps lead into it", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("entry-one", { prerequisites: ["a"] }),
      stepDefinition("entry-two", { order: 20, prerequisites: ["b"] }),
      stepDefinition("a", { order: 30, prerequisites: ["b"] }),
      stepDefinition("b", { order: 40, prerequisites: ["a"] }),
    ]);

    expect(violations).toHaveLength(1);
  });

  it("names a duplicated step id", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("club-config"),
      stepDefinition("club-config", { order: 20 }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("club-config");
  });

  it("names both steps when declaration order and `order` disagree", () => {
    // Load-bearing because SETUP_STEP_IDS is derived positionally: a step moved
    // by editing `order` alone would ship an order nothing actually applies.
    const violations = findSetupStepRegistryViolations([
      stepDefinition("club-config", { order: 20 }),
      stepDefinition("seed-admin", { order: 10 }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("club-config");
    expect(violations[0]).toContain("seed-admin");
  });

  it("accepts a well-formed registry with real prerequisites", () => {
    expect(
      findSetupStepRegistryViolations([
        stepDefinition("club-config"),
        stepDefinition("seed-admin", {
          order: 20,
          prerequisites: ["club-config"],
        }),
      ]),
    ).toEqual([]);
  });
});
