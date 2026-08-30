import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  type ModuleSettingsValues,
} from "@/config/modules";
import {
  CORE_STEP_OWNER,
  SETUP_STEP_IDS,
  SETUP_STEP_REGISTRY,
  findSetupStepRegistryViolations,
  getApplicableSetupStepIds,
  type SetupStepId,
  type SetupStepKind,
  type SetupStepLaunchGate,
  type SetupStepOwner,
} from "@/lib/setup-step-registry";
import type {
  SetupStepDefinitionOf,
  SetupWizardTraversalProgress,
} from "@/lib/setup-wizard-entries";
import {
  buildSetupWizardTraversal,
  canNavigateToSetupStep,
  deriveStaleSetupStepIds,
  type SetupWizardStepState,
  type SetupWizardTraversalInput,
} from "@/lib/setup-wizard-traversal";

/**
 * The C4 traversal contract (epic #213, issue #219).
 *
 * Two halves, and the split is the point. The REAL registry declares no
 * prerequisites at all — deliberately, and `setup-step-registry-definitions.ts`
 * explains why — so it cannot exercise a single staleness or invalidation rule.
 * Those are tested against SYNTHETIC registries, exactly as C1 tests its guards
 * against synthetic malformed ones. The real registry is then pinned for the
 * things it CAN prove: that applicability agrees with C1's own function, and
 * that it yields no stale steps for any progress record a club could have.
 *
 * Every synthetic registry used to test a NAVIGATION rule is first asserted
 * valid under `findSetupStepRegistryViolations`, so no rule is verified against
 * a registry the build would reject. The three deliberately-invalid ones are in
 * their own describe block and say so.
 */

type Spec = {
  readonly id: string;
  readonly ownerModule?: SetupStepOwner;
  readonly prerequisites?: readonly string[];
  /**
   * D17 (#246). Defaults to `"operator"` HERE and only here: every navigation
   * rule in this file is about the journey, and the journey is operator steps,
   * so a fixture that had to spell that out on every entry would bury the rule
   * each test is actually about. The REGISTRY's own field is required precisely
   * so that no real declaration gets this default — see `SetupStepKind`.
   */
  readonly kind?: SetupStepKind;
  readonly launchGate?: SetupStepLaunchGate;
};

/** Orders are positional, so a registry declared here always satisfies C1's sort rule. */
function syntheticRegistry(
  specs: readonly Spec[],
): readonly SetupStepDefinitionOf<string>[] {
  return specs.map((spec, index) => ({
    id: spec.id,
    ownerModule: spec.ownerModule ?? CORE_STEP_OWNER,
    kind: spec.kind ?? "operator",
    launchGate: spec.launchGate ?? "none",
    prerequisites: spec.prerequisites ?? [],
    order: (index + 1) * 10,
    completion: "readiness-check" as const,
  }));
}

function linear(...ids: readonly string[]) {
  return syntheticRegistry(ids.map((id) => ({ id })));
}

/**
 * The real registry's OPERATOR steps, in journey order — what the wizard walks
 * since D17 (#246), as against `SETUP_STEP_IDS`, which is still every applicable
 * entry and is what the readiness cards walk.
 *
 * DERIVED here rather than written out, deliberately, and the LITERAL pin lives
 * in `setup-step-registry.test.ts` ("classifies every step, and this is the
 * list"). Two literal copies of the classification would be two things to keep
 * in step; and this file's subject is the journey's BEHAVIOUR — that the walk
 * is the operator half, whatever that half turns out to be — not which entries
 * are in it. Reclassify a step and the registry suite fails by name, which is
 * where a reader looking for "who decided this" should land.
 */
const OPERATOR_STEP_IDS = SETUP_STEP_REGISTRY.filter(
  (entry) => entry.kind === "operator",
).map((entry) => entry.id);

const ENVIRONMENT_STEP_IDS = SETUP_STEP_REGISTRY.filter(
  (entry) => entry.kind === "environment",
).map((entry) => entry.id);

function progressOf(
  completedStepIds: readonly string[] = [],
  skippedStepIds: readonly string[] = [],
): SetupWizardTraversalProgress {
  return { completedStepIds, skippedStepIds };
}

/**
 * The traversal over a synthetic registry, with module state UNKNOWN by default
 * so applicability never quietly removes a step a navigation test is about.
 *
 * `registry` is required here (F8): `buildSetupWizardTraversal`'s overloads
 * make it required for any Id other than the real `SetupStepId`, and every
 * call site in this file already supplies one.
 */
function traverse(
  input: Omit<SetupWizardTraversalInput<string>, "progress" | "registry"> & {
    readonly registry: readonly SetupStepDefinitionOf<string>[];
    progress?: SetupWizardTraversalProgress;
  },
) {
  return buildSetupWizardTraversal<string>({
    progress: progressOf(),
    ...input,
  });
}

function stateOf(
  traversal: ReturnType<typeof traverse>,
  id: string,
): SetupWizardStepState | undefined {
  return traversal.steps.find((step) => step.id === id)?.state;
}

function reachableIds(traversal: ReturnType<typeof traverse>): string[] {
  return traversal.steps.filter((step) => step.isReachable).map((step) => step.id);
}

const ALL_MODULES_ON: ModuleSettingsValues = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as ModuleSettingsValues;

