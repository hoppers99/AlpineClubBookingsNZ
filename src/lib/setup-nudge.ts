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
 * and decides whether to show a wizard-CTA banner from that plus the launch
 * lever plus the requested path plus the viewer's own permission matrix, so
 * the answer never has to name which page changed.
 *
 * ## Two branches, not one (fix round F1)
 *
 * A club can finish the setup JOURNEY (`SetupProgress.completedAt` set)
 * without ever having LAUNCHED the public site (`ClubTheme.completedAt` still
 * null, i.e. `getWebsiteThemeRenderState().isComplete === false`) — the
 * wizard's own Ready-to-open screen is a separate, considered act. The first
 * shipped version of this banner only fired on journey-unfinished, so a club
 * in exactly that state had NOTHING in admin saying the public site is still
 * 503ing. `shouldShowSetupNudge` now returns which of two variants applies,
 * if either, rather than a bare boolean:
 *
 * - `"journey-incomplete"`: the setup journey itself is unfinished. Original
 *   copy, unchanged.
 * - `"launch-pending"`: the journey is finished but the site has not been
 *   opened. Honest copy that setup is marked finished but the public website
 *   has not been opened yet — CTA still to the wizard, never to
 *   `/admin/site-style` directly, because the wizard's Ready-to-open screen
 *   is what owns launching (D9).
 *
 * Both variants share the same path-suppression and permission gate
 * (`canSetupNudgeAppear`), because both point at the same wizard and neither
 * belongs on the pages that already show this state directly.
 *
 * ## Failing toward HIDDEN, not toward the wrong branch (fix round F2)
 *
 * `readSetupJourneyComplete` used to have no failure handling at all, so a
 * `SetupProgress` read fault 500'd the whole admin area. It now catches and
 * reports `{ complete: false, readFailed: true }` — the same `readFailed`
 * shape `getWebsiteThemeRenderState` already uses, and for the same reason:
 * "unfinished" and "unknown" are different facts, and a caller must not
 * collapse them into the same `false`. That distinction has to survive into
 * `shouldShowSetupNudge`, not just into the read helper: `journeyComplete:
 * false` on its own would take the `"journey-incomplete"` branch and show a
 * banner, which is the WRONG failure direction — a false nag on a healthy,
 * already-finished club is worse than a missed nudge on a genuinely
 * unfinished one, and the wizard the CTA points at cannot even render while
 * the same database is unreachable. So `journeyReadFailed: true` short-circuits
 * to `null` (no banner, either variant) before the two branches are
 * considered at all. One consequence worth stating rather than leaving
 * implicit: this means a `SetupProgress` read fault also hides the
 * `"launch-pending"` branch, even on a club that genuinely has not launched —
 * accepted, because "unknown" beats a possibly-wrong claim either way.
 */
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  canViewAdminHrefWithMatrix,
  normalizePathname,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { SETUP_WIZARD_HREF } from "@/lib/setup-wizard-route";

/**
 * Where the banner's CTA goes. Never Site Style — see the module doc above.
 * Re-exported from `setup-wizard-route.ts` (fix round drift finding) so every
 * existing `from "@/lib/setup-nudge"` import keeps working; `setup-nudge.ts`
 * itself is server-only (imports `@/lib/prisma`), so a `"use client"` module
 * must import the constant from the dependency-free module directly instead —
 * see `setup-page-client.tsx`.
 */
export { SETUP_WIZARD_HREF };

const SETUP_AREA_PREFIX = "/admin/setup";

export type SetupJourneyReadResult = {
  complete: boolean;
  /** True only when the read THREW — never when it returned "no row". */
  readFailed: boolean;
};

/**
 * One indexed singleton read — cheap enough for the admin layout's existing
 * `Promise.all`, and skippable entirely when `canSetupNudgeAppear` already
 * says no banner could show regardless of the journey state (fix round F5;
 * see the admin layout, which computes that gate before this read runs).
 */
export async function readSetupJourneyComplete(): Promise<SetupJourneyReadResult> {
  try {
    const progress = await prisma.setupProgress.findUnique({
      where: { id: "default" },
      select: { completedAt: true },
    });
    return { complete: Boolean(progress?.completedAt), readFailed: false };
  } catch (err) {
    logger.error(
      { err },
      "Failed to read SetupProgress.completedAt; hiding the setup nudge " +
        "rather than risking a false nag (setup-nudge, #236 fix round F2)",
    );
    return { complete: false, readFailed: true };
  }
}

function isUnderSetupArea(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  // `REQUEST_PATH_HEADER` carries `${pathname}${search}` (see
  // `internal-return-path.ts`); `normalizePathname` strips the query/hash
  // (and a trailing slash) the same way every admin route-requirement lookup
  // does — see its doc comment in `admin-permissions.ts`.
  const normalized = normalizePathname(pathname);
  return (
    normalized === SETUP_AREA_PREFIX ||
    normalized.startsWith(`${SETUP_AREA_PREFIX}/`)
  );
}

/**
 * The two discriminators that decide whether ANY nudge variant could show,
 * independent of the journey/launch state: is the viewer already under
 * `/admin/setup` (both variants are pointless there — you're already looking
 * at the thing they'd send you to), and can the viewer reach the wizard at
 * all under their own permission matrix.
 *
 * Exported so the admin layout can check this BEFORE running
 * `readSetupJourneyComplete()` and skip the query entirely when the answer is
 * already "no" (fix round F5) — both inputs are in hand before the layout's
 * `Promise.all` runs.
 */
export function canSetupNudgeAppear(input: {
  requestedPath: string | null | undefined;
  permissionMatrix: AdminPermissionMatrix;
}): boolean {
  if (isUnderSetupArea(input.requestedPath)) return false;
  return canViewAdminHrefWithMatrix(input.permissionMatrix, SETUP_WIZARD_HREF);
}

export type SetupNudgeVariant = "journey-incomplete" | "launch-pending";

/**
 * WHEN the setup journey is unfinished, THE layout SHALL show the
 * `"journey-incomplete"` banner for any admin the wizard itself would admit
 * (matched here by checking the SAME route, `/admin/setup/wizard`, against
 * the caller's own permission matrix — whatever admits the wizard's own page
 * admits the banner, by construction).
 *
 * WHEN the journey IS finished but the public site has not been launched,
 * THE layout SHALL show the `"launch-pending"` banner instead, under the same
 * gate.
 *
 * WHEN both are finished, the current path is already under `/admin/setup`,
 * the viewer cannot reach the wizard, OR the journey read itself failed, THE
 * banner SHALL NOT render at all.
 */
export function shouldShowSetupNudge(input: {
  journeyComplete: boolean;
  journeyReadFailed: boolean;
  themeComplete: boolean;
  requestedPath: string | null | undefined;
  permissionMatrix: AdminPermissionMatrix;
}): SetupNudgeVariant | null {
  if (input.journeyReadFailed) return null;
  if (
    !canSetupNudgeAppear({
      requestedPath: input.requestedPath,
      permissionMatrix: input.permissionMatrix,
    })
  ) {
    return null;
  }
  if (!input.journeyComplete) return "journey-incomplete";
  if (!input.themeComplete) return "launch-pending";
  return null;
}
