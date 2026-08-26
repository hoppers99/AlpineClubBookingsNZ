/**
 * The setup-aware admin nudge (epic #213, C10, #236).
 *
 * The admin layout used to nag about `ClubTheme.completedAt` — the LAUNCH
 * lever (`getWebsiteThemeRenderState().isComplete`, see `club-theme.ts`) —
 * with copy that named Site Style specifically. Three defects that fixed:
 * the gate answered a different question from the copy (launched vs. styled),
 * it was gated on `content:edit` so the support officer the wizard actually
 * serves never saw it, and under C8's `legacySurfacesHidden` its CTA pointed
 * at a Site Style page whose Finish control no longer publishes anything — a
 * dead end.
 *
 * This module reads the JOURNEY-finished flag instead — `SetupProgress.
 * completedAt` (the singleton `id: "default"` row; see
 * `src/app/api/admin/setup/progress/route.ts`, action `"finish"`), which is
 * distinct from the launch lever above and is also what
 * `bootstrap-import.ts`'s "has this target already been set up" check reads —
 * and decides whether to show a wizard-CTA banner from that plus the
 * requested path plus the viewer's own permission matrix, so the answer never
 * has to name which page changed.
 */
import { prisma } from "@/lib/prisma";
import {
  canViewAdminHrefWithMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

/** Where the banner's CTA goes. Never Site Style — see the module doc above. */
export const SETUP_WIZARD_HREF = "/admin/setup/wizard";

const SETUP_AREA_PREFIX = "/admin/setup";

/**
 * One indexed singleton read — cheap enough for the admin layout's existing
 * `Promise.all`. Selects only the column the decision needs.
 */
export async function readSetupJourneyComplete(): Promise<boolean> {
  const progress = await prisma.setupProgress.findUnique({
    where: { id: "default" },
    select: { completedAt: true },
  });
  return Boolean(progress?.completedAt);
}

function isUnderSetupArea(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  // Strip query/hash before comparing; `REQUEST_PATH_HEADER` carries
  // `${pathname}${search}` (see `internal-return-path.ts`).
  const normalized = pathname.split(/[?#]/)[0] || "/";
  return (
    normalized === SETUP_AREA_PREFIX ||
    normalized.startsWith(`${SETUP_AREA_PREFIX}/`)
  );
}

/**
 * WHEN the journey is unfinished, THE layout SHALL show the banner for any
 * admin the wizard itself would admit (matched here by checking the SAME
 * route, `/admin/setup/wizard`, against the caller's own permission matrix —
 * whatever admits the wizard's own page admits the banner, by construction).
 * WHEN it is finished, or the current path is already under `/admin/setup`,
 * THE banner SHALL NOT render.
 */
export function shouldShowSetupNudge(input: {
  journeyComplete: boolean;
  requestedPath: string | null | undefined;
  permissionMatrix: AdminPermissionMatrix;
}): boolean {
  if (input.journeyComplete) return false;
  if (isUnderSetupArea(input.requestedPath)) return false;
  return canViewAdminHrefWithMatrix(input.permissionMatrix, SETUP_WIZARD_HREF);
}