describe("setup wizard traversal: applicability agrees with C1 (#219)", () => {
  // The applicability rule is restated in the traversal layer because
  // `getApplicableSetupStepIds` cannot take a synthetic registry. That
  // restatement is only safe while the two agree, so this is the anti-drift
  // guard, run over every module-flag shape that reaches production.
  const moduleSettingsCases: [string, ModuleSettingsValues | null | undefined][] = [
    ["unknown module state (undefined)", undefined],
    ["first-install defaults (null)", null],
    ["every module on", ALL_MODULES_ON],
    ["saved defaults record", { ...DEFAULT_MODULE_SETTINGS }],
    ...MODULE_KEYS.map(
      (key): [string, ModuleSettingsValues] => [
        `every module on except ${key}`,
        { ...ALL_MODULES_ON, [key]: false },
      ],
    ),
  ];

  it.each(moduleSettingsCases)(
    "matches getApplicableSetupStepIds for %s",
    (_label, moduleSettings) => {
      const traversal = buildSetupWizardTraversal({
        progress: progressOf(),
        moduleSettings,
      });
      expect(traversal.applicableStepIds).toEqual(
        getApplicableSetupStepIds(moduleSettings),
      );
    },
  );

  it("keeps the registry's declaration order and never re-sorts", () => {
    const traversal = buildSetupWizardTraversal({ progress: progressOf() });
    // The OPERATOR half since D17 (#246), and still in registry declaration
    // order within it — a filter preserves order, a `sort()` would not, and the
    // journey's order is the registry's positions.
    expect(traversal.steps.map((step) => step.id)).toEqual(OPERATOR_STEP_IDS);
    expect(traversal.steps.map((step) => step.order)).toEqual(
      SETUP_STEP_REGISTRY.filter((entry) => entry.kind === "operator").map(
        (entry) => entry.order,
      ),
    );
    expect(traversal.environmentFacts.map((fact) => fact.order)).toEqual(
      SETUP_STEP_REGISTRY.filter((entry) => entry.kind === "environment").map(
        (entry) => entry.order,
      ),
    );
  });

  it("drops a disabled module's steps entirely rather than deferring them (D4)", () => {
    const xeroOff: ModuleSettingsValues = {
      ...ALL_MODULES_ON,
      xeroIntegration: false,
    };
    // A club that once skipped a Xero step and has since turned Xero off must
    // see no trace of it: declined is not deferred, and nothing is persisted to
    // say the club declined.
    //
    // Everything else is CONFIRMED rather than merely passing its own check
    // (D14, #237). The assertions below are about a finished journey, and since
    // the split only an operator's record gets a club to one; passing checks
    // would leave every step defaulted at 0%, which would still prove the
    // applicability point but is no longer the scenario this test is named for.
    const traversal = buildSetupWizardTraversal({
      progress: progressOf(
        [...SETUP_STEP_IDS],
        ["xero-operational", "xero-mappings"],
      ),
      moduleSettings: xeroOff,
    });

    expect(traversal.applicableStepIds).not.toContain("xero-operational");
    expect(traversal.applicableStepIds).not.toContain("xero-mappings");
    expect(traversal.outstandingStepIds).toEqual([]);
    expect(traversal.percentComplete).toBe(100);
  });

  it("ignores progress ids the registry no longer contains", () => {
    const traversal = buildSetupWizardTraversal({
      progress: progressOf(
        ["club-config", "a-step-a-later-version-removed"],
        ["another-ghost"],
      ),
      readinessStatuses: {},
    });
    expect(traversal.applicableStepIds).toEqual([...SETUP_STEP_IDS]);
    expect(traversal.steps.filter((step) => step.isComplete).map((s) => s.id)).toEqual([
      "club-config",
    ]);
  });

  /*
    THE MIRROR OF THE TEST ABOVE, and the one that was missing. That one covers a
    progress record naming a step the registry has since REMOVED. This covers a
    progress record written before a step was ADDED — which is not hypothetical
    and is not rare: it is what every club's saved progress looks like the moment
    they take an update, and it is the scenario mockup 7 exists for. It became
    real when `environment-role` arrived from upstream (ENV-SAFETY 1, #3034) as
    an eighteenth step slotted into the middle of a journey clubs are already
    part-way through.

    Parameterised over EVERY id rather than written once for `environment-role`,
    because the property is general — no step may depend on having been in the
    registry when the club's progress row was written — and because a single
    hand-picked case would go quiet the day somebody moved that step. The
    positional assertion for `environment-role` specifically is the test after
    this one.
  */
  it.each([...OPERATOR_STEP_IDS])(
    "treats %s as unstarted, applicable and the resume point when the saved progress predates it",
    (addedId) => {
      // Every OTHER step complete: the record of a club that finished setup on
      // the previous version and has just been updated.
      const progress = progressOf(
        OPERATOR_STEP_IDS.filter((id) => id !== addedId),
      );
      const traversal = buildSetupWizardTraversal({
        progress,
        // No readiness check passes on its own, so completeness comes only from
        // the progress record — otherwise a step whose check happens to pass
        // would report complete and this test would prove nothing about it.
        readinessStatuses: {},
      });

      // Nothing crashed, nothing was dropped, and the new step did not displace
      // the ones the club had already done. `applicableStepIds` is still the
      // WHOLE applicable set — D17 (#246) narrowed the journey and pointedly
      // not this field, which the readiness cards are married to.
      expect(traversal.applicableStepIds).toEqual([...SETUP_STEP_IDS]);
      expect(traversal.steps).toHaveLength(OPERATOR_STEP_IDS.length);

      const added = traversal.steps.find((step) => step.id === addedId);
      expect(added?.isComplete).toBe(false);
      expect(added?.isDeferred).toBe(false);
      expect(added?.isStale).toBe(false);
      // It is where the operator resumes, and it is the only thing left.
      expect(traversal.currentStepId).toBe(addedId);
      expect(traversal.navigationFrontierStepId).toBe(addedId);
      expect(added?.state).toBe("current");
      expect(added?.isReachable).toBe(true);
      expect(traversal.outstandingStepIds).toEqual([addedId]);
      expect(traversal.allResolved).toBe(false);
      expect(traversal.percentComplete).toBe(
        Math.round(
          ((OPERATOR_STEP_IDS.length - 1) / OPERATOR_STEP_IDS.length) * 100,
        ),
      );
    },
  );

  /*
    THE D17 SPLIT AT THE JOURNEY LEVEL (#246).

    This replaces "keeps environment-role third in the journey", which pinned
    that upstream's eighteenth step was SLOTTED IN at position three rather than
    appended (ENV-SAFETY 1, #3034). The registry still keeps it third — that half
    of the old pin lives on in `setup-step-registry.test.ts`'s positional
    `EXPECTED_STEP_IDS` — but the JOURNEY no longer visits it, which is the whole
    of D17: UAT round 2 found positions three, four and five of the walk were
    three consecutive screens an operator cannot act on.
  */
  it("walks the operator steps and reports the environment facts separately", () => {
    const traversal = buildSetupWizardTraversal({
      progress: progressOf(),
      readinessStatuses: {},
    });

    // The three dead screens are gone from the front of the walk: what used to
    // be positions 3, 4 and 5 are now `seed-admin` and the rest of the club's
    // own setup.
    expect(traversal.steps.map((step) => step.id).slice(0, 4)).toEqual([
      "club-config",
      "club-time-zone",
      "seed-admin",
      "feature-flags",
    ]);

    // Not merely absent from the rail — present, in order, on the panel.
    expect(traversal.environmentFacts.map((fact) => fact.id)).toEqual(
      ENVIRONMENT_STEP_IDS,
    );
    // The two sets partition the applicable set exactly: nothing was dropped on
    // the way through, and nothing is in both places.
    expect([
      ...traversal.steps.map((step) => step.id),
      ...traversal.environmentFacts.map((fact) => fact.id),
    ].sort()).toEqual([...traversal.applicableStepIds].sort());
  });

});

describe("setup wizard traversal: the real registry has no stale steps (#219)", () => {
  // Every registered step declares an empty prerequisite list today, so there
  // is nothing that can invalidate anything. This is the pin: when a genuine
  // prerequisite is first declared, this test fails and whoever declared it has
  // to say so deliberately.
  const progressCases: [string, SetupWizardTraversalProgress][] = [
    ["a fresh install", progressOf()],
    ["everything complete", progressOf([...SETUP_STEP_IDS])],
    ["everything skipped", progressOf([], [...SETUP_STEP_IDS])],
    [
      "a half-worked club",
      progressOf(
        SETUP_STEP_IDS.filter((_id, index) => index % 2 === 0),
        SETUP_STEP_IDS.filter((_id, index) => index % 3 === 0),
      ),
    ],
  ];

  it.each(progressCases)("derives no stale step for %s", (_label, progress) => {
    expect(deriveStaleSetupStepIds({ progress })).toEqual([]);
    expect(buildSetupWizardTraversal({ progress }).staleStepIds).toEqual([]);
  });

  it("has an empty prerequisite list on every registered step", () => {
    expect(
      SETUP_STEP_REGISTRY.filter((entry) => entry.prerequisites.length > 0),
    ).toEqual([]);
  });

  it("parks a fresh install on the first step with nothing beyond it reachable", () => {
    const traversal = buildSetupWizardTraversal({ progress: progressOf() });
    const [first, second] = traversal.steps;

    expect(traversal.currentStepId).toBe<SetupStepId>("club-config");
    expect(traversal.navigationFrontierStepId).toBe<SetupStepId>("club-config");
    expect(first.state).toBe("current");
    expect(first.isReachable).toBe(true);
    expect(second.isReachable).toBe(false);
    expect(traversal.percentComplete).toBe(0);
    // The operator steps only, since D17 (#246): an environment fact is not
    // outstanding WORK — nobody can do it from here — so listing it as such on
    // the launch panel would tell an operator they had left something undone.
    expect(traversal.outstandingStepIds).toEqual(OPERATOR_STEP_IDS);
  });

  it("opens everything and reports 100% once every step is complete", () => {
    const traversal = buildSetupWizardTraversal({
      progress: progressOf([...SETUP_STEP_IDS]),
    });
    expect(traversal.currentStepId).toBeNull();
    expect(traversal.outstandingStepIds).toEqual([]);
    expect(traversal.steps.every((step) => step.isReachable)).toBe(true);
    expect(traversal.percentComplete).toBe(100);
  });
});

