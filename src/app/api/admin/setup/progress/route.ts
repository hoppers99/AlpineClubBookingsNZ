import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
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
 * NO STALE TRANSITION IS RECORDED, AND THAT IS A LIMIT RATHER THAN AN OMISSION.
 * #219 asks for one, but under D11 staleness is DERIVED on read: there is no
 * moment at which a step becomes stale, only a request at which it is computed
 * to be, so a writer here would have nothing to fire on and one on the read
 * path would write a row per page load. It becomes a real transition when C2
 * (#217) persists the state, and belongs to that child.
 */
const AUDIT_ACTION_BY_PROGRESS_ACTION: Record<SetupProgressAction, string> = {
  complete: "setup_progress.step_completed",
  skip: "setup_progress.step_deferred",
  reopen: "setup_progress.step_reopened",
  finish: "setup_progress.finished",
  reset: "setup_progress.reset",
};

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

  const record = await prisma.setupProgress.upsert({
    where: { id: "default" },
    update: {
      completedStepIds,
      skippedStepIds,
      completedAt,
      completedByMemberId,
    },
    create: {
      id: "default",
      completedStepIds,
      skippedStepIds,
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

  return NextResponse.json({
    progress: normalizeSetupProgress({
      completedStepIds: record.completedStepIds,
      skippedStepIds: record.skippedStepIds,
      completedAt: record.completedAt?.toISOString() ?? null,
      completedByMemberId: record.completedByMemberId,
    }),
  });
}
