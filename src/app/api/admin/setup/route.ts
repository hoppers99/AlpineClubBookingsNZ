import { NextResponse } from "next/server";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  setupReadinessStatusesOf,
  storedSetupStaleStepIds,
} from "@/lib/setup-progress-staleness";
import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";
import {
  buildSetupReadiness,
  normalizeSetupProgress,
} from "@/lib/setup-readiness";
import { buildSetupWizardTraversal } from "@/lib/setup-wizard-traversal";

/**
 * The readiness checklist's read.
 *
 * ## Why a wizard number rides on the CHECKLIST's payload (#237 fix round)
 *
 * D7 makes the wizard the single owner of "how far through is this club", and
 * `/admin/setup`'s Progress tile used to answer the same question its own way:
 * `status === "complete" || progress === "completed"` over the checks — the very
 * union D14 split apart. One click apart, the two surfaces reported 56% and 0%
 * for the same fresh install.
 *
 * So the tile no longer derives anything. It renders `wizardPercentComplete`,
 * which is `buildSetupWizardTraversal`'s own `percentComplete` — the same
 * function, over the same inputs, on the same server that answers the wizard's
 * read. The alternative, replicating "confirmed and not stale" in the browser,
 * is the second derivation `/api/admin/setup/wizard`'s docblock declines for the
 * frontier, and it would have to invent the stale set, which this payload does
 * not carry.
 *
 * The four inputs below are DELIBERATELY IDENTICAL to that route's, and
 * `route-progress-parity.test.ts` drives both handlers over one set of doubles
 * and fails if the two numbers ever differ. That test is the guard; this comment
 * is the reason. A Next.js route file may export only handlers, so the shared
 * construction cannot be lifted into one of them and called from the other.
 *
 * The readiness CARDS keep their own status wording, and that is not the same
 * question: a check reads "complete" when the installation is configured, which
 * a shipped default genuinely is. Only the percentage-shaped answer moved.
 */

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const [database, progressRecord] = await Promise.all([
    getSetupDatabaseSnapshot(),
    prisma.setupProgress.findUnique({ where: { id: "default" } }),
  ]);
  const progress = normalizeSetupProgress(
    progressRecord
      ? {
          completedStepIds: progressRecord.completedStepIds,
          skippedStepIds: progressRecord.skippedStepIds,
          completedAt: progressRecord.completedAt?.toISOString() ?? null,
          completedByMemberId: progressRecord.completedByMemberId,
        }
      : null,
  );

  const readiness = buildSetupReadiness({
    database,
    progress,
  });

  return NextResponse.json({
    readiness,
    progress,
    wizardPercentComplete: buildSetupWizardTraversal({
      progress,
      moduleSettings: database.adminModuleSettings,
      readinessStatuses: setupReadinessStatusesOf(readiness),
      staleStepIds: storedSetupStaleStepIds(progressRecord),
    }).percentComplete,
  });
}