describe("setup wizard traversal: the step state matrix (#219)", () => {
  const registry = linear("s1", "s2", "s3");

  it("reports complete for a step the operator marked done", () => {
    const traversal = traverse({ registry, progress: progressOf(["s1"]) });
    expect(stateOf(traversal, "s1")).toBe("complete");
    expect(traversal.steps[0]).toMatchObject({
      isComplete: true,
      isStale: false,
      isDeferred: false,
    });
  });

  /*
    D14 (#237). This test used to be called "reports complete for a step whose
    readiness check passes on its own" and asserted exactly that, which is the
    behaviour the UAT walkthrough reported as a bug: a seed writes defaults, the
    defaults satisfy the checks, and the wizard called that progress.

    s1 is also the CURRENT step here (nothing before it is confirmed), and
    `current` wins the state precedence — so the state reads "current" and the
    `isDefaulted` flag is what carries the fact, exactly as `isStale` and
    `isDeferred` do under the same precedence. s2 is the one that can show the
    bare `defaulted` state.
  */
  it("reports defaulted, not complete, for a step whose check passes with nobody confirming it", () => {
    const traversal = traverse({
      registry,
      readinessStatuses: { s1: "complete", s2: "complete" },
    });

    expect(stateOf(traversal, "s1")).toBe("current");
    expect(traversal.steps[0]).toMatchObject({
      isComplete: false,
      isDefaulted: true,
      isStale: false,
      isDeferred: false,
    });

    expect(stateOf(traversal, "s2")).toBe("defaulted");
    expect(traversal.steps[1]).toMatchObject({
      isComplete: false,
      isDefaulted: true,
    });

    // D14: nothing here counts toward the percentage, and the resume point is
    // still the very first step.
    expect(traversal.percentComplete).toBe(0);
    expect(traversal.currentStepId).toBe("s1");
    expect(traversal.outstandingStepIds).toEqual(["s1", "s2", "s3"]);
  });

  it("reports complete once the operator confirms a step that was defaulted", () => {
    const traversal = traverse({
      registry,
      progress: progressOf(["s1"]),
      readinessStatuses: { s1: "complete" },
    });
    expect(stateOf(traversal, "s1")).toBe("complete");
    expect(traversal.steps[0]).toMatchObject({
      isComplete: true,
      isDefaulted: false,
    });
  });

  /*
    `SetupWizardTraversalStep.isDefaulted` says "never true at the same time as
    `isStale`", and this is what holds it to that.

    The trap: `defaulted` is computed off `!stepConfirmed`, NOT off
    `!stepComplete`, and the two differ on exactly one step — a stale one, which
    the operator DID confirm but whose staleness clears `isComplete`. Off
    `!stepComplete`, a stale step whose own check still passes would report as
    stale AND defaulted at once, and the rail would tell an operator both that
    they had finished this and that nobody ever had.

    Mutation-verified: swapping `!stepConfirmed` for `!stepComplete` fails this
    test and, before it existed, failed nothing at all.
  */
  it("never reports a stale step as defaulted, however well its own check passes", () => {
    const withPrerequisite = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    const traversal = traverse({
      registry: withPrerequisite,
      progress: progressOf(["s2"]),
      readinessStatuses: { s2: "complete" },
    });

    expect(stateOf(traversal, "s2")).toBe("stale");
    expect(traversal.steps[1]).toMatchObject({
      isStale: true,
      isDefaulted: false,
      isComplete: false,
    });
  });

  it("reports deferred, not defaulted, when a passing step is skipped (D15's escape)", () => {
    // Skipping is how an operator gets past a defaulted step without confirming
    // it. The two states must not both be true, or the rail would tell somebody
    // a step they had explicitly dealt with still wanted a decision.
    const traversal = traverse({
      registry,
      progress: progressOf([], ["s2"]),
      readinessStatuses: { s2: "complete" },
    });
    expect(stateOf(traversal, "s2")).toBe("deferred");
    expect(traversal.steps[1]).toMatchObject({
      isDeferred: true,
      isDefaulted: false,
    });
  });

  it("treats a warning or blocked readiness check as outstanding", () => {
    for (const status of ["warning", "blocked", "not_started"] as const) {
      const traversal = traverse({ registry, readinessStatuses: { s1: status } });
      expect(stateOf(traversal, "s1")).toBe("current");
      expect(traversal.steps[0].isComplete).toBe(false);
    }
  });

  it("defaults an unsupplied readiness status to not_started", () => {
    // The documented default, pinned: with no statuses at all a step counts as
    // complete only when the operator marked it complete.
    const withoutStatuses = traverse({ registry });
    const withNotStarted = traverse({
      registry,
      readinessStatuses: { s1: "not_started", s2: "not_started", s3: "not_started" },
    });
    expect(withoutStatuses.steps).toEqual(withNotStarted.steps);
  });

  it("reports complete, not deferred, when a passing step is also skipped", () => {
    // C1's predicate: a check that already passes stays complete even when
    // deferred, and `progressStateOf` gives completed precedence over skipped.
    const traversal = traverse({
      registry,
      progress: progressOf(["s1"], ["s1"]),
    });
    expect(stateOf(traversal, "s1")).toBe("complete");
    expect(traversal.steps[0].isDeferred).toBe(false);
  });

  it("reports deferred for a skipped step that is not complete, and keeps it outstanding", () => {
    const traversal = traverse({ registry, progress: progressOf([], ["s2"]) });
    // s1 is the current step, so s2 is the first that can read `deferred`.
    expect(stateOf(traversal, "s2")).toBe("deferred");
    expect(traversal.steps[1].isDeferred).toBe(true);
    expect(traversal.outstandingStepIds).toContain("s2");
    expect(traversal.applicableStepIds).toContain("s2");
  });

  it("reports not-started for an untouched step that is not current", () => {
    expect(stateOf(traverse({ registry }), "s3")).toBe("not-started");
  });

  it("reports stale for a completed step whose prerequisite is outstanding", () => {
    const withPrerequisite = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    const traversal = traverse({
      registry: withPrerequisite,
      progress: progressOf(["s2"]),
    });
    expect(stateOf(traversal, "s2")).toBe("stale");
    expect(traversal.steps[1]).toMatchObject({
      isStale: true,
      isComplete: false,
    });
    expect(traversal.staleStepIds).toEqual(["s2"]);
  });

  it("gives current precedence over stale and deferred, keeping the flags", () => {
    // Exactly one step is current and the rail has to be able to say which, so
    // `state` reports it; `isStale`/`isDeferred` carry what else is true.
    const withPrerequisite = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    const staleIsCurrent = traverse({
      registry: withPrerequisite,
      progress: progressOf(["s1", "s2"]),
      readinessStatuses: {},
      staleStepIds: ["s2"],
    });
    expect(staleIsCurrent.currentStepId).toBe("s2");
    expect(stateOf(staleIsCurrent, "s2")).toBe("current");
    expect(staleIsCurrent.steps[1].isStale).toBe(true);

    const deferredIsCurrent = traverse({
      registry: linear("s1", "s2"),
      progress: progressOf([], ["s1"]),
    });
    expect(deferredIsCurrent.currentStepId).toBe("s1");
    expect(stateOf(deferredIsCurrent, "s1")).toBe("current");
    expect(deferredIsCurrent.steps[0].isDeferred).toBe(true);
  });

  it("gives every applicable step exactly one state", () => {
    const traversal = traverse({
      registry: linear("s1", "s2", "s3", "s4"),
      progress: progressOf(["s1"], ["s3"]),
    });
    expect(traversal.steps.map((step) => step.state)).toEqual([
      "complete",
      "current",
      "deferred",
      "not-started",
    ]);
  });
});

