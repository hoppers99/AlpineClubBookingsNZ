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
    // FAIL TOWARD STALE (#217 AC 6). A set that could not be computed is not an
    // empty set: storing `[]` would assert "nothing is stale", which is the one
    // claim this route does not have evidence for. Keeping what was already
    // stored never clears staleness on the strength of a failed read, and the
    // operator's transition still goes through.
    staleStepIds = recomputed ?? currentStale;
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
