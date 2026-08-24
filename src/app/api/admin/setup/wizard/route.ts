import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";
import {
  buildSetupReadiness,
  normalizeSetupProgress,
  type SetupReadiness,
} from "@/lib/setup-readiness";
import type { SetupStepId } from "@/lib/setup-step-registry";
import {
  buildSetupWizardTraversal,
  type SetupWizardTraversal,
  type SetupWizardTraversalInput,
} from "@/lib/setup-wizard-traversal";

/**
 * The wizard shell's single read (epic #213, child C5).
 *
 * `/api/admin/setup` already returns readiness + progress for the readiness
 * cards. The wizard needs one more thing the cards never did — C4's TRAVERSAL,
 * which is the only source of per-step state, reachability and the D7
 * percentage — and it needs the module flags applied, which the cards do not do
 * until C8. So this is a second, additive route rather than a widened payload:
 * the cards' response shape stays exactly as it is (C8 owns their transition,
 * and `setup-readiness.ts` is an epic watchpoint), and the wizard's shape can
 * move with the wizard.
 *
 * THE TRAVERSAL IS COMPUTED SERVER-SIDE, DELIBERATELY. The alternative — ship
 * readiness and module flags and let the shell call `buildSetupWizardTraversal`
 * — would put a second derivation of the percentage and the frontier in the
 * browser, and a client that computed a different frontier from the one the
 * server would compute is exactly the drift D2's rules exist to prevent.
 *
 * Same guard as `/api/admin/setup`: `requireAdmin()`, which resolves to
 * `support` through the `/api/admin/setup` prefix in `ROUTE_AREA_PREFIXES`. Who
 * may EDIT which step is a per-area question the shell answers from the
 * permission matrix (D12); admission to the surface is not.
 */

export interface SetupWizardPayload {
  readiness: SetupReadiness;
  progress: ReturnType<typeof normalizeSetupProgress>;
  traversal: SetupWizardTraversal<SetupStepId>;
}

/**
 * Each step's readiness verdict, keyed by id — what
 * `buildSetupWizardTraversal` needs to know a step's check passes on its own
 * rather than only because the operator acknowledged it. Omitting it is
 * documented on the traversal input as visible-but-wrong (a wizard parked on
 * step one), which is why it is assembled here rather than left to a default.
 */
function readinessStatusesOf(
  readiness: SetupReadiness,
): SetupWizardTraversalInput<SetupStepId>["readinessStatuses"] {
  const statuses: Partial<Record<SetupStepId, SetupReadiness["categories"][number]["checks"][number]["status"]>> = {};
  for (const category of readiness.categories) {
    for (const check of category.checks) {
      statuses[check.id] = check.status;
    }
  }
  return statuses;
}

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

  const readiness = buildSetupReadiness({ database, progress });

  const traversal = buildSetupWizardTraversal({
    progress,
    // The snapshot's own three-state contract, passed through untouched:
    // `undefined` (unknown) fails open, `null` means first-install defaults.
    // Collapsing either to `{}` here would silently hide a module's steps.
    moduleSettings: database.adminModuleSettings,
    readinessStatuses: readinessStatusesOf(readiness),
  });

  return NextResponse.json({ readiness, progress, traversal });
}