describe("setup wizard traversal: D2 navigation (#219)", () => {
  it("uses only registries C1 would accept", () => {
    for (const registry of [
      linear("s1", "s2", "s3", "s4", "s5"),
      syntheticRegistry([
        { id: "s1" },
        { id: "s2" },
        { id: "s3", prerequisites: ["s1"] },
        { id: "s4" },
        { id: "s5", prerequisites: ["s2"] },
      ]),
    ]) {
      expect(findSetupStepRegistryViolations(registry)).toEqual([]);
    }
  });

  it("allows navigation to any completed step, in either direction (AC 1)", () => {
    // s1, s2 and s4 complete; s3 outstanding. s4 sits BEYOND the stopping
    // point and is still reachable, and so is s1 behind it.
    const traversal = traverse({
      registry: linear("s1", "s2", "s3", "s4", "s5"),
      progress: progressOf(["s1", "s2", "s4"]),
    });
    expect(reachableIds(traversal)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(canNavigateToSetupStep(traversal, "s1")).toBe(true);
    expect(canNavigateToSetupStep(traversal, "s4")).toBe(true);
  });

  it("refuses navigation past the first applicable step that is not complete (AC 2)", () => {
    const traversal = traverse({
      registry: linear("s1", "s2", "s3", "s4"),
      progress: progressOf(["s1"]),
    });
    expect(traversal.navigationFrontierStepId).toBe("s2");
    expect(canNavigateToSetupStep(traversal, "s2")).toBe(true);
    expect(canNavigateToSetupStep(traversal, "s3")).toBe(false);
    expect(canNavigateToSetupStep(traversal, "s4")).toBe(false);
  });

  it("limits forward navigation to the earliest stale step when an edit invalidates later ones (AC 3)", () => {
    // The whole journey was completed, then s1 was reopened, which invalidates
    // s3 and s5. Forward movement stops at s3, the earliest step that now needs
    // attention — not at s5, and not at the end.
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2" },
      { id: "s3", prerequisites: ["s1"] },
      { id: "s4" },
      { id: "s5", prerequisites: ["s2"] },
    ]);
    const traversal = traverse({
      registry,
      progress: progressOf(["s2", "s3", "s4", "s5"]),
    });
    expect(traversal.staleStepIds).toEqual(["s3"]);
    expect(traversal.navigationFrontierStepId).toBe("s1");

    const afterS1 = traverse({
      registry,
      progress: progressOf(["s1", "s2", "s3", "s4", "s5"]),
      staleStepIds: ["s3", "s5"],
    });
    expect(afterS1.navigationFrontierStepId).toBe("s3");
    expect(canNavigateToSetupStep(afterS1, "s3")).toBe(true);
    // s4 is complete, so AC 1 keeps it reachable even though it sits beyond the
    // frontier. AC 3 governs how far the operator may WALK, not whether
    // finished work may be reviewed.
    expect(canNavigateToSetupStep(afterS1, "s4")).toBe(true);
    expect(stateOf(afterS1, "s4")).toBe("complete");
    // s5 is stale, so it is not complete and it is beyond the frontier.
    expect(canNavigateToSetupStep(afterS1, "s5")).toBe(false);
  });

  it("takes the earliest of stale and not-started as the frontier (AC 3)", () => {
    // s2 was never started and s4 has gone stale. The earlier of the two wins.
    const traversal = traverse({
      registry: syntheticRegistry([
        { id: "s1" },
        { id: "s2" },
        { id: "s3" },
        { id: "s4", prerequisites: ["s3"] },
      ]),
      progress: progressOf(["s1", "s4"]),
    });
    expect(traversal.staleStepIds).toEqual(["s4"]);
    expect(traversal.navigationFrontierStepId).toBe("s2");
    expect(reachableIds(traversal)).toEqual(["s1", "s2"]);
  });

  it("lets a deferred step be walked past, which is the whole point of deferring", () => {
    // s1 deferred, s2 deferred, s3 untouched: the operator may reach s3.
    // "Skip for now" that did not let you go on would be a label and nothing
    // more, and AC 3 names only "stale or not started" as the stopping set.
    const traversal = traverse({
      registry: linear("s1", "s2", "s3", "s4"),
      progress: progressOf([], ["s1", "s2"]),
    });
    expect(traversal.navigationFrontierStepId).toBe("s3");
    expect(reachableIds(traversal)).toEqual(["s1", "s2", "s3"]);
    expect(canNavigateToSetupStep(traversal, "s4")).toBe(false);
  });

  it("caps the frontier at a stale step (F2's surviving half)", () => {
    // F2 (#219 review round, binding decision): staleness ALWAYS caps the
    // frontier. s1, s2 (prereq s1), s3, s4; s2 confirmed by the operator, s1
    // outstanding — so s2 is stale, and the frontier must stop at it rather
    // than walk past on the strength of a confirmation that no longer holds.
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
      { id: "s3" },
      { id: "s4" },
    ]);
    const traversal = traverse({
      registry,
      progress: progressOf(["s2"]),
    });
    expect(traversal.steps.find((step) => step.id === "s2")).toMatchObject({
      isStale: true,
      isComplete: false,
      isDefaulted: false,
    });
    // s1 is unconfirmed and unskipped, so it is where the walk actually stops.
    expect(traversal.navigationFrontierStepId).toBe("s1");
    expect(canNavigateToSetupStep(traversal, "s3")).toBe(false);
  });

  it("no longer admits F2's stale-AND-deferred step at all, since D14", () => {
    /*
      F2's reproducer, verbatim, run against the split predicate (#237).

      It USED to produce a step that was stale and deferred at once: s2 was
      "recorded complete" purely because its own readiness check passed, which
      made it eligible for staleness, while its progress record said skipped.
      D14 removes the first half — the stale set is intersected against steps the
      OPERATOR confirmed, and `progressStateOf` returns exactly one answer per
      step, so "confirmed" and "skipped" are now mutually exclusive. The
      combination is unreachable.

      `isBlocking`'s `fact.stale ||` clause is therefore redundant today and is
      KEPT anyway. It costs nothing, F2 is a recorded decision rather than an
      implementation detail, and what makes the combination impossible is one
      line of precedence in `progressStateOf` — the cheap guard is the right
      side to be wrong on if that line ever moves.
    */
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
      { id: "s3" },
      { id: "s4" },
    ]);
    const traversal = traverse({
      registry,
      progress: progressOf([], ["s1", "s2"]),
      readinessStatuses: { s2: "complete" },
    });

    const s2 = traversal.steps.find((step) => step.id === "s2");
    expect(s2).toMatchObject({
      isStale: false,
      isDeferred: true,
      isComplete: false,
      // Deferral beats a passing check: the operator dealt with this one.
      isDefaulted: false,
    });
    expect(traversal.staleStepIds).toEqual([]);

    // Both skips buy passage, so the walk runs on to the first step that is
    // neither confirmed nor skipped.
    expect(traversal.navigationFrontierStepId).toBe("s3");
    expect(reachableIds(traversal)).toEqual(["s1", "s2", "s3"]);
  });

  it("keeps a deferred step outstanding and out of the percentage", () => {
    const traversal = traverse({
      registry: linear("s1", "s2", "s3", "s4"),
      progress: progressOf(["s1", "s2"], ["s3"]),
    });
    expect(traversal.outstandingStepIds).toEqual(["s3", "s4"]);
    expect(traversal.percentComplete).toBe(50);
  });

  it("does not reach a deferred step that sits beyond the frontier", () => {
    // Deferring s2 bought passage while s1 was resolved; reopening s1 takes it
    // back. Nothing complete lies beyond, so the frontier holds.
    const traversal = traverse({
      registry: linear("s1", "s2", "s3"),
      progress: progressOf([], ["s2"]),
    });
    expect(traversal.navigationFrontierStepId).toBe("s1");
    expect(canNavigateToSetupStep(traversal, "s2")).toBe(false);
    expect(stateOf(traversal, "s2")).toBe("deferred");
  });

  it("opens the whole journey once every step is complete or deferred", () => {
    const traversal = traverse({
      registry: linear("s1", "s2", "s3"),
      progress: progressOf(["s1", "s3"], ["s2"]),
    });
    expect(traversal.navigationFrontierStepId).toBe("s3");
    expect(traversal.steps.every((step) => step.isReachable)).toBe(true);
  });

  /*
    D15 (#237), the frontier half — the rule the decision is actually named for.
    A step sitting on a passing check nobody confirmed stops the walk exactly
    where an untouched step would, so a fresh install cannot be clicked through
    to the end. Contrast the deferred case two tests above: skipping buys
    passage, defaulting does not.

    Mutation-verified — and NOT by "excluding `fact.defaulted` from
    `isBlocking`", which named a term that predicate does not have. That absence
    is D15 working: a defaulted step is not complete, not stale and not deferred,
    so `!fact.complete && (fact.stale || !fact.deferred)` already blocks on it
    with no clause of its own. The probe is the opposite edit — adding
    `&& !fact.defaulted` to `isBlocking` — and this test fails on it.
  */
  it("caps the frontier at a defaulted step, exactly as at an untouched one (D15)", () => {
    const registry = linear("s1", "s2", "s3");
    const defaultedFirst = traverse({
      registry,
      readinessStatuses: { s1: "complete", s2: "complete", s3: "complete" },
    });
    expect(defaultedFirst.navigationFrontierStepId).toBe("s1");
    expect(reachableIds(defaultedFirst)).toEqual(["s1"]);
    expect(canNavigateToSetupStep(defaultedFirst, "s2")).toBe(false);

    // An untouched first step produces the identical frontier — which is the
    // claim "exactly as at an untouched one" in as many words.
    const untouchedFirst = traverse({ registry });
    expect(untouchedFirst.navigationFrontierStepId).toBe(
      defaultedFirst.navigationFrontierStepId,
    );
    expect(reachableIds(untouchedFirst)).toEqual(reachableIds(defaultedFirst));

    // And confirming it passes the step, which is the operator's way through.
    const confirmed = traverse({
      registry,
      progress: progressOf(["s1"]),
      readinessStatuses: { s1: "complete", s2: "complete", s3: "complete" },
    });
    expect(confirmed.navigationFrontierStepId).toBe("s2");
    expect(canNavigateToSetupStep(confirmed, "s2")).toBe(true);

    // …as does skipping it (D15's stated escape).
    const skipped = traverse({
      registry,
      progress: progressOf([], ["s1"]),
      readinessStatuses: { s1: "complete", s2: "complete", s3: "complete" },
    });
    expect(skipped.navigationFrontierStepId).toBe("s2");
  });

  it("resumes at the first step that is not complete, deferred and stale included", () => {
    expect(
      traverse({
        registry: linear("s1", "s2", "s3"),
        progress: progressOf(["s1"], ["s2"]),
      }).currentStepId,
    ).toBe("s2");

    expect(
      traverse({
        registry: syntheticRegistry([
          { id: "s1" },
          { id: "s2", prerequisites: ["s1"] },
          { id: "s3" },
        ]),
        progress: progressOf(["s2", "s3"]),
      }).currentStepId,
    ).toBe("s1");
  });

  it("refuses an id that is unknown, empty or belongs to a disabled module", () => {
    const traversal = buildSetupWizardTraversal({
      progress: progressOf([...SETUP_STEP_IDS]),
      moduleSettings: { ...ALL_MODULES_ON, xeroIntegration: false },
    });
    expect(canNavigateToSetupStep(traversal, "xero-operational")).toBe(false);
    expect(canNavigateToSetupStep(traversal, "not-a-step")).toBe(false);
    expect(canNavigateToSetupStep(traversal, "")).toBe(false);
  });

  it("reports no frontier and no current step for an empty applicable set", () => {
    const traversal = traverse({ registry: [], progress: progressOf() });
    expect(traversal.steps).toEqual([]);
    expect(traversal.navigationFrontierStepId).toBeNull();
    expect(traversal.currentStepId).toBeNull();
    expect(canNavigateToSetupStep(traversal, "s1")).toBe(false);
  });
});

