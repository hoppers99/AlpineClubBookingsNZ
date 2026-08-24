import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  type ModuleSettingsValues,
} from "@/config/modules";
import {
  buildSetupReadiness,
  normalizeSetupProgress,
  type SetupDatabaseSnapshot,
  type SetupProgressState,
} from "@/lib/setup-readiness";
import {
  CORE_STEP_OWNER,
  SETUP_STEP_IDS,
  SETUP_STEP_REGISTRY,
  findSetupStepRegistryViolations,
  getApplicableSetupStepIds,
  isSetupStepComplete,
  type SetupStepDefinition,
  type SetupStepId,
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

// The steps the registry considers applicable to a club on the FIRST-INSTALL
// defaults — the state every new club is actually in, where xeroIntegration,
// financeDashboard and addressAutocomplete are all off. Written out for the
// same reason as the list above.
const DEFAULT_INSTALL_APPLICABLE_STEP_IDS = [
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
];

// The four steps the cards show today but the registry would not call
// applicable on a default install. C1 leaves this gap OPEN on purpose: nothing
// consumes applicability yet, so the cards are unchanged. Closing it is C8's
// deliberate decision, and `the readiness cards are unchanged` below is what
// makes closing it early visible rather than silent.
const STEPS_SHOWN_BUT_NOT_APPLICABLE_BY_DEFAULT = [
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

/**
 * The failure this section exists for is INVISIBLE at runtime. `z.enum` accepts
 * a plain `readonly string[]` as happily as a literal tuple, so a widened
 * `SETUP_STEP_IDS` would leave the setup-progress route accepting any string as
 * a step id while every runtime assertion below still passed and the whole
 * repository still typechecked. Only the type-level assertions catch it, and
 * they are enforced by `tsc -p tsconfig.test.json` inside `npm run typecheck`.
 */
type SetupStepIdIsLiteralUnion = string extends SetupStepId ? false : true;
type SetupStepIdsIsNonEmptyTuple = typeof SETUP_STEP_IDS extends readonly [
  SetupStepId,
  ...SetupStepId[],
]
  ? true
  : false;

const setupStepIdIsLiteralUnion: SetupStepIdIsLiteralUnion = true;
const setupStepIdsIsNonEmptyTuple: SetupStepIdsIsNonEmptyTuple = true;

describe("setup step registry — the derived export is a literal tuple", () => {
  it("keeps SetupStepId a literal union rather than string", () => {
    // Always passes under a bare `vitest run`: the const it checks is already
    // typed `true` by the module-scope conditional type above, so the real
    // enforcement is `tsc -p tsconfig.test.json` inside `npm run typecheck`
    // failing to compile this file at all when the type narrows to `false`.
    expect(setupStepIdIsLiteralUnion).toBe(true);
  });

  it("keeps SETUP_STEP_IDS a non-empty readonly tuple", () => {
    // Same as above: this assertion cannot fail under `vitest run` alone — the
    // guard is `npm run typecheck` refusing to compile the file.
    expect(setupStepIdsIsNonEmptyTuple).toBe(true);
  });

  it("still validates step ids the way the setup-progress route does", () => {
    // Mirrors src/app/api/admin/setup/progress/route.ts. Runtime cover for the
    // consequence, not for the widening itself — z.enum reads the VALUES, so
    // this passes either way; the type assertions above are the real guard.
    const stepId = z.enum(SETUP_STEP_IDS);

    expect(stepId.safeParse("club-config").success).toBe(true);
    expect(stepId.safeParse("xero-mappings").success).toBe(true);
    expect(stepId.safeParse("not-a-step").success).toBe(false);
    expect(stepId.safeParse("").success).toBe(false);
  });

  it("keeps normalizeSetupProgress filtering unknown ids", () => {
    // setup-readiness.ts's normalizeStepIds builds its allowlist from
    // SETUP_STEP_IDS, so it is the other consumer that a widened export would
    // quietly change the meaning of.
    const normalised = normalizeSetupProgress({
      completedStepIds: ["club-config", "not-a-step", "club-config"],
      skippedStepIds: ["sentry", "also-not-a-step"],
      completedAt: null,
      completedByMemberId: null,
    });

    expect(normalised.completedStepIds).toEqual(["club-config"]);
    expect(normalised.skippedStepIds).toEqual(["sentry"]);
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

  it("shows all 17 steps on a first-install club, which applicability would not", () => {
    // The pin that matters for "no behaviour change": a default install has
    // three modules off, and the cards still build every check unconditionally.
    // The registry disagrees, deliberately and inertly — this test names the
    // exact gap so C8 must change it on purpose.
    const readiness = stepIdsOnTheCards(
      databaseSnapshot(DEFAULT_MODULE_SETTINGS),
    );
    const displayed = readiness.categories.flatMap((category) =>
      category.checks.map((check) => check.id),
    );

    expect(displayed).toEqual(EXPECTED_STEP_IDS);

    const applicable = getApplicableSetupStepIds(DEFAULT_MODULE_SETTINGS);
    expect(displayed.filter((id) => !applicable.includes(id))).toEqual(
      STEPS_SHOWN_BUT_NOT_APPLICABLE_BY_DEFAULT,
    );
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
      (entry) => entry.ownerModule === CORE_STEP_OWNER,
    ).map((entry) => entry.id);

    expect(applicable).toEqual(coreIds);
    expect(applicable).toContain("feature-flags");
  });

  it("pins the applicable set under the first-install defaults", () => {
    // The state a real club is actually in. `moduleFlags()` above is every
    // module ON, which no club is by default: DEFAULT_MODULE_SETTINGS has
    // xeroIntegration, financeDashboard and addressAutocomplete OFF. Pinning
    // only the all-enabled set would let the default-install set change without
    // a test noticing.
    expect(getApplicableSetupStepIds(DEFAULT_MODULE_SETTINGS)).toEqual(
      DEFAULT_INSTALL_APPLICABLE_STEP_IDS,
    );
  });

  it("treats an unsaved Modules page as the first-install defaults", () => {
    // `null` is a KNOWN answer — the ClubModuleSettings row does not exist —
    // which is how buildModuleLayerState and formatModuleActivationDetail
    // already read it ("first-install defaults until settings are saved").
    expect(getApplicableSetupStepIds(null)).toEqual(
      DEFAULT_INSTALL_APPLICABLE_STEP_IDS,
    );
  });

  it("fails OPEN when module state is unknown", () => {
    // `undefined` is NOT the same as `null`: no snapshot was taken at all (a
    // DB-less `npm run setup:check` passes none). Hiding a step on the one run
    // that could not read the club's configuration is the wrong direction to be
    // wrong in, so every step comes back.
    expect(getApplicableSetupStepIds(undefined)).toEqual(EXPECTED_STEP_IDS);
    expect(getApplicableSetupStepIds()).toEqual(EXPECTED_STEP_IDS);
    expect(getApplicableSetupStepIds(undefined)).not.toEqual(
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
    // done by the operator, and one — "xero-mappings", which the
    // `databaseSnapshot` fixture above already makes status "complete" — is
    // ALSO deferred, so the fixture exercises status "complete" together with
    // progress "skipped" and not only the warning-plus-skipped case.
    const readiness = stepIdsOnTheCards(databaseSnapshot(moduleFlags()), {
      completedStepIds: ["runtime-env"],
      skippedStepIds: ["xero-mappings"],
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
    ownerModule: CORE_STEP_OWNER,
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

  it("is scoped to the registry it is given, and consults no other", () => {
    // `config-self-heal-steps.ts` declares a self-heal step named
    // `club-time-zone` — byte-identical to this registry's 17th id, in a
    // different namespace, and entirely unrelated. Ids are namespaced by their
    // registry, so a guard that reached across namespaces would fail the build
    // over two files that never meet.
    const selfHealStepNames = ["club-time-zone", "club-identity-settings"];

    expect(
      findSetupStepRegistryViolations(
        selfHealStepNames.map((name, index) =>
          stepDefinition(name, { order: (index + 1) * 10 }),
        ),
      ),
    ).toEqual([]);
    // And the real registry, which shares that id, is clean.
    expect(findSetupStepRegistryViolations(SETUP_STEP_DEFINITIONS)).toEqual([]);
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
