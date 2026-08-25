import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { recordSetupProgressTransition } from "@/lib/setup-progress-audit";
import { recomputeSetupStaleStepIds } from "@/lib/setup-progress-staleness";
import {
  SETUP_STEP_IDS,
  normalizeSetupProgress,
  type SetupStepId,
} from "@/lib/setup-readiness";

/**
 * The setup wizard's one write (epic #213, C4/#219 and C2/#217).
 *
 * Five transitions the operator can ask for, and one derived answer they cannot:
 * `staleStepIds`, which this route recomputes from the step registry's
 * prerequisite graph on every write. What gets RECORDED about any of it lives in
 * `setup-progress-audit.ts`; how the stale set is computed, and which way each
 * failure falls, lives in `setup-progress-staleness.ts`.
 *
 * ## The read-modify-write window, and why it stays unguarded
 *
 * This handler reads the row, computes the next state in application code, and
 * writes it back, with no lock and no transaction spanning the two. That is
 * PRE-EXISTING and last-writer-wins was already the behaviour before #217; what
 * #217 changes is the WIDTH of the window, because the stale recompute — a wide
 * database snapshot plus a full readiness pass — now sits between the read and
 * the write where previously there was only a handful of array operations.
 *
 * Left unguarded deliberately. Two administrators clicking different setup steps
 * within the same window lose one of the two clicks: the loser's step keeps its
 * previous state on a screen that re-reads it, and the operator clicks again.
 * There is no money, no capacity, no allocation and no permission on this path,
 * and the row is one deployment-local checklist. See the PR's concurrency
 * declaration for the full argument against a `FOR UPDATE` here.
 */

const progressSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["complete", "skip", "reopen"]),
    stepId: z.enum(SETUP_STEP_IDS),
  }),
  z.object({
    action: z.enum(["finish", "reset"]),
  }),
]);

function withoutStep(ids: string[], stepId: SetupStepId) {
  return ids.filter((id) => id !== stepId);
}

export async function PATCH(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = progressSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.setupProgress.findUnique({
    where: { id: "default" },
  });
  const currentCompleted = existing?.completedStepIds ?? [];
  const currentSkipped = existing?.skippedStepIds ?? [];
  const currentStale = existing?.staleStepIds ?? [];
  let completedStepIds = currentCompleted;
  let skippedStepIds = currentSkipped;
  let completedAt = existing?.completedAt ?? null;
  let completedByMemberId = existing?.completedByMemberId ?? null;

  switch (parsed.data.action) {
    case "reset":
      completedStepIds = [];
      skippedStepIds = [];
      completedAt = null;
      completedByMemberId = null;
      break;
    case "finish":
      completedAt = new Date();
      completedByMemberId = session.user.id;
      break;
    case "complete":
      completedStepIds = Array.from(
        new Set([...withoutStep(currentCompleted, parsed.data.stepId), parsed.data.stepId]),
      );
      skippedStepIds = withoutStep(currentSkipped, parsed.data.stepId);
      completedAt = null;
      completedByMemberId = null;
      break;
    case "skip":
      completedStepIds = withoutStep(currentCompleted, parsed.data.stepId);
      skippedStepIds = Array.from(
        new Set([...withoutStep(currentSkipped, parsed.data.stepId), parsed.data.stepId]),
      );
      completedAt = null;
      completedByMemberId = null;
      break;
    case "reopen":
      completedStepIds = withoutStep(currentCompleted, parsed.data.stepId);
      skippedStepIds = withoutStep(currentSkipped, parsed.data.stepId);
      completedAt = null;
      completedByMemberId = null;
      break;
  }

  // C2 (#217): recompute the WHOLE stale set from the prerequisite graph, over
  // the arrays as they are about to be stored. Not patched incrementally — see
  // `setup-progress-staleness.ts` for why re-deriving on every write is what
  // keeps a corrupted or out-of-date row self-healing, and why the set has to be
  // the full transitive closure rather than the direct dependents of whichever
  // step this request touched.
  //
  // `reset` is settled here rather than by the recompute: nothing is recorded
  // complete afterwards, so nothing CAN be stale, and that is a computed answer
  // rather than a guess — it holds even when the recompute below cannot run.
  let staleStepIds: readonly string[];
  if (parsed.data.action === "reset") {
    staleStepIds = [];
  } else {
    const recomputed = await recomputeSetupStaleStepIds({
      progress: { completedStepIds, skippedStepIds },
    });
    // FAIL TOWARD STALE (#217 AC 6), BY REFUSING THE WHOLE TRANSITION — the
    // AC-6 resolution amendment on #217. `[]` on this column asserts "computed:
    // nothing is stale", so a recompute that could not run has no value it may
    // honestly write: `[]` inverts the acceptance criterion outright, and
    // carrying the PREVIOUS set forward is no better, because it was computed
    // against the arrays this request is replacing and would be stored beside
    // arrays it does not describe. So nothing is written, nothing is audited,
    // and the operator is told why. The failure is retryable by construction and
    // the refusal is the consistent answer rather than a new one: the same
    // snapshot read backs the wizard's own GET, which is already failing
    // whenever this is.
    if (recomputed === null) {
      return NextResponse.json(
        {
          error:
            "The setup snapshot could not be read; nothing was changed — try again",
        },
        { status: 503 },
      );
    }
    staleStepIds = recomputed;
  }

  // The record-level "Setup Complete" flag reverts while anything is stale
  // (#217's inherited acceptance criterion). The readiness cards render
  // "Setup Complete" from `completedAt`, and a club with outstanding stale work
  // must not be told it has finished. It is applied AFTER the switch above so it
  // covers `finish` as well: finishing while a step needs another look records
  // the transition and leaves the record incomplete, rather than stamping a
  // completion the wizard's own launch panel would refuse to offer.
  if (staleStepIds.length > 0) {
    completedAt = null;
    completedByMemberId = null;
  }

  const record = await prisma.setupProgress.upsert({
    where: { id: "default" },
    update: {
      completedStepIds,
      skippedStepIds,
      staleStepIds: [...staleStepIds],
      completedAt,
      completedByMemberId,
    },
    create: {
      id: "default",
      completedStepIds,
      skippedStepIds,
      staleStepIds: [...staleStepIds],
      completedAt,
      completedByMemberId,
    },
  });

  // Recorded only after the row is written, so a transition that never landed
  // records nothing. The two stale rows come with it when the set actually
  // moved — see `setup-progress-audit.ts`.
  recordSetupProgressTransition({
    payload: parsed.data,
    actorMemberId: session.user.id,
    entityId: record.id,
    previousStaleStepIds: currentStale,
    nextStaleStepIds: record.staleStepIds,
  });

  return NextResponse.json({
    progress: normalizeSetupProgress({
      completedStepIds: record.completedStepIds,
      skippedStepIds: record.skippedStepIds,
      completedAt: record.completedAt?.toISOString() ?? null,
      completedByMemberId: record.completedByMemberId,
    }),
  });
}