describe("setup wizard traversal: staleness derivation (#219, D11)", () => {
  it("marks a completed step stale when a prerequisite is outstanding", () => {
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    expect(
      deriveStaleSetupStepIds({ registry, progress: progressOf(["s2"]) }),
    ).toEqual(["s2"]);
    expect(
      deriveStaleSetupStepIds({ registry, progress: progressOf(["s1", "s2"]) }),
    ).toEqual([]);
  });

  it("cascades staleness down the prerequisite chain", () => {
    // s1 outstanding invalidates s2, and s2 may yet change, so s3 needs another
    // look too. Fail toward stale — the direction C2's criteria ask for.
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
      { id: "s3", prerequisites: ["s2"] },
      { id: "s4", prerequisites: ["s3"] },
    ]);
    expect(
      deriveStaleSetupStepIds({
        registry,
        progress: progressOf(["s2", "s3", "s4"]),
      }),
    ).toEqual(["s2", "s3", "s4"]);
  });

  it("never marks a step stale that was not completed in the first place", () => {
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    expect(deriveStaleSetupStepIds({ registry, progress: progressOf() })).toEqual(
      [],
    );
    expect(
      deriveStaleSetupStepIds({ registry, progress: progressOf([], ["s2"]) }),
    ).toEqual([]);
  });

  it("counts a deferred prerequisite as outstanding", () => {
    // Deferring buys passage, not completion, so anything downstream of a
    // deferred step is still owed another look.
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    expect(
      deriveStaleSetupStepIds({
        registry,
        progress: progressOf(["s2"], ["s1"]),
      }),
    ).toEqual(["s2"]);
  });

  /*
    D14 (#237) reversed this one, and the reversal is intended rather than a
    casualty. It used to be called "honours a prerequisite satisfied by its
    readiness check alone" and asserted that s2 stayed fresh.

    A prerequisite sitting on nothing but its own passing check is DEFAULTED,
    which is outstanding — nobody has agreed that the thing s2 was checked
    against is right. That is exactly the situation D3 asks for another look at,
    so s2 is stale. Confirming s1 clears it, which the second half asserts so
    this cannot be read as staleness that never lifts.
  */
  it("treats a merely-defaulted prerequisite as outstanding, and clears once it is confirmed", () => {
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    expect(
      deriveStaleSetupStepIds({
        registry,
        progress: progressOf(["s2"]),
        readinessStatuses: { s1: "complete" },
      }),
    ).toEqual(["s2"]);

    expect(
      deriveStaleSetupStepIds({
        registry,
        progress: progressOf(["s1", "s2"]),
        readinessStatuses: { s1: "complete" },
      }),
    ).toEqual([]);
  });

  it("returns stale ids in registry declaration order", () => {
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
      { id: "s3", prerequisites: ["s1"] },
      { id: "s4", prerequisites: ["s1"] },
    ]);
    expect(
      deriveStaleSetupStepIds({
        registry,
        progress: progressOf(["s4", "s2", "s3"]),
      }),
    ).toEqual(["s2", "s3", "s4"]);
  });

  it("ignores a prerequisite that is not applicable", () => {
    // A cross-module prerequisite whose module is off can never be completed,
    // so counting it would pin its dependent stale forever and make the wizard
    // unfinishable. C1's guard forbids this shape in the real registry — the
    // next test proves the guard is what stops it.
    const registry = syntheticRegistry([
      { id: "s1", ownerModule: "xeroIntegration" },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    expect(
      deriveStaleSetupStepIds({
        registry,
        progress: progressOf(["s2"]),
        moduleSettings: { ...ALL_MODULES_ON, xeroIntegration: false },
      }),
    ).toEqual([]);
  });

  it("fails a dependent toward stale when its prerequisite is a ghost — unknown to the whole registry (F3)", () => {
    // #219 review finding F3, recorded decision: an id absent from the WHOLE
    // registry (a typo, a renamed step whose dependents were not updated)
    // reads oppositely from the case above, where "s1" is a real step merely
    // excluded by a disabled module. The ghost must mark its dependent stale,
    // not leave it ignored the same way.
    const registry = syntheticRegistry([
      { id: "s2", prerequisites: ["ghost-of-s1"] },
    ]);
    expect(findSetupStepRegistryViolations(registry)).not.toEqual([]);
    expect(
      deriveStaleSetupStepIds({ registry, progress: progressOf(["s2"]) }),
    ).toEqual(["s2"]);
  });

  it("keeps ignoring a disabled-module prerequisite even alongside a genuine ghost (F3)", () => {
    // Both s3's prerequisites are absent from the applicable set for the same
    // surface reason (`applicable.has` is false for both), but only one of
    // them is a ghost. s2's module being off must stay ignored; "ghost-of-s1"
    // must still force s3 stale.
    const registry = syntheticRegistry([
      { id: "s2", ownerModule: "xeroIntegration" },
      { id: "s3", prerequisites: ["s2", "ghost-of-s1"] },
    ]);
    expect(
      deriveStaleSetupStepIds({
        registry,
        progress: progressOf(["s2", "s3"]),
        moduleSettings: { ...ALL_MODULES_ON, xeroIntegration: false },
      }),
    ).toEqual(["s3"]);
  });

  it("is only reachable through registries C1 rejects", () => {
    // Deliberately invalid: the two shapes the fail-open and cycle rules above
    // exist for are both build failures under C1's guards.
    const crossModule = syntheticRegistry([
      { id: "s1", ownerModule: "xeroIntegration" },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    expect(findSetupStepRegistryViolations(crossModule)).not.toEqual([]);

    const cycle = syntheticRegistry([
      { id: "s1", prerequisites: ["s2"] },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    expect(findSetupStepRegistryViolations(cycle)).not.toEqual([]);
  });

  it("terminates on a prerequisite cycle rather than looping", () => {
    const cycle = syntheticRegistry([
      { id: "s1", prerequisites: ["s2"] },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    // Mutually complete: no member of the component is outstanding, so the
    // fixpoint never opens it. Pinned so a change to either guard is a named
    // failure rather than a hang.
    expect(
      deriveStaleSetupStepIds({ registry: cycle, progress: progressOf(["s1", "s2"]) }),
    ).toEqual([]);
    // One member outstanding: the other is stale, and the walk still ends.
    expect(
      deriveStaleSetupStepIds({ registry: cycle, progress: progressOf(["s2"]) }),
    ).toEqual(["s2"]);
  });
});

describe("setup wizard traversal: the C2 staleness seam (#219, D11)", () => {
  const registry = syntheticRegistry([
    { id: "s1" },
    { id: "s2", prerequisites: ["s1"] },
    { id: "s3" },
  ]);

  it("uses a supplied stale set in place of the derivation", () => {
    // The derivation would return nothing here — everything is complete — so a
    // different answer proves the supplied set was used, which is the swap C2
    // performs.
    expect(
      deriveStaleSetupStepIds({
        registry,
        progress: progressOf(["s1", "s2", "s3"]),
      }),
    ).toEqual([]);

    const traversal = traverse({
      registry,
      progress: progressOf(["s1", "s2", "s3"]),
      staleStepIds: ["s3"],
    });
    expect(traversal.staleStepIds).toEqual(["s3"]);
    expect(stateOf(traversal, "s3")).toBe("current");
    expect(traversal.steps[2].isStale).toBe(true);
    expect(traversal.percentComplete).toBe(67);
  });

  it("suppresses the derivation entirely, even when it would return more", () => {
    const traversal = traverse({
      registry,
      progress: progressOf(["s2", "s3"]),
      staleStepIds: [],
    });
    // s2's prerequisite s1 is outstanding, so the derivation would call s2
    // stale. An explicit empty set is an answer, not an omission.
    expect(traversal.staleStepIds).toEqual([]);
    expect(stateOf(traversal, "s2")).toBe("complete");
  });

  it("discards a supplied stale id for a step that was never completed", () => {
    const traversal = traverse({
      registry,
      progress: progressOf(["s1"]),
      staleStepIds: ["s2", "s3"],
    });
    expect(traversal.staleStepIds).toEqual([]);
    expect(stateOf(traversal, "s2")).toBe("current");
    expect(stateOf(traversal, "s3")).toBe("not-started");
  });

  it("discards a supplied stale id for a step of a disabled module", () => {
    const moduleRegistry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", ownerModule: "xeroIntegration" },
    ]);
    const traversal = traverse({
      registry: moduleRegistry,
      progress: progressOf(["s1", "s2"]),
      moduleSettings: { ...ALL_MODULES_ON, xeroIntegration: false },
      staleStepIds: ["s2"],
    });
    expect(traversal.staleStepIds).toEqual([]);
    expect(traversal.applicableStepIds).toEqual(["s1"]);
  });
});

describe("setup wizard traversal: progress percentage (D7, #219)", () => {
  it("reports 100 for an empty applicable set", () => {
    // Pinned because the acceptance criterion left division by zero undefined,
    // and because C3 makes an all-module registry with every module off real.
    expect(traverse({ registry: [], progress: progressOf() }).percentComplete).toBe(
      100,
    );

    const allModuleOwned = syntheticRegistry([
      { id: "s1", ownerModule: "xeroIntegration" },
      { id: "s2", ownerModule: "financeDashboard" },
    ]);
    expect(
      traverse({
        registry: allModuleOwned,
        moduleSettings: {
          ...ALL_MODULES_ON,
          xeroIntegration: false,
          financeDashboard: false,
        },
      }).percentComplete,
    ).toBe(100);
  });

  it("counts only complete steps, over the applicable denominator", () => {
    const registry = linear("s1", "s2", "s3", "s4");
    expect(traverse({ registry }).percentComplete).toBe(0);
    expect(
      traverse({ registry, progress: progressOf(["s1"]) }).percentComplete,
    ).toBe(25);
    expect(
      traverse({ registry, progress: progressOf(["s1", "s2", "s3", "s4"]) })
        .percentComplete,
    ).toBe(100);
  });

  it("moves the denominator with the module flags rather than the count", () => {
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2" },
      { id: "s3", ownerModule: "xeroIntegration" },
      { id: "s4", ownerModule: "xeroIntegration" },
    ]);
    const progress = progressOf(["s1", "s2"]);
    expect(
      traverse({ registry, progress, moduleSettings: ALL_MODULES_ON })
        .percentComplete,
    ).toBe(50);
    expect(
      traverse({
        registry,
        progress,
        moduleSettings: { ...ALL_MODULES_ON, xeroIntegration: false },
      }).percentComplete,
    ).toBe(100);
  });

  it("never reports 100 while anything is outstanding, or 0 while anything is done", () => {
    const many = linear(...Array.from({ length: 400 }, (_v, i) => `s${i}`));
    const allButOne = Array.from({ length: 399 }, (_v, i) => `s${i}`);
    expect(traverse({ registry: many, progress: progressOf(allButOne) }).percentComplete).toBe(
      99,
    );
    expect(traverse({ registry: many, progress: progressOf(["s0"]) }).percentComplete).toBe(
      1,
    );
  });

  it("excludes stale and deferred steps from the count", () => {
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
      { id: "s3" },
      { id: "s4" },
    ]);
    const traversal = traverse({
      registry,
      progress: progressOf(["s2", "s3"], ["s4"]),
    });
    expect(traversal.staleStepIds).toEqual(["s2"]);
    expect(traversal.percentComplete).toBe(25);
  });
});

