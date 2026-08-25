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
 * = false`. The worst a fault can do is show a surface somebody asked to hide.
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
 */
export function areLegacySetupSurfacesHidden(
  settings: SetupSurfaceSettingsValues,
): boolean {
  return settings.legacySurfacesHidden;
}
