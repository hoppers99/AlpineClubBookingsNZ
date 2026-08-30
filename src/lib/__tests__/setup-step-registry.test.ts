import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
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
  resolveSetupStepCompletion,
  type SetupStepDefinition,
  type SetupStepId,
  type SetupStepOwner,
} from "@/lib/setup-step-registry";
import { SETUP_STEP_DEFINITIONS } from "@/lib/setup-step-registry-definitions";

/**
 * The C1 contract tests (epic #213). "The build fails" in this repository means
 * a test in the `verify` job fails, so the registry guards are asserted here
 * rather than thrown at module load — a malformed declaration should redden CI,
 * not crash a running club's admin pages.
 */

// The step set as it stood when the registry replaced the hand-maintained array
// (17 ids, `club-time-zone` added upstream by #2989), plus `environment-role`,
// which upstream added as an eighteenth id — positioned THIRD — while this epic
// was in flight (ENV-SAFETY 1, #3034), plus `site-style`, this epic's own
// nineteenth id (C7, #222) — positioned between `seasons-rates` and `stripe`,
// matching where the epic's mockups placed the styling step in the journey, plus
// `lodges`, this epic's twentieth (C6, #221) — positioned between
// `feature-flags` and `booking-policies`, ahead of the rules that are rules
// about the buildings.
// Written out rather than derived: a pin that recomputes itself from the thing
// it is pinning proves nothing. C1 must not change what the readiness cards
// show, so a diff here is either a deliberate journey change or the regression
// this test exists to catch.
const EXPECTED_STEP_IDS = [
  "club-config",
  "club-time-zone",
  "environment-role",
  "runtime-env",
  "auth-secret-strength",
  "seed-admin",
  "feature-flags",
  "lodges",
  "booking-policies",
  "membership-cancellation",
  "age-tiers",
  "seasons-rates",
  "site-style",
  "stripe",
  "email-ses",
  "sentry",
  "address-autocomplete",
  "xero-operational",
  "finance-dashboard",
  "xero-mappings",
];

/*
  THE D17 CLASSIFICATION, WRITTEN OUT (#246) — the single literal home for
  "which entries are deployment facts". `setup-wizard-traversal.test.ts` derives
  its operator list from the registry on purpose and points here, so this is the
  one place a reclassification has to be typed by a person.

  Written out for the same reason `EXPECTED_STEP_IDS` above is: a pin that
  recomputes itself from the thing it pins proves nothing. Moving a step across
  this line changes what the wizard walks, what the percentage divides by, and —
  for the three gating ones — whether a club can publish its public site, so it
  is exactly the kind of change that must be deliberate rather than incidental.
*/
const EXPECTED_ENVIRONMENT_STEP_IDS = [
  "environment-role",
  "runtime-env",
  "auth-secret-strength",
  "email-ses",
  "sentry",
];

// The three of those five that hold the publish button shut while their check
// is not `complete` (`launchGate: "blocks-until-complete"`). Email transport
// and Sentry are amber-only: a club with no error reporting is not a club that
// must not open.
const EXPECTED_LAUNCH_GATING_STEP_IDS = [
  "environment-role",
  "runtime-env",
  "auth-secret-strength",
];

// The steps the registry considers applicable to a club on the FIRST-INSTALL
// defaults — the state every new club is actually in, where xeroIntegration,
// financeDashboard and addressAutocomplete are all off. Written out for the
// same reason as the list above. `environment-role`, `site-style` and `lodges`
// are all `core` — no module flag governs any of them; ADR-005 made lodge
// management core outright — so all three are applicable under the defaults like
// every other `core` step, and the divergence list below is unchanged at four
// module-owned ids.
const DEFAULT_INSTALL_APPLICABLE_STEP_IDS = [
  "club-config",
  "club-time-zone",
  "environment-role",
  "runtime-env",
  "auth-secret-strength",
  "seed-admin",
  "feature-flags",
  "lodges",
  "booking-policies",
  "membership-cancellation",
  "age-tiers",
  "seasons-rates",
  "site-style",
  "stripe",
  "email-ses",
  "sentry",
];

