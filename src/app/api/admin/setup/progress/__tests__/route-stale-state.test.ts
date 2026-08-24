import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    setupProgress: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

const mockGetSetupDatabaseSnapshot = vi.fn();
vi.mock("@/lib/setup-readiness-db", () => ({
  getSetupDatabaseSnapshot: () => mockGetSetupDatabaseSnapshot(),
}));

// Silenced rather than asserted: the failed-recompute cases below deliberately
// reject, and the real logger would print a stack per case. That the failure IS
// logged is pinned in `setup-progress-staleness.test.ts`.
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockBuildSetupReadiness = vi.fn();
vi.mock("@/lib/setup-readiness", async (importOriginal) => {
  // Partial: `normalizeSetupProgress` and `SETUP_STEP_IDS` stay real, so the
  // route's own zod validation and id filtering are the production ones. Only
  // the readiness builder is stubbed, because a synthetic prerequisite graph
  // needs its verdicts stated rather than conjured from a fake snapshot.
  const actual = await importOriginal<typeof import("@/lib/setup-readiness")>();
  return {
    ...actual,
    buildSetupReadiness: () => mockBuildSetupReadiness(),
  };
});

/**
 * A prerequisite graph over the REAL step ids.
 *
 * `stripe` depends on `age-tiers`, and `sentry` depends on `stripe`, with every
 * entry keeping its real `ownerModule` and `order` (the registry declares those
 * three in that order, so the "a prerequisite is presented before its dependent"
 * rule still holds). Real ids matter here: the route validates its body with
 * `z.enum(SETUP_STEP_IDS)` and `normalizeSetupProgress` drops ids the registry
 * does not know, so a synthetic `s1`/`s2`/`s3` chain could not reach the code
 * under test at all. This is the only way to exercise the write path end to end
 * while every real step still declares an empty prerequisite list.
 */
vi.mock("@/lib/setup-step-registry", async (importOriginal) => {
  // Declared INSIDE the factory: `vi.mock` is hoisted above every top-level
  // binding in this file, so a module-scope constant read here is a temporal
  // dead-zone error at import time rather than at assertion time.
  const prerequisites: Record<string, readonly string[]> = {
    stripe: ["age-tiers"],
    sentry: ["stripe"],
  };
  const actual =
    await importOriginal<typeof import("@/lib/setup-step-registry")>();
  return {
    ...actual,
    SETUP_STEP_REGISTRY: actual.SETUP_STEP_REGISTRY.map((entry) => ({
      ...entry,
      prerequisites: prerequisites[entry.id] ?? entry.prerequisites,
    })),
  };
});

import { PATCH } from "@/app/api/admin/setup/progress/route";
import type { SetupReadiness } from "@/lib/setup-readiness";

/**
 * Setup-step staleness through the FULL write path (epic #213, C2/#217).
 *
 * `setup-progress-staleness.test.ts` covers the computation. This file covers
 * what the ROUTE does with it: what lands in `staleStepIds`, that
 * `completedStepIds` is never reduced by it, that the record-level
 * "Setup Complete" flag reverts while anything is stale and is never quietly
 * put back, that the two stale transitions are audited only when the set really
 * moves, and that a set which could not be computed refuses the whole
 * transition rather than being replaced with an answer nobody computed.
 */

function patch(body: unknown) {
  return new NextRequest("http://localhost/api/admin/setup/progress", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function persisted() {
  expect(mockUpsert).toHaveBeenCalledTimes(1);
  return mockUpsert.mock.calls[0][0].update as Record<string, unknown>;
}

function auditFor(action: string) {
  const call = mockLogAudit.mock.calls.find(
    ([event]) => (event as { action: string }).action === action,
  );
  return (call?.[0] ?? null) as Record<string, unknown> | null;
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

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true as const,
    session: { user: { id: "admin1" } },
  });
  mockFindUnique.mockResolvedValue(storedRow());
  mockUpsert.mockImplementation(
    async (args: { update: Record<string, unknown> }) => ({
      ...storedRow(),
      ...args.update,
    }),
  );
  mockGetSetupDatabaseSnapshot.mockResolvedValue({
    // UNKNOWN module flags fail open, so every step in the registry applies and
    // the graph above is exercised whatever a club has switched off.
    adminModuleSettings: undefined,
  });
  // No check passes on its own, so a step is complete only where the operator
  // marked it — which is the state staleness is about.
  mockBuildSetupReadiness.mockReturnValue({
    categories: [],
  } as unknown as SetupReadiness);
});