describe("setup wizard traversal: allResolved and blockingStepIds (#219 F9, D9's launch panel)", () => {
  it("is resolved when every applicable step is complete", () => {
    const traversal = traverse({
      registry: linear("s1", "s2"),
      progress: progressOf(["s1", "s2"]),
    });
    expect(traversal.blockingStepIds).toEqual([]);
    expect(traversal.allResolved).toBe(true);
  });

  it("is resolved when the remaining steps are complete or deferred", () => {
    const traversal = traverse({
      registry: linear("s1", "s2", "s3"),
      progress: progressOf(["s1"], ["s2", "s3"]),
    });
    expect(traversal.blockingStepIds).toEqual([]);
    expect(traversal.allResolved).toBe(true);
  });

  it("is not resolved while a step is not-started", () => {
    const traversal = traverse({
      registry: linear("s1", "s2"),
      progress: progressOf(["s1"]),
    });
    expect(traversal.blockingStepIds).toEqual(["s2"]);
    expect(traversal.allResolved).toBe(false);
  });

  it("is not resolved while a step is stale", () => {
    const registry = syntheticRegistry([
      { id: "s1" },
      { id: "s2", prerequisites: ["s1"] },
    ]);
    const traversal = traverse({
      registry,
      progress: progressOf(["s2"]),
    });
    expect(traversal.staleStepIds).toEqual(["s2"]);
    expect(traversal.blockingStepIds).toEqual(["s1", "s2"]);
    expect(traversal.allResolved).toBe(false);
  });

  it("is not resolved while a DEFAULTED step is outstanding (D15)", () => {
    /*
      The launch-panel half of D15, and the one that costs something: a club
      whose every check passes but whose operator has confirmed nothing does NOT
      reach D9's launch panel. That is the deliberate consequence — a fresh
      install used to arrive there having agreed to nothing.

      This replaces an F2 test (a step both stale and deferred), a combination
      D14 has made unreachable; the frontier suite pins that separately.
    */
    const registry = syntheticRegistry([{ id: "s1" }, { id: "s2" }]);
    const traversal = traverse({
      registry,
      readinessStatuses: { s1: "complete", s2: "complete" },
    });
    expect(traversal.steps.map((step) => step.isDefaulted)).toEqual([true, true]);
    expect(traversal.blockingStepIds).toEqual(["s1", "s2"]);
    expect(traversal.allResolved).toBe(false);
    expect(traversal.percentComplete).toBe(0);
  });

  it("is resolved once every defaulted step is confirmed or skipped (D15's escape)", () => {
    const registry = syntheticRegistry([{ id: "s1" }, { id: "s2" }]);
    const readinessStatuses = { s1: "complete", s2: "complete" } as const;

    // Confirming both.
    expect(
      traverse({ registry, progress: progressOf(["s1", "s2"]), readinessStatuses })
        .allResolved,
    ).toBe(true);

    // Skipping both — D4's deferral still buys passage, and the launch panel
    // states what was skipped rather than hiding it.
    expect(
      traverse({ registry, progress: progressOf([], ["s1", "s2"]), readinessStatuses })
        .allResolved,
    ).toBe(true);

    // One of each.
    expect(
      traverse({ registry, progress: progressOf(["s1"], ["s2"]), readinessStatuses })
        .allResolved,
    ).toBe(true);
  });

  it("is resolved for an empty applicable set", () => {
    const traversal = traverse({ registry: [], progress: progressOf() });
    expect(traversal.blockingStepIds).toEqual([]);
    expect(traversal.allResolved).toBe(true);
  });
});

