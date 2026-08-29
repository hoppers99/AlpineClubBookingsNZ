import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetupDatabaseSnapshot = vi.fn();
vi.mock("@/lib/setup-readiness-db", () => ({
  getSetupDatabaseSnapshot: () => mockGetSetupDatabaseSnapshot(),
}));

const mockBuildSetupReadiness = vi.fn();
vi.mock("@/lib/setup-readiness", async (importOriginal) => {
  // PARTIAL, deliberately: `normalizeSetupProgress` is real, because the module
  // under test uses it to build the readiness input and a stub would hide the
  // fact that it filters ids the real registry does not know. Only the 1,900-line
  // readiness builder is replaced, so a synthetic registry's verdicts can be
  // stated directly instead of being conjured out of a fake database snapshot.
  const actual =
    await importOriginal<typeof import("@/lib/setup-readiness")>();
  return {
    ...actual,
    buildSetupReadiness: (...args: unknown[]) => mockBuildSetupReadiness(...args),
  };
});

const mockLoggerError = vi.fn();
vi.mock("@/lib/logger", () => ({
  default: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  recomputeSetupStaleStepIds,
  setupReadinessStatusesOf,
  storedSetupStaleStepIds,
} from "@/lib/setup-progress-staleness";
import type { SetupReadiness } from "@/lib/setup-readiness";
import { SETUP_STEP_REGISTRY } from "@/lib/setup-step-registry";
import type { SetupStepDefinitionOf } from "@/lib/setup-wizard-traversal";

/**
 * The WRITE side of setup-step staleness (epic #213, C2/#217).
 *
 * Everything about the cascade itself is C4's and is pinned by
 * `setup-wizard-traversal.test.ts`. What is tested here is what C2 added around
 * it: that the stored set is the FULL TRANSITIVE CLOSURE the seam contract
 * requires, that a set which cannot be computed comes back as `null` rather
 * than as an empty answer, that a stored set which cannot be trusted comes back
 * as `undefined` rather than as `[]`, and that the real registry yields nothing
 * stale for any progress record at all — which is what makes "no step goes
 * stale on deploy day" a measured claim rather than an assurance.
 */

/** A three-step chain: s3 depends on s2, which depends on s1. */
const CHAIN: readonly SetupStepDefinitionOf<string>[] = [
  {
    id: "s1",
    ownerModule: "core",
    kind: "operator",
    launchGate: "none",
    prerequisites: [],
    order: 10,
    completion: "readiness-check",
  },
  {
    id: "s2",
    ownerModule: "core",
    kind: "operator",
    launchGate: "none",
    prerequisites: ["s1"],
    order: 20,
    completion: "readiness-check",
  },
  {
    id: "s3",
    ownerModule: "core",
    kind: "operator",
    launchGate: "none",
    prerequisites: ["s2"],
    order: 30,
    completion: "readiness-check",
  },
];

/**
 * A readiness result carrying no passing check at all, so a step counts as
 * complete only when the operator marked it so. That is the state the write
 * path is interesting in: a step whose own check passes is complete whatever
 * the progress arrays say, and can never be the one that goes stale.
 */
function noChecksPass(): SetupReadiness {
  return { categories: [] } as unknown as SetupReadiness;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSetupDatabaseSnapshot.mockResolvedValue({ adminModuleSettings: undefined });
  mockBuildSetupReadiness.mockReturnValue(noChecksPass());
});

describe("recomputeSetupStaleStepIds (#217)", () => {
  it("stores the FULL TRANSITIVE CLOSURE, not the direct dependents", async () => {
    // s1 is outstanding, so s2 is stale; s3 depends on s2, so s3 is stale too.
    // A direct-dependents-only store would say ["s2"] and the traversal — which
    // does NOT re-cascade a supplied set — would then report s3 as complete.
    await expect(
      recomputeSetupStaleStepIds({
        progress: { completedStepIds: ["s2", "s3"], skippedStepIds: [] },
        registry: CHAIN,
      }),
    ).resolves.toEqual(["s2", "s3"]);
  });

  it("returns the empty set when the graph really is satisfied", async () => {
    await expect(
      recomputeSetupStaleStepIds({
        progress: { completedStepIds: ["s1", "s2", "s3"], skippedStepIds: [] },
        registry: CHAIN,
      }),
    ).resolves.toEqual([]);
  });

  it("does not treat a step nobody has started as stale (a step an update ADDS is not stale)", async () => {
    // Mockup 7's contract: a release that introduces s3 leaves it NOT STARTED,
    // which is a different state from stale — stale means "was done and now
    // needs another look". Nothing here is recorded complete except s1, so s3
    // being brand new must contribute nothing to the stored set.
    await expect(
      recomputeSetupStaleStepIds({
        progress: { completedStepIds: ["s1"], skippedStepIds: [] },
        registry: CHAIN,
      }),
    ).resolves.toEqual([]);
  });

  it("never subtracts from the completed set — staleness is additive bookkeeping", async () => {
    const progress = { completedStepIds: ["s2", "s3"], skippedStepIds: [] };
    await recomputeSetupStaleStepIds({ progress, registry: CHAIN });
    expect(progress.completedStepIds).toEqual(["s2", "s3"]);
  });

  it("returns null — not [] — when the set cannot be computed at all", async () => {
    mockGetSetupDatabaseSnapshot.mockRejectedValue(new Error("database unavailable"));
    await expect(
      recomputeSetupStaleStepIds({
        progress: { completedStepIds: ["s2", "s3"], skippedStepIds: [] },
        registry: CHAIN,
      }),
    ).resolves.toBeNull();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it("passes the snapshot's module flags through untouched, unknown included", async () => {
    // `undefined` means UNKNOWN and fails OPEN (every step applies). Collapsing
    // it to `{}` here would silently drop a module's steps out of the applicable
    // set and therefore out of the cascade.
    mockGetSetupDatabaseSnapshot.mockResolvedValue({ adminModuleSettings: undefined });
    await expect(
      recomputeSetupStaleStepIds({
        progress: { completedStepIds: ["s2"], skippedStepIds: [] },
        registry: CHAIN,
      }),
    ).resolves.toEqual(["s2"]);
  });

  it("yields nothing stale for the REAL registry, whatever the club has completed", async () => {
    // The deploy-day pin. Every registered step declares an empty prerequisite
    // list today, so staleness is structurally unreachable and introducing this
    // mechanism cannot mark an existing mid-checklist install's work stale.
    // A future step that declares a real prerequisite fails this test, which is
    // the intended moment to think about what the first stale set will do.
    expect(SETUP_STEP_REGISTRY.every((entry) => entry.prerequisites.length === 0)).toBe(
      true,
    );
    await expect(
      recomputeSetupStaleStepIds({
        progress: {
          completedStepIds: SETUP_STEP_REGISTRY.map((entry) => entry.id),
          skippedStepIds: [],
        },
      }),
    ).resolves.toEqual([]);
  });
});

describe("storedSetupStaleStepIds (#217 — the read side of the seam)", () => {
  it("hands back a stored array as it stands", () => {
    expect(storedSetupStaleStepIds({ staleStepIds: ["s2", "s3"] })).toEqual([
      "s2",
      "s3",
    ]);
  });

  it("distinguishes a stored empty answer from no answer", () => {
    // `[]` on the column MEANS "computed: nothing is stale", so it is passed on
    // as `[]`. That is not interchangeable with `undefined`, which asks the
    // traversal to derive.
    expect(storedSetupStaleStepIds({ staleStepIds: [] })).toEqual([]);
    expect(storedSetupStaleStepIds(null)).toBeUndefined();
    expect(storedSetupStaleStepIds(undefined)).toBeUndefined();
  });

  it("falls back to derivation rather than inventing [] when the column is malformed", () => {
    expect(storedSetupStaleStepIds({ staleStepIds: "s2" })).toBeUndefined();
    expect(storedSetupStaleStepIds({ staleStepIds: { 0: "s2" } })).toBeUndefined();
    expect(storedSetupStaleStepIds({ staleStepIds: ["s2", 7] })).toBeUndefined();
    expect(storedSetupStaleStepIds({})).toBeUndefined();
  });
});

describe("setupReadinessStatusesOf", () => {
  it("flattens every category's checks into one id-keyed record", () => {
    const readiness = {
      categories: [
        { checks: [{ id: "stripe", status: "complete" }] },
        { checks: [{ id: "sentry", status: "warning" }] },
      ],
    } as unknown as SetupReadiness;
    expect(setupReadinessStatusesOf(readiness)).toEqual({
      stripe: "complete",
      sentry: "warning",
    });
  });
});