// The four module-owned steps a default install does not get. C1 left this gap
// OPEN on purpose — nothing consumed applicability, so the cards showed all
// twenty — and C8 (#223) CLOSED it: the cards now derive their set from
// `getApplicableSetupStepIds`, so these four are absent from a default
// install's cards exactly as they are absent from its wizard rail. The name is
// kept as the historical record of what the gap was.
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
  it("derives SETUP_STEP_IDS as today's 20 ids in today's order", () => {
    expect([...SETUP_STEP_IDS]).toEqual(EXPECTED_STEP_IDS);
  });

  it("classifies every step, and this is the list (D17, #246)", () => {
    expect(
      SETUP_STEP_REGISTRY.filter((entry) => entry.kind === "environment").map(
        (entry) => entry.id,
      ),
    ).toEqual(EXPECTED_ENVIRONMENT_STEP_IDS);
    // The other fifteen, by construction rather than by a second list: the two
    // halves must partition the registry, so a step that somehow declared
    // neither kind would fail here as well as failing the typecheck.
    expect(
      SETUP_STEP_REGISTRY.filter((entry) => entry.kind === "operator").length +
        EXPECTED_ENVIRONMENT_STEP_IDS.length,
    ).toBe(SETUP_STEP_IDS.length);
  });

  it("lets exactly three environment facts hold publish shut (D17, #246)", () => {
    expect(
      SETUP_STEP_REGISTRY.filter(
        (entry) => entry.launchGate === "blocks-until-complete",
      ).map((entry) => entry.id),
    ).toEqual(EXPECTED_LAUNCH_GATING_STEP_IDS);
  });

  it("keeps the shipped registry free of every violation, including D17's", () => {
    // The contract test the guards exist for. Named again here because D17
    // (#246) added two: an environment fact may not sit on either end of a
    // prerequisite edge, and an operator step may not claim to gate launch.
    expect(findSetupStepRegistryViolations(SETUP_STEP_REGISTRY)).toEqual([]);
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
    // Epic #213 open question 1: the current 20 steps are independent, and the
    // journey's ordering is editorial. If a future step needs a real
    // prerequisite, change this expectation deliberately — do not let one
    // arrive by accident, because D2 makes a prerequisite block navigation.
    const withPrerequisites = SETUP_STEP_REGISTRY.filter(
      (entry) => entry.prerequisites.length > 0,
    ).map((entry) => entry.id);
    expect(withPrerequisites).toEqual([]);
  });

  it("has no registry violations", () => {
    // This assertion IS the build failure for a bad declaration. Checked
    // against SETUP_STEP_REGISTRY (the shipped export), not the raw
    // definitions array, so this test also covers C3's assembly seam — a
    // module-contributed step spliced in after the definitions array is
    // built stays under this guard.
    expect(findSetupStepRegistryViolations(SETUP_STEP_REGISTRY)).toEqual([]);
  });

  it("pins the exact ownerModule for all 20 registered steps", () => {
    // A single source of truth, deliberately NOT derived from the registry
    // itself: re-owning a `core` step to a default-ON module would still
    // typecheck and pass every other test here (`getApplicableSetupStepIds`
    // just reads whatever `ownerModule` says), so only a hand-written map
    // pins today's ownership and turns a silent re-owning into a visible
    // diff.
    const expectedOwnerModuleById: Record<SetupStepId, SetupStepOwner> = {
      "club-config": CORE_STEP_OWNER,
      "club-time-zone": CORE_STEP_OWNER,
      "environment-role": CORE_STEP_OWNER,
      "runtime-env": CORE_STEP_OWNER,
      "auth-secret-strength": CORE_STEP_OWNER,
      "seed-admin": CORE_STEP_OWNER,
      "feature-flags": CORE_STEP_OWNER,
      lodges: CORE_STEP_OWNER,
      "booking-policies": CORE_STEP_OWNER,
      "membership-cancellation": CORE_STEP_OWNER,
      "age-tiers": CORE_STEP_OWNER,
      "seasons-rates": CORE_STEP_OWNER,
      "site-style": CORE_STEP_OWNER,
      stripe: CORE_STEP_OWNER,
      "email-ses": CORE_STEP_OWNER,
      sentry: CORE_STEP_OWNER,
      "address-autocomplete": "addressAutocomplete",
      "xero-operational": "xeroIntegration",
      "finance-dashboard": "financeDashboard",
      "xero-mappings": "xeroIntegration",
    };

    expect(Object.keys(expectedOwnerModuleById)).toHaveLength(20);

    const actualOwnerModuleById = Object.fromEntries(
      SETUP_STEP_REGISTRY.map((entry) => [entry.id, entry.ownerModule]),
    );
    expect(actualOwnerModuleById).toEqual(expectedOwnerModuleById);
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

describe("setup step registry — the readiness cards ARE the applicable set (C8, #223)", () => {
  it("shows exactly the registry's steps, in registry order, with every module enabled", () => {
    const readiness = stepIdsOnTheCards(databaseSnapshot(moduleFlags()));
    const displayed = readiness.categories.flatMap((category) =>
      category.checks.map((check) => check.id),
    );

    expect(displayed).toEqual(EXPECTED_STEP_IDS);
    expect(readiness.summary.total).toBe(EXPECTED_STEP_IDS.length);
  });

  it("shows a first-install club only its applicable steps, not all 20", () => {
    // The C1→C8 hand-over, closed. C1's version of this test asserted the
    // OPPOSITE — all twenty ids, with the four module-owned ones named as a
    // deliberate, inert gap "so C8 must change it on purpose". This is that
    // change: a default install has xeroIntegration, financeDashboard and
    // addressAutocomplete off, and the cards now derive from the registry.
    const readiness = stepIdsOnTheCards(
      databaseSnapshot(DEFAULT_MODULE_SETTINGS),
    );
    const displayed = readiness.categories.flatMap((category) =>
      category.checks.map((check) => check.id),
    );

    expect(displayed).toEqual(DEFAULT_INSTALL_APPLICABLE_STEP_IDS);
    expect(readiness.summary.total).toBe(
      DEFAULT_INSTALL_APPLICABLE_STEP_IDS.length,
    );
    const displayedIds = new Set<string>(displayed);
    expect(
      STEPS_SHOWN_BUT_NOT_APPLICABLE_BY_DEFAULT.filter((id) =>
        displayedIds.has(id),
      ),
    ).toEqual([]);
  });

  it("drops exactly the disabled module's steps, and no others (D4)", () => {
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

    expect(displayed).toEqual(DEFAULT_INSTALL_APPLICABLE_STEP_IDS);
  });

  it("FAILS OPEN and shows all 20 when module state is unknown", () => {
    // The three-state contract's most important case, and the one a `?? null`
    // in `buildSetupReadiness` would silently break: a DB-less
    // `npm run setup:check` takes no snapshot at all, and hiding setup work on
    // the one run that could not read the club's configuration is the wrong
    // direction to be wrong in.
    const readiness = stepIdsOnTheCards(undefined);
    const displayed = readiness.categories.flatMap((category) =>
      category.checks.map((check) => check.id),
    );

    expect(displayed).toEqual(EXPECTED_STEP_IDS);
  });

  it("drops a category whose every step belongs to a disabled module", () => {
    // `finance` holds `finance-dashboard` and `xero-mappings`, both
    // module-owned, so a first-install club has no finance category at all —
    // rather than an empty one, which `worstStatus([])` would report as
    // "complete" and read as "this is done" instead of "this does not apply".
    const readiness = stepIdsOnTheCards(
      databaseSnapshot(DEFAULT_MODULE_SETTINGS),
    );

    expect(readiness.categories.map((category) => category.id)).not.toContain(
      "finance",
    );
    expect(
      readiness.categories.every((category) => category.checks.length > 0),
    ).toBe(true);
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
  /*
    THE COMPLETENESS PIN, RE-DRAWN (#237) — read this before changing either
    side of it.

    It used to marry the single predicate `isSetupStepComplete` to the rule
    `buildSetupReadiness` applies for its `complete` summary figure, which the
    registry cannot import without a cycle. D14 split that predicate in two, and
    the question this file had to answer first was whether the readiness summary
    moves with it.

    IT DOES NOT, deliberately. `summary.complete` feeds `/admin/setup`'s cards
    and `npm run setup:check`, which answer "is this installation configured?" —
    and a defaulted timezone genuinely IS configured. The wizard's percentage
    answers "has the operator been through this?". D14 exists precisely to stop
    one number carrying both questions, so making the readiness figure follow the
    wizard's answer would have re-merged them one layer down.

    So the marriage survives, expressed over the new vocabulary: the readiness
    summary's `complete` count is the UNION of the two answers — the steps a
    person confirmed, PLUS the steps sitting on a passing check nobody confirmed.
    That union is exactly `status === "complete" || progress === "completed"`,
    which is the summary's own filter, so this is a real behavioural pin and not
    a restatement of the implementation.

    A consequence worth naming: `/admin/setup` and `setup:check` produce
    byte-identical output before and after #237.
  */
  it("agrees with the readiness summary's own complete count, over the UNION of both answers", () => {
    // A mixed scenario: some checks pass on their own, one is marked done by the
    // operator, and one — "xero-mappings", which the `databaseSnapshot` fixture
    // above already makes status "complete" — is ALSO deferred, so the fixture
    // exercises status "complete" together with progress "skipped" and not only
    // the warning-plus-skipped case.
    const readiness = stepIdsOnTheCards(databaseSnapshot(moduleFlags()), {
      completedStepIds: ["runtime-env"],
      skippedStepIds: ["xero-mappings"],
    });
    const entriesById = new Map(
      SETUP_STEP_REGISTRY.map((entry) => [entry.id, entry]),
    );

    const answers = readiness.categories
      .flatMap((category) => category.checks)
      .map((check) => {
        const entry = entriesById.get(check.id);
        if (!entry) throw new Error(`No registry entry for check ${check.id}`);
        return resolveSetupStepCompletion(entry, {
          status: check.status,
          progress: check.progress,
        });
      });

    const union = answers.filter(
      (answer) => answer.derivedSatisfied || answer.operatorConfirmed,
    ).length;
    expect(union).toBe(readiness.summary.complete);

    // …and the fixture really does exercise BOTH halves, so the assertion above
    // cannot pass by one of them being empty. Without this, a bug that collapsed
    // both answers onto `status` would still satisfy the union.
    expect(answers.some((answer) => answer.operatorConfirmed)).toBe(true);
    expect(answers.some((answer) => answer.derivedSatisfied)).toBe(true);
    expect(
      answers.some(
        (answer) => answer.derivedSatisfied && !answer.operatorConfirmed,
      ),
      "the fixture holds a DEFAULTED step — derived but unconfirmed",
    ).toBe(true);
  });

  it("keeps a passing check and an operator's record as separate answers (D14)", () => {
    const entry = SETUP_STEP_REGISTRY[0];
    const answer = (
      status: "complete" | "warning",
      progress: "open" | "completed" | "skipped",
    ) => resolveSetupStepCompletion(entry, { status, progress });

    // The check passes and nobody said so: DEFAULTED. This is the case the old
    // single predicate answered `true` to, and answering it `true` is what made
    // a fresh seed open the wizard 56% of the way through.
    expect(answer("complete", "open")).toEqual({
      derivedSatisfied: true,
      operatorConfirmed: false,
    });

    // The operator marked it done while the check still fails: CONFIRMED, and
    // that is the one the percentage counts.
    expect(answer("warning", "completed")).toEqual({
      derivedSatisfied: false,
      operatorConfirmed: true,
    });

    // Both, which is the ordinary end state of a step somebody worked through.
    expect(answer("complete", "completed")).toEqual({
      derivedSatisfied: true,
      operatorConfirmed: true,
    });

    // Skipping is NEITHER answer. It buys passage (D4) and confirms nothing.
    expect(answer("warning", "skipped")).toEqual({
      derivedSatisfied: false,
      operatorConfirmed: false,
    });
    // …and it does not un-say a passing check either.
    expect(answer("complete", "skipped")).toEqual({
      derivedSatisfied: true,
      operatorConfirmed: false,
    });
  });
});

describe("setup step registry guards", () => {
  const stepDefinition = (
    id: string,
    overrides: Partial<SetupStepDefinition> = {},
  ): SetupStepDefinition => ({
    id,
    ownerModule: CORE_STEP_OWNER,
    kind: "operator",
    launchGate: "none",
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

  // A genuine cycle cannot avoid the forward-prerequisite guard below: `order`
  // is a total order over the steps, and going around a cycle would require
  // it to strictly decrease at every hop, which is impossible in a finite
  // loop — so at least one edge in any cycle is ALSO a forward reference by
  // construction. These fixtures therefore trip both guards at once; each
  // test filters to the cycle-specific message(s) so it keeps verifying only
  // what its name says, and the forward-reference co-violation itself is
  // covered by the dedicated fixtures below.
  const cycleViolations = (violations: string[]) =>
    violations.filter((violation) => violation.includes("cycle"));

  it("names every step in a prerequisite cycle", () => {
    const violations = cycleViolations(
      findSetupStepRegistryViolations([
        stepDefinition("a", { prerequisites: ["c"] }),
        stepDefinition("b", { order: 20, prerequisites: ["a"] }),
        stepDefinition("c", { order: 30, prerequisites: ["b"] }),
      ]),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("a");
    expect(violations[0]).toContain("b");
    expect(violations[0]).toContain("c");
  });

  it("names a step that is its own prerequisite", () => {
    const violations = cycleViolations(
      findSetupStepRegistryViolations([
        stepDefinition("club-config", { prerequisites: ["club-config"] }),
      ]),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("cycle");
    expect(violations[0]).toContain("club-config");
  });

  it("reports one cycle once however many steps lead into it", () => {
    const violations = cycleViolations(
      findSetupStepRegistryViolations([
        stepDefinition("entry-one", { prerequisites: ["a"] }),
        stepDefinition("entry-two", { order: 20, prerequisites: ["b"] }),
        stepDefinition("a", { order: 30, prerequisites: ["b"] }),
        stepDefinition("b", { order: 40, prerequisites: ["a"] }),
      ]),
    );

    expect(violations).toHaveLength(1);
  });

  it("names every step in a three-member cycle sharing an out-edge", () => {
    // Reproducer 1 from the C1 review round: a -> [b, c], b -> [c], c -> [a].
    // All three are mutually reachable (a -> c -> a directly, and a -> b -> c
    // -> a through b), so they form one three-member SCC.
    const violations = cycleViolations(
      findSetupStepRegistryViolations([
        stepDefinition("a", { prerequisites: ["b", "c"] }),
        stepDefinition("b", { order: 20, prerequisites: ["c"] }),
        stepDefinition("c", { order: 30, prerequisites: ["a"] }),
      ]),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("a");
    expect(violations[0]).toContain("b");
    expect(violations[0]).toContain("c");
  });

  it("names every step in a cycle a settled-early-return DFS would drop one from", () => {
    // Reproducer 2 from the C1 review round: s0 -> [s1, s2], s1 -> [s0],
    // s2 -> [s1]. This is the shape that broke the old settled/on-path DFS: it
    // visits s0, then s1 (which closes a cycle back to s0 and is then marked
    // SETTLED), then reaches s2 — whose only prerequisite is the now-settled
    // s1 — and stops there without ever re-opening s1's cycle through s2. s0,
    // s1 and s2 are mutually reachable (s0 -> s2 -> s1 -> s0), so this is one
    // three-member SCC and s2 MUST appear in the reported message.
    const violations = cycleViolations(
      findSetupStepRegistryViolations([
        stepDefinition("s0", { prerequisites: ["s1", "s2"] }),
        stepDefinition("s1", { order: 20, prerequisites: ["s0"] }),
        stepDefinition("s2", { order: 30, prerequisites: ["s1"] }),
      ]),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("s0");
    expect(violations[0]).toContain("s1");
    expect(violations[0]).toContain("s2");
  });

  it("flags a prerequisite presented after its dependent", () => {
    // seed-admin (order 10) depends on club-config (order 20): under the
    // wizard's no-jumping-forward navigation (D2), an operator reaches
    // seed-admin before club-config is ever shown, so the prerequisite is
    // unreachable from where it is declared to matter.
    const violations = findSetupStepRegistryViolations([
      stepDefinition("seed-admin", { prerequisites: ["club-config"] }),
      stepDefinition("club-config", { order: 20 }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("seed-admin");
    expect(violations[0]).toContain("club-config");
    expect(violations[0]).toContain("order 10");
    expect(violations[0]).toContain("order 20");
  });

  it("does not flag a prerequisite that is genuinely presented first", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("club-config"),
      stepDefinition("seed-admin", {
        order: 20,
        prerequisites: ["club-config"],
      }),
    ]);

    expect(violations).toEqual([]);
  });

  it("flags a prerequisite whose module is neither core nor the dependent's own", () => {
    // finance-fixture (module financeDashboard) depends on
    // xero-operational-fixture (module xeroIntegration): the dependent can be
    // applicable while xeroIntegration is switched off, at which point its
    // prerequisite can never be satisfied.
    const violations = findSetupStepRegistryViolations([
      stepDefinition("xero-operational-fixture", {
        ownerModule: "xeroIntegration",
      }),
      stepDefinition("finance-fixture", {
        ownerModule: "financeDashboard",
        order: 20,
        prerequisites: ["xero-operational-fixture"],
      }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("finance-fixture");
    expect(violations[0]).toContain("xero-operational-fixture");
    expect(violations[0]).toContain("xeroIntegration");
    expect(violations[0]).toContain("financeDashboard");
  });

  it("does not flag a core prerequisite or a same-module prerequisite", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("core-fixture"),
      stepDefinition("same-module-fixture-one", {
        order: 20,
        ownerModule: "xeroIntegration",
      }),
      stepDefinition("same-module-fixture-two", {
        order: 30,
        ownerModule: "xeroIntegration",
        prerequisites: ["core-fixture", "same-module-fixture-one"],
      }),
    ]);

    expect(violations).toEqual([]);
  });

  it("flags an empty or whitespace-only step id", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition(""),
      stepDefinition("   ", { order: 20 }),
    ]);

    expect(
      violations.filter((violation) =>
        violation.includes("empty or whitespace-only"),
      ),
    ).toHaveLength(2);
  });

  it("flags a non-finite order", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("club-config", { order: Number.NaN }),
      stepDefinition("seed-admin", { order: Number.POSITIVE_INFINITY }),
    ]);

    expect(
      violations.filter((violation) => violation.includes("non-finite order")),
    ).toHaveLength(2);
  });

  it("names a duplicated step id, describing a core/core collision as the core registry rather than a module", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("club-config"),
      stepDefinition("club-config", { order: 20 }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("club-config");
    expect(violations[0]).toContain("the core registry");
    // `core` is this file's own definitions, not an entry in
    // MODULE_DEFINITIONS — the message must not call it a module.
    expect(violations[0]).not.toContain('module "core"');
  });

  it("names a duplicated step id declared by core and a module, naming both correctly", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("club-config"),
      stepDefinition("club-config", {
        ownerModule: "xeroIntegration",
        order: 20,
      }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("club-config");
    expect(violations[0]).toContain("the core registry");
    expect(violations[0]).toContain('module "xeroIntegration"');
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
    // `club-time-zone` — byte-identical to this registry's 2nd id, in a
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
    // And the real registry, which shares that id, is clean. Bound to
    // SETUP_STEP_REGISTRY (the shipped export) for the same reason as above.
    expect(findSetupStepRegistryViolations(SETUP_STEP_REGISTRY)).toEqual([]);
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

  /*
    D17's TWO GUARDS (#246). Both protect the future rather than the present —
    every prerequisite list is empty today and no operator step gates launch —
    which is exactly the cheapest moment to write them, because there is no
    existing declaration to argue about.
  */
  it("refuses an operator step that depends on an environment fact", () => {
    /*
      The trap, CORRECTED in C15's fix round (review finding F3). It is not that
      the dependent goes stale forever: `computeStaleSetupStepIds` narrows its
      entries to `kind: "operator"` before it walks prerequisites, so an
      environment prerequisite is known-but-not-applicable and that arm returns
      false. The edge is a SILENT NO-OP — the author declares an ordering, gets
      no error, and gets no ordering — which is the failure worth refusing,
      because nothing else would ever surface it.
    */
    const violations = findSetupStepRegistryViolations([
      stepDefinition("runtime-env", {
        kind: "environment",
        launchGate: "blocks-until-complete",
      }),
      stepDefinition("seed-admin", {
        order: 20,
        prerequisites: ["runtime-env"],
      }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"seed-admin"');
    expect(violations[0]).toContain("environment fact");
    // The word the message must carry is the REAL failure mode, not the one the
    // guard was first written believing in.
    expect(violations[0]).toContain("silently ignored");
    // The behaviour that word describes is asserted where the staleness pass
    // lives — "an environment prerequisite is silently ignored, not permanently
    // stale" in `setup-wizard-traversal.test.ts`.
  });

  it("refuses an environment fact that declares prerequisites", () => {
    const violations = findSetupStepRegistryViolations([
      stepDefinition("club-config"),
      stepDefinition("runtime-env", {
        order: 20,
        kind: "environment",
        prerequisites: ["club-config"],
      }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"runtime-env"');
    expect(violations[0]).toContain("no position in the journey");
  });

  it("refuses an operator step that claims to gate launch", () => {
    // D9 keeps setup-done, site-visible and environment-role separate. Whether
    // operator steps hold publish shut is `allResolved`'s question, and a step
    // answering it a second time is D14's one-number-two-meanings defect again.
    const violations = findSetupStepRegistryViolations([
      stepDefinition("club-config", { launchGate: "blocks-until-complete" }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"club-config"');
    expect(violations[0]).toContain("allResolved");
  });

  it("accepts an environment fact declared the way the real ones are", () => {
    expect(
      findSetupStepRegistryViolations([
        stepDefinition("club-config"),
        stepDefinition("runtime-env", {
          order: 20,
          kind: "environment",
          launchGate: "blocks-until-complete",
        }),
        stepDefinition("sentry", { order: 30, kind: "environment" }),
      ]),
    ).toEqual([]);
  });
});

/**
 * C3 (#218): module-contributed steps now live on `MODULE_DEFINITIONS`
 * (`src/config/modules.ts`) rather than being declared inline in
 * `setup-step-registry-definitions.ts`. This section proves the assembly is
 * behaviour-free (a generic scan of every module's declared steps agrees with
 * the shipped, hand-spliced registry — see that file's module doc for why the
 * splice itself is hand-written rather than computed) and exercises the C3
 * acceptance criteria: a cross-module id collision fails the build naming both
 * declarers, a colliding `order` is still caught by the existing
 * position-vs-order guard, and a disabled module's assembled steps — and no
 * others — leave the applicable set (D4). "Unknown module state fails open"
 * is not re-proven here: `getApplicableSetupStepIds` reads the WHOLE
 * assembled `SETUP_STEP_REGISTRY` regardless of which describe block asks, so
 * the "fails OPEN when module state is unknown" test above already covers
 * the module-owned ids in `EXPECTED_STEP_IDS` — re-asserting it here would
 * test the same code path a second time.
 */
describe("setup step registry — module-contributed assembly (C3, #218)", () => {
  const localStepDefinition = (
    id: string,
    overrides: Partial<SetupStepDefinition> = {},
  ): SetupStepDefinition => ({
    id,
    ownerModule: CORE_STEP_OWNER,
    kind: "operator",
    launchGate: "none",
    prerequisites: [],
    order: 10,
    completion: "readiness-check",
    ...overrides,
  });

  it("matches a generic scan of MODULE_DEFINITIONS: core steps plus every module's declared steps, sorted by order", () => {
    // Independent of the hand-written splice in
    // setup-step-registry-definitions.ts: this walks MODULE_KEYS/
    // MODULE_DEFINITIONS generically, the way a truly dynamic assembly would,
    // and asserts the result — the FULL entry (id, order, ownerModule,
    // prerequisites, completion) — is exactly what the shipped registry
    // contains. A module that gains a `setupSteps` entry without a matching
    // splice in the definitions file fails HERE, and so does a splice that
    // silently diverges from the module's own declaration (an extra
    // prerequisite, a changed completion source) — comparing only
    // {id, order, ownerModule} would miss that second class, since a field
    // injected at the splice point never appears on either side of a
    // narrower comparison.
    const coreEntries = SETUP_STEP_REGISTRY.filter(
      (entry) => entry.ownerModule === CORE_STEP_OWNER,
    );
    const moduleEntries = MODULE_KEYS.flatMap((key) =>
      (MODULE_DEFINITIONS[key].setupSteps ?? []).map((step) => ({
        ...step,
        ownerModule: key as SetupStepOwner,
      })),
    );
    const scanned = [...coreEntries, ...moduleEntries]
      .map((entry) => ({
        id: entry.id,
        order: entry.order,
        ownerModule: entry.ownerModule,
        prerequisites: entry.prerequisites,
        completion: entry.completion,
      }))
      .sort((a, b) => a.order - b.order);

    const shipped = SETUP_STEP_REGISTRY.map((entry) => ({
      id: entry.id,
      order: entry.order,
      ownerModule: entry.ownerModule,
      prerequisites: entry.prerequisites,
      completion: entry.completion,
    }));

    expect(
      scanned,
      "a module declared setupSteps that are not spliced into SETUP_STEP_DEFINITIONS — add the splice line in setup-step-registry-definitions.ts",
    ).toEqual(shipped);
  });

  it("fails the build when two modules declare the same step id, naming both", () => {
    const violations = findSetupStepRegistryViolations([
      localStepDefinition("shared-step", { ownerModule: "xeroIntegration" }),
      localStepDefinition("shared-step", {
        ownerModule: "financeDashboard",
        order: 20,
      }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("shared-step");
    expect(violations[0]).toContain("xeroIntegration");
    expect(violations[0]).toContain("financeDashboard");
  });

  it("still catches a module-owned step whose order collides with another step's declared position", () => {
    // The existing order-vs-position guard is generic over ownerModule — it
    // never needed a C3-specific extension — but the acceptance criterion asks
    // for a fixture proving it still fires once the colliding steps are
    // module-owned rather than both `core`.
    const violations = findSetupStepRegistryViolations([
      localStepDefinition("address-autocomplete-fixture", {
        ownerModule: "addressAutocomplete",
        order: 140,
      }),
      localStepDefinition("xero-operational-fixture", {
        ownerModule: "xeroIntegration",
        order: 140,
      }),
    ]);

    expect(
      violations.some((violation) => violation.includes("does not sort after it")),
    ).toBe(true);
  });

  it("D4: disabling one module excludes exactly its assembled steps, and no others, from the applicable set", () => {
    const applicable = getApplicableSetupStepIds(
      moduleFlags({ financeDashboard: false }),
    );

    // Set equality against every id EXCEPT the disabled module's own —
    // "and no others" is only true if nothing besides `finance-dashboard`
    // dropped out. xeroIntegration and addressAutocomplete are still on, so
    // both of xeroIntegration's assembled steps and addressAutocomplete's
    // stay in the expected set below.
    expect(applicable).toEqual(
      EXPECTED_STEP_IDS.filter((id) => id !== "finance-dashboard"),
    );
  });
});