/*
  D17's SPLIT, TESTED ON SYNTHETIC REGISTRIES (#246).

  The real-registry pins above say the split happened and in which order; these
  say what the RULE is, on registries that can be shaped to exercise it. Both
  halves matter: the real registry declares three gating facts today and cannot
  be made to declare a fourth without editing it, so the gate's own behaviour —
  each status, each `launchGate`, an environment fact contributed by a disabled
  module — has to be exercised here.
*/
describe("setup wizard traversal: the operator/environment split (D17, #246)", () => {
  const mixed = syntheticRegistry([
    { id: "s1" },
    { id: "env1", kind: "environment", launchGate: "blocks-until-complete" },
    { id: "s2" },
    { id: "env2", kind: "environment" },
  ]);

  it("is a valid registry", () => {
    expect(findSetupStepRegistryViolations(mixed)).toEqual([]);
  });

  it("walks only the operator steps, and reports the facts separately", () => {
    const traversal = traverse({ registry: mixed });
    expect(traversal.steps.map((step) => step.id)).toEqual(["s1", "s2"]);
    expect(traversal.environmentFacts.map((fact) => fact.id)).toEqual([
      "env1",
      "env2",
    ]);
  });

  it("keeps applicableStepIds WHOLE — the cards' set never narrowed", () => {
    // The one field D17 deliberately did not touch. If this ever narrows,
    // `setup-surface-registry-parity.test.ts` is the suite that will say so
    // loudest, and it will be right: the readiness cards read this.
    const traversal = traverse({ registry: mixed });
    expect(traversal.applicableStepIds).toEqual(["s1", "env1", "s2", "env2"]);
  });

  it("counts only operator steps in the percentage", () => {
    // Two of the four entries are facts, so confirming ONE of the two steps is
    // 50%, not 25%. The old denominator is the three dead screens UAT round 2
    // complained about, expressed as arithmetic.
    const traversal = traverse({
      registry: mixed,
      progress: progressOf(["s1"]),
    });
    expect(traversal.percentComplete).toBe(50);
  });

  it("resolves without any environment fact being confirmed", () => {
    // The heart of it: an operator finishes the journey by doing the things
    // they can do. Nobody has confirmed env1 or env2 and nobody ever can.
    const traversal = traverse({
      registry: mixed,
      progress: progressOf(["s1", "s2"]),
    });
    expect(traversal.allResolved).toBe(true);
    expect(traversal.blockingStepIds).toEqual([]);
    expect(traversal.outstandingStepIds).toEqual([]);
    expect(traversal.currentStepId).toBeNull();
  });

  it("never makes an environment fact stale, current, or reachable", () => {
    const traversal = traverse({ registry: mixed });
    expect(traversal.staleStepIds).toEqual([]);
    expect(traversal.currentStepId).toBe("s1");
    expect(canNavigateToSetupStep(traversal, "env1")).toBe(false);
  });

  /*
    AN ENVIRONMENT PREREQUISITE IS SILENTLY IGNORED, NOT PERMANENTLY STALE
    (C15 #246 fix round, review finding F3).

    `findSetupStepRegistryViolations` refuses this edge, and its message used to
    say the dependent would go stale forever. It would not: `computeStale…`
    narrows to `kind: "operator"` before it walks prerequisites, so an
    environment prerequisite is known-but-not-applicable and that arm returns
    false. This pins the real behaviour, which is what makes the registry
    guard's corrected message honest — and it is why that guard is worth
    having, because a declared ordering that does NOTHING surfaces nowhere.
  */
  it("ignores an environment prerequisite entirely, rather than pinning its dependent stale", () => {
    const registry = syntheticRegistry([
      { id: "env1", kind: "environment", launchGate: "blocks-until-complete" },
      { id: "s1", prerequisites: ["env1"] },
    ]);
    const traversal = traverse({
      registry,
      progress: progressOf(["s1"]),
      // The prerequisite is as unsatisfied as it can be and the dependent is
      // confirmed — the exact shape that WOULD go stale on an operator
      // prerequisite.
      readinessStatuses: { env1: "blocked", s1: "complete" },
    });

    expect(traversal.staleStepIds).toEqual([]);
    expect(traversal.steps.find((step) => step.id === "s1")?.state).toBe(
      "complete",
    );
    // …and the fact still gates the publish, which is the one thing the edge
    // does not change.
    expect(traversal.launchBlockedBy).toEqual(["env1"]);
  });

  it("drops an environment fact whose owning module is off (D4)", () => {
    // Applicability runs FIRST and the kind filter second, so a module's
    // environment fact disappears with the module exactly as its steps do.
    const registry = syntheticRegistry([
      { id: "s1" },
      {
        id: "env1",
        kind: "environment",
        ownerModule: "xeroIntegration",
        launchGate: "blocks-until-complete",
      },
    ]);
    const traversal = traverse({
      registry,
      moduleSettings: { ...ALL_MODULES_ON, xeroIntegration: false },
    });
    expect(traversal.environmentFacts).toEqual([]);
    // And it cannot hold publish shut from beyond the grave.
    expect(traversal.launchBlockedBy).toEqual([]);
    expect(traversal.applicableStepIds).toEqual(["s1"]);
  });
});

