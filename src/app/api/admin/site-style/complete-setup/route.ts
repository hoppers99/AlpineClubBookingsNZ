import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { markClubThemeSetupComplete } from "@/lib/club-theme";
import logger from "@/lib/logger";
import { PUBLIC_LAYOUT_CACHE_TAGS } from "@/lib/public-layout-cache";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";

/**
 * Make the public site visible — and change nothing else (#220 review F3).
 *
 * The setup wizard's launch panel used to publish the site through
 * `PUT /api/admin/site-style`, which is `.strict()` and rewrites every theme
 * column. That meant reading the whole theme on mount and posting it back, so a
 * panel left open while another administrator edited the club's colours wrote
 * the stale copy over their work. This route exists so the one transition the
 * panel actually performs needs no theme in the request at all.
 *
 * **Guarded exactly as that PUT is** — `content: edit` — because it is the same
 * privilege: publishing the club's public pages. It is deliberately NOT the
 * `support` area the rest of the wizard's progress transitions use; this one is
 * not progress bookkeeping, it is the site going live.
 *
 * Idempotent by construction: `markClubThemeSetupComplete` claims the flip with
 * `completedAt: null` in its WHERE, so a second click reports the site visible
 * without moving the original completion time or writing a second audit row.
 *
 * The cache work mirrors the PUT's completeSetup half and its reasoning (#2352
 * F3): completing setup ends the "Site setup in progress" state, and any page
 * stored while the layout was painting the holding screen must not outlive it.
 * `primeEmailPalette()` is deliberately absent — no colour changed here, so
 * there is nothing for the email palette to re-read.
 */
export async function POST() {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  try {
    const isComplete = await markClubThemeSetupComplete(guard.session.user.id);

    revalidatePublicSite(PUBLIC_LAYOUT_CACHE_TAGS.theme);
    revalidatePath("/(authenticated)", "layout");
    revalidatePath("/(admin)", "layout");

    return NextResponse.json({ isComplete });
  } catch (error) {
    logger.error({ err: error }, "Failed to make the public site visible");
    return NextResponse.json(
      { error: "Failed to make the public site visible" },
      { status: 500 },
    );
  }
}
