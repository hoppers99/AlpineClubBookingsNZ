import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLogAudit = vi.fn();
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import {
  recordSetupProgressTransition,
  type RecordSetupProgressTransitionInput,
} from "@/lib/setup-progress-audit";

/**
 * The audit layer's own withheld-finish branch (epic #213, C4/#219 and C16/#247).
 *
 * `route-audit.test.ts` covers what an ordinary transition records, through the
 * route. This file exists for the one thing the route can no longer reach: since
 * #247 a `finish` arriving with a non-empty stale set is REFUSED before the
 * write, so `recordSetupProgressTransition` is never called with that
 * combination and the branch that explains a withheld completion became
 * unreachable from out there.
 *
 * The branch is kept as defence in depth — it is the audit layer's copy of an
 * inherited acceptance criterion, and the gate above it is the half that can
 * narrow (C15 narrows the blocking set; a later child could narrow it further).
 * Coverage has to move down here with it. The alternative was deleting the
 * assertion along with the route-level case, which is how a branch nobody can
 * currently reach quietly stops working before the day it is reachable again.
 *
 * Same shape as `route-finish-gate.test.ts`'s escape-hatch test, one layer
 * lower: state the impossible combination directly, and pin what the code does
 * with it.
 */

function input(
  overrides: Partial<RecordSetupProgressTransitionInput> = {},
): RecordSetupProgressTransitionInput {
  return {
    payload: { action: "finish" },
    actorMemberId: "admin1",
    entityId: "default",
    previousStaleStepIds: [],
    nextStaleStepIds: [],
    ...overrides,
  };
}

function auditFor(action: string) {
  const call = mockLogAudit.mock.calls.find(
    ([event]) => (event as { action: string }).action === action,
  );
  return (call?.[0] as Record<string, unknown>) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordSetupProgressTransition — the withheld-finish row (#219/#247)", () => {
  it("explains a finish that did not take effect, on the finish row itself", async () => {
    // THE COMBINATION THE ROUTE CAN NO LONGER PRODUCE. `stale ⊆ blocking` holds
    // by construction, so the finish gate refuses this request and never writes
    // — which means it never records either. If a future change narrows the
    // blocking set below the stale set, blocked finishes start landing again,
    // and without this the trail would read "Setup marked finished" against a
    // record that is not marked finished with nothing anywhere saying why.
    recordSetupProgressTransition(
      input({
        payload: { action: "finish" },
        previousStaleStepIds: ["stripe", "sentry"],
        nextStaleStepIds: ["stripe", "sentry"],
      }),
    );

    expect(auditFor("setup_progress.finished")).toMatchObject({
      category: "system",
      entityType: "SetupProgress",
      metadata: { action: "finish", staleStepIds: ["stripe", "sentry"] },
    });
    // The set did not MOVE, so neither stale row is written. The explanation
    // travels on the finish row precisely because those two would not be there.
    expect(auditFor("setup_progress.steps_marked_stale")).toBeNull();
    expect(auditFor("setup_progress.steps_stale_cleared")).toBeNull();
  });

  it("leaves the finish row unadorned when the finish really did take effect", async () => {
    recordSetupProgressTransition(input({ nextStaleStepIds: [] }));

    const row = auditFor("setup_progress.finished");
    expect(row?.metadata).toEqual({ action: "finish" });
    expect(row?.metadata).not.toHaveProperty("staleStepIds");
  });

  it.each(["complete", "skip", "reopen"] as const)(
    "never adorns a %s row, whatever the stale set holds",
    async (action) => {
      // The explanation is specific to a finish whose completion was withheld.
      // The other transitions null `completedAt` themselves and claim nothing
      // that a stale set could contradict, so a `staleStepIds` key here would be
      // noise on every stale club's every click.
      recordSetupProgressTransition(
        input({
          payload: { action, stepId: "site-style" },
          previousStaleStepIds: ["stripe"],
          nextStaleStepIds: ["stripe"],
        }),
      );

      const row = auditFor(`setup_progress.step_${
        { complete: "completed", skip: "deferred", reopen: "reopened" }[action]
      }`);
      expect(row?.metadata).toEqual({ action, stepId: "site-style" });
    },
  );
});