describe("setup wizard traversal: launchBlockedBy (D17, #246)", () => {
  const gated = syntheticRegistry([
    { id: "s1" },
    { id: "gate", kind: "environment", launchGate: "blocks-until-complete" },
    { id: "advisory", kind: "environment" },
  ]);

  it("blocks launch while a gating fact is not complete", () => {
    const traversal = traverse({
      registry: gated,
      readinessStatuses: { gate: "blocked", advisory: "warning" },
    });
    expect(traversal.launchBlockedBy).toEqual(["gate"]);
    expect(
      traversal.environmentFacts.find((fact) => fact.id === "gate")
        ?.blocksLaunch,
    ).toBe(true);
  });

  it.each(["blocked", "warning", "not_started"] as const)(
    "treats %s on a gating fact as blocking — anything but complete",
    (status) => {
      const traversal = traverse({
        registry: gated,
        readinessStatuses: { gate: status },
      });
      expect(traversal.launchBlockedBy).toEqual(["gate"]);
    },
  );

  it("clears once the gating fact is complete", () => {
    const traversal = traverse({
      registry: gated,
      readinessStatuses: { gate: "complete", advisory: "blocked" },
    });
    expect(traversal.launchBlockedBy).toEqual([]);
  });

  it("never blocks on an advisory fact, however bad its status", () => {
    // email-ses and sentry in the real registry: amber, and amber only. A
    // club with no error reporting is not a club that must not open.
    const traversal = traverse({
      registry: gated,
      readinessStatuses: { gate: "complete", advisory: "blocked" },
    });
    expect(
      traversal.environmentFacts.find((fact) => fact.id === "advisory")
        ?.blocksLaunch,
    ).toBe(false);
  });

  it("LEAVES allResolved ALONE — D9's three separate facts", () => {
    // The pin against the tempting simplification. Folding the gate into
    // allResolved would unmount the launch panel, taking away the one screen
    // that tells the operator what is wrong and who can fix it.
    const traversal = traverse({
      registry: gated,
      progress: progressOf(["s1"]),
      readinessStatuses: { gate: "blocked" },
    });
    expect(traversal.allResolved).toBe(true);
    expect(traversal.launchBlockedBy).toEqual(["gate"]);
  });

  it("is empty for a registry with no environment facts at all", () => {
    const traversal = traverse({ registry: linear("s1", "s2") });
    expect(traversal.environmentFacts).toEqual([]);
    expect(traversal.launchBlockedBy).toEqual([]);
  });

  it("blocks on the REAL registry's three gating facts and no others", () => {
    // The classification's consequence, read off the shipped registry: with
    // nothing green, exactly environment-role, runtime-env and
    // auth-secret-strength hold publish shut. email-ses and sentry do not.
    const traversal = buildSetupWizardTraversal({ progress: progressOf() });
    expect(traversal.launchBlockedBy).toEqual([
      "environment-role",
      "runtime-env",
      "auth-secret-strength",
    ]);
  });
});
