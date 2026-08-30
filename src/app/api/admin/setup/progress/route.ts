import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { recordSetupProgressTransition } from "@/lib/setup-progress-audit";
import { refuseOrDeriveSetupProgress } from "@/lib/setup-progress-finish-gate";
import {
  SETUP_STEP_IDS,
  normalizeSetupProgress,
  type SetupStepId,
} from "@/lib/setup-readiness";
import { SETUP_STEP_REGISTRY } from "@/lib/setup-step-registry";

/**
 * The setup wizard's one write (epic #213, C4/#219 and C2/#217).
 *
 * Five transitions the operator can ask for, and one derived answer they cannot:
 * `staleStepIds`, which this route recomputes from the step registry's
 * prerequisite graph on every write.
 *
 * Three of those five name a step, and since D17 (C15 #246) they are refused
 * with 422 on an ENVIRONMENT id — see `ENVIRONMENT_STEP_IDS` below for why the
 * schema still accepts the id and this handler still turns it down. What gets RECORDED about any of it lives in
 * `setup-progress-audit.ts`; how the stale set is computed, and which way each
 * failure falls, lives in `setup-progress-staleness.ts`.
 *
 * ## Two refusals, one shape (C2/#217 and C16/#247)
 *
 * `finish` is the one transition whose truth the server can check, and since
 * #247 it does: it refuses while any applicable step is neither complete nor
 * deliberately deferred. The other four are the operator's own bookkeeping about
 * their own checklist and are not second-guessed. Both refusals — the stale
 * recompute's 503 and the finish gate's 409 — write nothing, record nothing, and
 * say why, so a refused request leaves the row exactly as it found it. Both, and
 * the reasoning that keeps them the right way round, live in
 * `setup-progress-finish-gate.ts`; this handler asks once, before it writes.
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

/**
 * The ids nobody may confirm, skip or reopen (epic #213, **D17**, C15 #246).
 *
 * `SETUP_STEP_IDS` stays WHOLE — its literal-tuple-ness is load-bearing for the
 * `z.enum` above — so the schema still accepts `runtime-env` as a syntactically
 * valid id and this is the semantic half of the answer. It is a real refusal
 * rather than tidiness: the traversal would ignore the resulting id anyway, but
 * `recordSetupProgressTransition` would still write an audit row saying somebody
 * confirmed a fact nobody is able to confirm, and an audit log that records
 * impossible events is worse than one that records fewer. Nothing in the shipped
 * UI can send one, so a request carrying one is a stale client or a hand-rolled
 * call.
 *
 * 422 rather than 400: the body is well formed and the id is real; what is wrong
 * is the request's MEANING. Derived from the registry rather than listed, so a
 * reclassification cannot leave this set behind.
 */
const ENVIRONMENT_STEP_IDS: ReadonlySet<string> = new Set(
  SETUP_STEP_REGISTRY.filter((entry) => entry.kind === "environment").map(
    (entry) => entry.id,
  ),
);

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

  if (
    "stepId" in parsed.data &&
    ENVIRONMENT_STEP_IDS.has(parsed.data.stepId)
  ) {
    return NextResponse.json(
      {
        error:
          "That is a fact about the server this site runs on, not a step to complete — it is reported in the wizard's Server environment panel and is changed by whoever runs the server.",
      },
      { status: 422 },
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

  // The stale recompute and the finish gate, in that order, over the arrays as
  // they are about to be stored — `setup-progress-finish-gate.ts` holds both and
  // the reasoning for each. A refusal comes back fully formed and is returned
  // unchanged: nothing below this line runs, so no row moves and no audit row is
  // written for a transition that did not happen.
  const gate = await refuseOrDeriveSetupProgress({
    action: parsed.data.action,
    progress: { completedStepIds, skippedStepIds },
  });
  if (!gate.ok) return gate.refusal;
  const staleStepIds = gate.staleStepIds;

  // The record-level "Setup Complete" flag reverts while anything is stale
  // (#217's inherited acceptance criterion). The readiness cards render
  // "Setup Complete" from `completedAt`, and a club with outstanding stale work
  // must not be told it has finished. It is applied AFTER the switch above so it
  // covers `finish` as well: finishing while a step needs another look records
  // the transition and leaves the record incomplete, rather than stamping a
  // completion the wizard's own launch panel would refuse to offer.
  //
  // C16 (#247) SUBSUMES IT FOR `finish` AND IT STAYS ANYWAY. Every stale step is
  // a blocking step (`setup-progress-staleness.ts` states why that holds by
  // construction), so a `finish` carrying a non-empty stale set is refused by
  // `refuseOrDeriveSetupProgress` above and never reaches this line; and every
  // other action already nulled `completedAt` in the switch. So this is
  // currently unreachable — kept, not deleted, because it is the LAST line of
  // defence on an inherited acceptance criterion and the finish gate is the one
  // that can narrow. C15 narrows the blocking set; a future child could narrow
  // it further. If either ever narrows it below the stale set, this is what
  // still stops a stale record being stamped complete, and two lines is a cheap
  // place to be wrong.
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
