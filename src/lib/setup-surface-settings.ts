import type { SetupSurfaceSettings } from "@prisma/client";

import { DEFAULT_SETUP_SURFACE_SETTINGS } from "@/config/club-settings-defaults";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Which setup SURFACES this club is shown (setup wizard C8, #223; epic #213 D8;
 * INV-CONFIG-001).
 *
 * Epic decision D6 is that the wizard is the destination and the readiness
 * cards are transitional; D8 says replacement means COVERAGE PARITY BEHIND A
 * FLAG — once the wizard covers a legacy surface, one setting can hide it. This
 * module is that setting's read path. It governs three things and nothing else:
 * the readiness cards on `/admin/setup`, the four `/admin/setup/{foundations,
 * finance,booking-rules,integrations}` drill-down hubs, and Site Style's own
 * Finish-setup control (the second launch lever #222's build recorded, which
 * retires with the surfaces it belongs to).
 *
 * WHAT IT DOES NOT GOVERN, and must never be extended to: the wizard itself,
 * `/admin/setup`'s route, or the wizard's launch panel. `/admin/setup` stays
 * REACHABLE in both positions on purpose — it is where the setting lives, so
 * hiding the surfaces from the page that carries the switch would make the
 * switch unreachable in the only state it exists to undo. That is the same trap
 * `feature-routes.ts`'s `exemptPaths` exists for, stated there as "gating a
 * guided setup surface behind its own flag makes it unreachable in the only
 * state it exists to fix".
 *
 * FOLLOWS `maintenance-report-settings.ts` / `member-guest-settings.ts`: the
 * row is created LAZILY, so a club that has never opened the section has no row,
 * reads the default, and is never written to. The migration seeds nothing.
 *
 * EVERY FAILURE PATH HERE IS OPEN, WHICH IS THE SAFE DIRECTION FOR THIS FLAG —
 * and it is the exact opposite of the maintenance-report loader's fail-CLOSED
 * rule, so the difference is worth stating rather than copying by habit. There
 * the default keeps an unauthenticated endpoint shut, so a fault must never open
 * a door. Here the default keeps an ADMIN SURFACE VISIBLE, so a fault must never
 * take away a page an operator is relying on to configure the club: a missing
 * row, a table that does not exist yet during a blue/green window, a
 * rolled-back release, and a database error all resolve to `legacySurfacesHidden
 * = false`.
 *
 * BUT "SHOWS A SURFACE" UNDERSTATES WHAT THAT COSTS, and the honest version is
 * this: because the same flag governs Site Style's own **Finish setup** control,
 * a read fault also RE-ARMS A PUBLISH LEVER. A club that retired the surfaces
 * deliberately, so the wizard's Ready-to-open panel would be the single
 * considered act that makes the public site live, gets the second lever back on
 * the styling page for as long as the read keeps failing — and a content admin
 * saving their colours can publish the site from there without meaning to.
 *
 * That is still the right direction, and the choice is deliberate rather than
 * unexamined. Failing CLOSED would hide `/admin/setup`'s own surfaces from an
 * operator mid-configuration whenever the database hiccuped, which is a page
 * they are relying on; and the publish lever it would be protecting is one an
 * administrator has to find, read and press. But it is a real consequence, not
 * merely a cosmetic one, so it is written here rather than left as "the worst a
 * fault can do is show a surface somebody asked to hide".
 */

export const SETUP_SURFACE_SETTINGS_ID = "default";

export type SetupSurfaceSettingsValues = {
  legacySurfacesHidden: boolean;
};

type SetupSurfaceSettingsRecord = Pick<
  SetupSurfaceSettings,
  keyof SetupSurfaceSettingsValues
>;

export function normalizeSetupSurfaceSettings(
  record?: Partial<SetupSurfaceSettingsRecord> | null,
): SetupSurfaceSettingsValues {
  return {
    legacySurfacesHidden:
      record?.legacySurfacesHidden ??
      DEFAULT_SETUP_SURFACE_SETTINGS.legacySurfacesHidden,
  };
}

export async function loadSetupSurfaceSettings(): Promise<SetupSurfaceSettingsValues> {
  try {
    const record = await prisma.setupSurfaceSettings.findUnique({
      where: { id: SETUP_SURFACE_SETTINGS_ID },
    });
    return normalizeSetupSurfaceSettings(record);
  } catch (err) {
    logger.error(
      { err },
      "Failed to load setup surface settings; showing the legacy setup surfaces",
    );
    return { ...DEFAULT_SETUP_SURFACE_SETTINGS };
  }
}

/**
 * The one question every consumer actually asks. A named predicate rather than
 * a bare field read, so the four hub pages, the setup page and the site-style
 * page all phrase the condition identically and a reviewer can grep for every
 * surface the flag governs in one search.
 *
 * ## What the four hub pages do with a `true`, and why — stated ONCE, here
 *
 * They redirect. **HIDDEN MEANS ABSENT, NOT DELETED** — #223's "hide, don't
 * remove" is explicit — so each route still exists and still answers, and it
 * answers by sending the operator to the surface that replaced it.
 *
 * A 404 was the other candidate and is the wrong shape. 404 is what a DISABLED
 * MODULE's route returns (`getFeatureFlagBlockResponse` in `src/proxy.ts`),
 * because that surface has no successor and the module state is something the
 * answer must not leak. These four have a successor — every destination on them
 * is a step of the wizard — and their state is a club preference an admin can
 * read on the page they land on.
 *
 * Three of them redirect to `/admin/setup`, which stays reachable in BOTH
 * positions and carries the switch, so a stale bookmark lands where the change
 * can be seen and undone. **The Finance hub is the exception and redirects to
 * `/finance`** (D-C8-1): its report-mapping editor moved to the finance
 * dashboard, `/admin/setup` is a `support`-area page, and a finance-only officer
 * sent there gets a 403 instead of the surface they were looking for. That one
 * falls back to `/admin/setup` when the `financeDashboard` module is off, since
 * `/finance` is module-gated and would answer with a 404.
 *
 * Checked in each page rather than in the proxy on purpose. A proxy gate would
 * put a settings read on the hot path for every request matching the prefix,
 * including the wizard's own; this is one query on four rarely-visited pages.
 */
export function areLegacySetupSurfacesHidden(
  settings: SetupSurfaceSettingsValues,
): boolean {
  return settings.legacySurfacesHidden;
}