describe("PATCH /api/admin/setup/progress — stale state (#217)", () => {
  it("persists the full transitive closure when a prerequisite is reopened", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({ completedStepIds: ["age-tiers", "stripe", "sentry"] }),
    );

    const response = await PATCH(patch({ action: "reopen", stepId: "age-tiers" }));
    expect(response.status).toBe(200);

    // `stripe` depends on the reopened step; `sentry` depends on `stripe`, so it
    // is stale too. Storing only the direct dependent would leave the traversal
    // reporting `sentry` as complete — it does not re-cascade a supplied set.
    expect(persisted().staleStepIds).toEqual(["stripe", "sentry"]);
  });

  it("never clears the completion record when it marks a step stale", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({ completedStepIds: ["age-tiers", "stripe", "sentry"] }),
    );
    await PATCH(patch({ action: "reopen", stepId: "age-tiers" }));

    // AC 4: the reopened step leaves the completed set because the OPERATOR
    // reopened it; `stripe` and `sentry` stay in it and are merely flagged.
    expect(persisted().completedStepIds).toEqual(["stripe", "sentry"]);
  });

  it("clears the stale flag when the prerequisite is settled again, with no re-entry", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["stripe", "sentry"],
        staleStepIds: ["stripe", "sentry"],
      }),
    );

    await PATCH(patch({ action: "complete", stepId: "age-tiers" }));

    expect(persisted().staleStepIds).toEqual([]);
    // "Returns to complete without re-entry": nothing had to be done to
    // `stripe` or `sentry` themselves, and they are still recorded complete.
    expect(persisted().completedStepIds).toEqual([
      "stripe",
      "sentry",
      "age-tiers",
    ]);
  });

  it("reverts the record-level completed flag while anything is stale, finish included", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["stripe", "sentry"],
        staleStepIds: ["stripe", "sentry"],
      }),
    );

    await PATCH(patch({ action: "finish" }));

    // The readiness cards render "Setup Complete" from `completedAt`. A club
    // with outstanding stale work must not be told it has finished.
    expect(persisted().completedAt).toBeNull();
    expect(persisted().completedByMemberId).toBeNull();
  });

  it("still stamps the record when nothing is stale", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({ completedStepIds: ["age-tiers", "stripe", "sentry"] }),
    );

    await PATCH(patch({ action: "finish" }));

    expect(persisted().staleStepIds).toEqual([]);
    expect(persisted().completedAt).toBeInstanceOf(Date);
    expect(persisted().completedByMemberId).toBe("admin1");
  });

  it("records the marked-stale transition under its own event type", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({ completedStepIds: ["age-tiers", "stripe", "sentry"] }),
    );

    await PATCH(patch({ action: "reopen", stepId: "age-tiers" }));

    expect(auditFor("setup_progress.steps_marked_stale")).toMatchObject({
      category: "system",
      memberId: "admin1",
      actorMemberId: "admin1",
      entityType: "SetupProgress",
      entityId: "default",
      summary: 'Setup steps "stripe", "sentry" now need another look',
      metadata: {
        action: "reopen",
        stepId: "age-tiers",
        stepIds: ["stripe", "sentry"],
      },
    });
    // The transition that caused it is still recorded on its own account.
    expect(auditFor("setup_progress.step_reopened")).not.toBeNull();
  });

  it("records the stale-cleared transition under a different event type", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["stripe", "sentry"],
        staleStepIds: ["stripe", "sentry"],
      }),
    );

    await PATCH(patch({ action: "complete", stepId: "age-tiers" }));

    expect(auditFor("setup_progress.steps_stale_cleared")).toMatchObject({
      category: "system",
      summary: 'Setup steps "stripe", "sentry" no longer need another look',
      metadata: { stepIds: ["stripe", "sentry"] },
    });
    expect(auditFor("setup_progress.steps_marked_stale")).toBeNull();
  });

  it("records no stale transition at all when the set does not move", async () => {
    await PATCH(patch({ action: "complete", stepId: "age-tiers" }));

    // Which is every request on the real registry, where no step declares a
    // prerequisite: these rows appear when something really did go back into
    // question, never as background noise beside every transition.
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(auditFor("setup_progress.step_completed")).not.toBeNull();
  });

  it("records no stale transition when a NON-EMPTY set survives a successful recompute unchanged", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["stripe", "sentry"],
        staleStepIds: ["stripe", "sentry"],
      }),
    );

    // Unrelated to the graph: `club-config` has no prerequisites and is nobody's
    // prerequisite, so the recompute RUNS, succeeds, and returns the same set.
    await PATCH(patch({ action: "complete", stepId: "club-config" }));

    expect(persisted().staleStepIds).toEqual(["stripe", "sentry"]);
    // The pair above only covers a set that moved from empty. Without these two
    // the suite passes on a route that re-announces the whole standing stale set
    // on every unrelated click — one audit row per step, per click, for as long
    // as the staleness lasts. The rows record the set MOVING, not its being
    // non-empty.
    expect(auditFor("setup_progress.steps_marked_stale")).toBeNull();
    expect(auditFor("setup_progress.steps_stale_cleared")).toBeNull();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
  });

  it("cascades staleness when a prerequisite is DEFERRED rather than reopened", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({ completedStepIds: ["age-tiers", "stripe", "sentry"] }),
    );

    await PATCH(patch({ action: "skip", stepId: "age-tiers" }));

    // D4 fixed the meaning of the two existing arrays — `skippedStepIds` holds
    // genuine deferrals only — and left unstated what deferring a PREREQUISITE
    // does to the steps above it. The answer this ships, recorded here because
    // nothing else states it: DEFERRING INVALIDATES ITS DEPENDENTS, and it does
    // so without changing what either array means. `skip` removes the step from
    // `completedStepIds`, and `isSetupStepComplete` treats a skipped step as not
    // complete, so an unsatisfied prerequisite falls out of the rules already
    // there rather than needing one of its own. The alternative — treating a
    // deferral as "settled enough" — would let a club defer the step everything
    // hangs off and see no consequence anywhere.
    expect(persisted().skippedStepIds).toEqual(["age-tiers"]);
    expect(persisted().completedStepIds).toEqual(["stripe", "sentry"]);
    expect(persisted().staleStepIds).toEqual(["stripe", "sentry"]);
    expect(auditFor("setup_progress.step_deferred")).not.toBeNull();
  });

  it("does not restore the completion record when the stale set empties", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["stripe", "sentry"],
        staleStepIds: ["stripe", "sentry"],
        completedAt: new Date("2026-06-01T00:00:00.000Z"),
        completedByMemberId: "admin0",
      }),
    );

    await PATCH(patch({ action: "complete", stepId: "age-tiers" }));

    // #217's resolution amendment: `completedAt` does NOT auto-restore when the
    // stale set empties — `finish` remains its only writer, which is the
    // pre-existing semantics and is the club rather than the software deciding
    // it has finished. Settling the prerequisite clears the staleness and leaves
    // the record incomplete until an administrator finishes setup again.
    //
    // The stored row here is also the one shape that can really carry a stamped
    // `completedAt` beside a non-empty stale set: a release predating #217
    // serving a `finish` during a blue/green drain. This pins that the new code
    // does not adopt that stamp on its way past.
    expect(persisted().staleStepIds).toEqual([]);
    expect(persisted().completedAt).toBeNull();
    expect(persisted().completedByMemberId).toBeNull();
  });

  it("records WHY a finish did not take effect, on the finish row itself", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["stripe", "sentry"],
        staleStepIds: ["stripe", "sentry"],
      }),
    );

    await PATCH(patch({ action: "finish" }));

    // The set did not move, so neither stale row is written — and without the
    // blocking list on the finish row itself the trail would read "Setup marked
    // finished" against a record that is not marked finished, with nothing
    // anywhere saying why.
    expect(auditFor("setup_progress.finished")).toMatchObject({
      metadata: { action: "finish", staleStepIds: ["stripe", "sentry"] },
    });
    expect(auditFor("setup_progress.steps_marked_stale")).toBeNull();
  });

  it("leaves the finish row unadorned when the finish really did take effect", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({ completedStepIds: ["age-tiers", "stripe", "sentry"] }),
    );

    await PATCH(patch({ action: "finish" }));

    // The blocking list is present only when there was something to explain.
    expect(auditFor("setup_progress.finished")?.metadata).toEqual({
      action: "finish",
    });
  });

  it("refuses the whole transition — writing and recording nothing — when the recompute cannot run", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["stripe", "sentry"],
        staleStepIds: ["stripe", "sentry"],
      }),
    );
    mockGetSetupDatabaseSnapshot.mockRejectedValue(new Error("no database"));

    const response = await PATCH(patch({ action: "complete", stepId: "age-tiers" }));

    // AC 6 as #217's resolution amendment settled it. `[]` on this column means
    // "computed: nothing is stale", so a recompute that did not run has NO value
    // it may honestly write — and carrying the previously stored set forward is
    // no better, because that set was computed against the arrays this very
    // request replaces. So the route writes nothing, records nothing, and says
    // why. An earlier version of this file asserted the safe HALF of that
    // fallback and passed while the dangerous half (below) shipped inverted.
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("nothing was changed"),
    });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refuses rather than writing [] when the failed transition is the one CREATING staleness", async () => {
    // The dangerous direction, and the one the `?? currentStale` fallback got
    // exactly wrong. The stored set is empty, so falling back to it wrote `[]` —
    // an assertion that nothing is stale, made about the one request whose whole
    // effect is to make `stripe` and `sentry` stale. Fail-toward-complete, which
    // is AC 6 inverted rather than merely unmet.
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["age-tiers", "stripe", "sentry"],
        staleStepIds: [],
      }),
    );
    mockGetSetupDatabaseSnapshot.mockRejectedValue(new Error("no database"));

    const response = await PATCH(patch({ action: "reopen", stepId: "age-tiers" }));

    expect(response.status).toBe(503);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("empties the stale set on reset even when the recompute cannot run", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["stripe", "sentry"],
        staleStepIds: ["stripe", "sentry"],
      }),
    );
    mockGetSetupDatabaseSnapshot.mockRejectedValue(new Error("no database"));

    await PATCH(patch({ action: "reset" }));

    // Nothing is recorded complete after a reset, so nothing CAN be stale. That
    // is a computed answer rather than a guess, which is why it does not depend
    // on the recompute succeeding.
    expect(persisted().completedStepIds).toEqual([]);
    expect(persisted().staleStepIds).toEqual([]);
    expect(mockGetSetupDatabaseSnapshot).not.toHaveBeenCalled();
  });

  it("writes the stale set on the create branch of the upsert as well", async () => {
    mockFindUnique.mockResolvedValue(null);

    await PATCH(patch({ action: "complete", stepId: "age-tiers" }));

    const create = mockUpsert.mock.calls[0][0].create as Record<string, unknown>;
    expect(create.staleStepIds).toEqual([]);
  });
});
