import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { recomputeSetupStaleStepIds } from "@/lib/setup-progress-staleness";
import {
  SETUP_STEP_IDS,
  normalizeSetupProgress,
  type SetupStepId,
} from "@/lib/setup-readiness";

const progressSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["complete", "skip", "reopen"]),
    stepId: z.enum(SETUP_STEP_IDS),
  }),
  z.object({
    action: z.enum(["finish", "reset"]),
  }),
]);

type SetupProgressAction = z.infer<typeof progressSchema>["action"];

/**
 * One audit `action` per transition (epic #213, C4/#219).
 *
 * These used to be one row, `setup_progress.update`, distinguished only by a
 * summary reading "Setup progress skip". `AuditLog.action` is what the audit
 * log's **Event Type** filter selects on, so a single value meant an operator
 * could ask "what happened to setup progress" and never "who deferred a step",
 * and the wizard C5 builds drives far more of these than the readiness cards
 * ever did.
 *
 * CATEGORY IS UNCHANGED AND STAYS `system`. `docs/guides/audit-log.md` puts
 * "Setup, backups, platform-level events" there, and `INV-PRIV-012` files a row
 * by its affected domain — which is the club's setup, not an administrator's
 * settings — so this is deliberately NOT the `admin` an adjacent settings write
 * would take. Because the category does not move, no row changes audience and
 * `INV-OPS-012`'s backfill obligation does not arise. The rows already written
 * keep the old action value, so an Event Type filter splits at this release;
 * that is disclosed in the changelog and costs a filter choice, never a
 * permission.
 *
 * THE STALE TRANSITIONS ARE HERE TOO, as of C2 (#217), for the reason the
 * earlier note in this place gave for their absence: under D11 staleness was
 * DERIVED on read, so there was no moment at which a step BECAME stale — only a
 * request at which it was computed to be — and an audit writer on the read path
 * would have written a row per page load. Persisting the set gives the
 * transition an instant, and this route is where it happens.
 *
 * They are two more entries in the same table and two more `logAudit` calls
 * beside the one below, in the same `system` category, for the same reason the
 * five above are five values rather than one: `AuditLog.action` is what the
 * Event Type filter selects on, and "which steps went back into question, and
 * when" is a question an operator will ask separately from "who marked what
 * done". Marked-stale and stale-cleared are separate actions rather than one
 * "stale set changed", because a single request CAN do both — the set is
 * recomputed over the whole graph, so one transition can invalidate one branch
 * while a readiness check that has started passing clears another.
 */
const AUDIT_ACTION_BY_PROGRESS_ACTION: Record<SetupProgressAction, string> = {
  complete: "setup_progress.step_completed",
  skip: "setup_progress.step_deferred",
  reopen: "setup_progress.step_reopened",
  finish: "setup_progress.finished",
  reset: "setup_progress.reset",
};

const AUDIT_ACTION_STEPS_MARKED_STALE = "setup_progress.steps_marked_stale";
const AUDIT_ACTION_STEPS_STALE_CLEARED = "setup_progress.steps_stale_cleared";

/** `"a", "b"` — the same quoting the per-step summaries above use. */
function quoteStepIds(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}

function auditSummaryFor(parsed: z.infer<typeof progressSchema>): string {
  switch (parsed.action) {
    case "complete":
      return `Setup step "${parsed.stepId}" marked complete`;
    case "skip":
      return `Setup step "${parsed.stepId}" deferred for now`;
    case "reopen":
      return `Setup step "${parsed.stepId}" reopened`;
    case "finish":
      return "Setup marked finished";
    case "reset":
      return "Setup progress reset";
  }
}

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

  await logAudit({
    action: AUDIT_ACTION_BY_PROGRESS_ACTION[parsed.data.action],
    memberId: session.user.id,
    actorMemberId: session.user.id,
    category: "system",
    entityType: "SetupProgress",
    entityId: record.id,
    summary: auditSummaryFor(parsed.data),
    metadata: parsed.data,
  });

  // The two stale transitions, recorded only when the set actually MOVED. A
  // request that leaves it unchanged — which is every request on a registry
  // whose steps declare no prerequisites, i.e. every request today — writes
  // nothing here, so these rows appear when something really did go back into
  // question and never as background noise beside the transition above.
  const markedStale = record.staleStepIds.filter(
    (id) => !currentStale.includes(id),
  );
  const clearedStale = currentStale.filter(
    (id) => !record.staleStepIds.includes(id),
  );

  if (markedStale.length > 0) {
    await logAudit({
      action: AUDIT_ACTION_STEPS_MARKED_STALE,
      memberId: session.user.id,
      actorMemberId: session.user.id,
      category: "system",
      entityType: "SetupProgress",
      entityId: record.id,
      summary: `Setup steps ${quoteStepIds(markedStale)} now need another look`,
      metadata: { ...parsed.data, stepIds: markedStale },
    });
  }

  if (clearedStale.length > 0) {
    await logAudit({
      action: AUDIT_ACTION_STEPS_STALE_CLEARED,
      memberId: session.user.id,
      actorMemberId: session.user.id,
      category: "system",
      entityType: "SetupProgress",
      entityId: record.id,
      summary: `Setup steps ${quoteStepIds(clearedStale)} no longer need another look`,
      metadata: { ...parsed.data, stepIds: clearedStale },
    });
  }

  return NextResponse.json({
    progress: normalizeSetupProgress({
      completedStepIds: record.completedStepIds,
      skippedStepIds: record.skippedStepIds,
      completedAt: record.completedAt?.toISOString() ?? null,
      completedByMemberId: record.completedByMemberId,
    }),
  });
}
