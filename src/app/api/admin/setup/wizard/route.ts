import { NextResponse } from "next/server";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
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
import type { SetupWizardPayload } from "@/lib/setup-wizard-view";

/**
 * The wizard shell's single read (epic #213, child C5).
 *
 * `/api/admin/setup` already returns readiness + progress for the readiness
 * cards. The wizard needs one more thing the cards never did — C4's TRAVERSAL,
 * which is the only source of per-step state, reachability and the D7
 * percentage. So this is a second, additive route rather than a widened
 * payload: the cards' response shape stays exactly as it is, and the wizard's
 * shape can move with the wizard.
 *
 * MODULE FLAGS ARE NOW APPLIED ON BOTH SIDES (C8, #223). This route filters
 * twice, harmlessly and by design: `buildSetupReadiness` below drops a disabled
 * module's checks, and `buildSetupWizardTraversal` filters the registry by the
 * same `getApplicableSetupStepIds` rule. The two agree by construction — the
 * traversal's applicable set IS the registry's, and the readiness result it is
 * handed carries exactly that set's checks — so `readinessStatuses` can never
 * be missing a status for a step the traversal still walks.
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

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const [database, progressRecord, themeState] = await Promise.all([
    getSetupDatabaseSnapshot(),
    prisma.setupProgress.findUnique({ where: { id: "default" } }),
    // D9's launch panel reports and publishes this. Read here rather than by the
    // panel, so the shell's focus refetch keeps it current (#220 review F3).
    getWebsiteThemeRenderState(),
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

  /*
    C9 (#224): the launch panel's role lever, carried through from the SAME
    resolution the `environment-role` readiness step and `/admin/environment`
    read — `database.environmentRole` and `database.withheldEmail` are already
    `resolveEnvironmentRole()` and `readWithheldApplicationEmail()`'s own
    answers (`setup-readiness-db.ts`), so this is a NARROWER READ of an existing
    result, never a second derivation, and it costs no extra query.

    Both fields are typed optional on `SetupDatabaseSnapshot` for callers that
    inject a partial snapshot (a DB-less `setup:check`, or a test that does not
    stub them — this route's own test doubles do not). Falling back to UNKNOWN /
    unresolved / unavailable here is the same fail-closed answer the resolver
    itself gives when it cannot read the database, not a guess invented at this
    call site.
  */
  const environmentSafety: SetupWizardPayload["environmentSafety"] = {
    role: database.environmentRole?.role ?? "UNKNOWN",
    decidedBy: database.environmentRole?.decidedBy ?? "unresolved",
    withheldEmail: database.withheldEmail ?? { available: false },
  };

  const traversal = buildSetupWizardTraversal({
    progress,
    // The snapshot's own three-state contract, passed through untouched:
    // `undefined` (unknown) fails open, `null` means first-install defaults.
    // Collapsing either to `{}` here would silently hide a module's steps.
    moduleSettings: database.adminModuleSettings,
    readinessStatuses: setupReadinessStatusesOf(readiness),
    // C2 (#217) closes C4's seam: the stale set is READ here, not derived. The
    // progress route recomputes and stores the full transitive closure on every
    // write, so this is the answer that write computed — which is also what
    // gives staleness an audited transition instant instead of a per-page-load
    // recomputation.
    //
    // `storedSetupStaleStepIds` returns `undefined`, never `[]`, when there is
    // no row or the column cannot be trusted, so the traversal derives fresh
    // rather than being handed an empty answer nobody computed. The traversal
    // then intersects whatever it gets against "applicable and recorded
    // complete", so a stored id whose step is no longer either simply drops.
    staleStepIds: storedSetupStaleStepIds(progressRecord),
  });

  // EXACTLY `SetupWizardPayload`, and nothing besides. The `progress` this used
  // to send alongside was never declared on that interface and was therefore
  // unreadable by the shell — the wizard's rail is built from the traversal,
  // which already has progress folded into every step's state (#220 review F6).
  const payload: SetupWizardPayload = {
    readiness,
    traversal,
    isSiteVisible: themeState.isComplete,
    environmentSafety,
  };
  return NextResponse.json(payload);
}
