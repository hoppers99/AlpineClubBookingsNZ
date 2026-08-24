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
  type SetupStepOwner,
} from "@/lib/setup-step-registry";
import {
  buildSetupWizardTraversal,
  canNavigateToSetupStep,
  deriveStaleSetupStepIds,
  type SetupStepDefinitionOf,
  type SetupWizardStepState,
  type SetupWizardTraversalInput,
  type SetupWizardTraversalProgress,
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
};

/** Orders are positional, so a registry declared here always satisfies C1's sort rule. */
function syntheticRegistry(
  specs: readonly Spec[],
): readonly SetupStepDefinitionOf<string>[] {
  return specs.map((spec, index) => ({
    id: spec.id,
    ownerModule: spec.ownerModule ?? CORE_STEP_OWNER,
    prerequisites: spec.prerequisites ?? [],
    order: (index + 1) * 10,
    completion: "readiness-check" as const,
  }));
}

function linear(...ids: readonly string[]) {
  return syntheticRegistry(ids.map((id) => ({ id })));
}

function progressOf(
  completedStepIds: readonly string[] = [],
  skippedStepIds: readonly string[] = [],
): SetupWizardTraversalProgress {
  return { completedStepIds, skippedStepIds };
}

/**
 * The traversal over a synthetic registry, with module state UNKNOWN by default
 * so applicability never quietly removes a step a navigation test is about.
 */
function traverse(
  input: Omit<SetupWizardTraversalInput<string>, "progress"> & {
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
    expect(traversal.steps.map((step) => step.id)).toEqual([...SETUP_STEP_IDS]);
    expect(traversal.steps.map((step) => step.order)).toEqual(
      SETUP_STEP_REGISTRY.map((entry) => entry.order),
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
    const traversal = buildSetupWizardTraversal({
      progress: progressOf([], ["xero-operational", "xero-mappings"]),
      moduleSettings: xeroOff,
      readinessStatuses: Object.fromEntries(
        SETUP_STEP_IDS.map((id) => [id, "complete" as const]),
      ),
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
    expect(traversal.outstandingStepIds).toEqual([...SETUP_STEP_IDS]);
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

  it("reports complete for a step whose readiness check passes on its own", () => {
    const traversal = traverse({
      registry,
      readinessStatuses: { s1: "complete" },
    });
    expect(stateOf(traversal, "s1")).toBe("complete");
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

  it("honours a prerequisite satisfied by its readiness check alone", () => {
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
