import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  SETUP_SURFACE_SETTINGS_ID,
  loadSetupSurfaceSettings,
  normalizeSetupSurfaceSettings,
} from "@/lib/setup-surface-settings";

/**
 * The setup-surfaces settings section (setup wizard C8, #223; epic #213 D8).
 * Support `view` / `edit`, resolved through the `/api/admin/setup` prefix in
 * `ROUTE_AREA_PREFIXES` — the same area the readiness page and the wizard
 * already admit, because this decides what that page shows and nothing wider.
 *
 * ORDINARY GUARDED UPSERT, NO ADVISORY LOCK, and that is the precedent rather
 * than an omission. Every settings singleton here — maintenance reports, member
 * guests, analytics, login security — writes its `id = "default"` row with a
 * plain `upsert` and no lock: the row is a scalar preference with one writer
 * (this route), two administrators saving at once resolve last-write-wins on a
 * single boolean, and there is no counterpart writer, no capacity claim, no
 * money and no state machine for a lock to serialise against.
 * `CONCURRENCY_AND_LOCKING.md`'s writer matrix admits nothing here, so
 * introducing a key would be a new global site to register (`INV-LOCK-003`) in
 * exchange for nothing.
 *
 * THE AUDIT ROW IS `system`, matching the seven setup-progress writers beside
 * it rather than the `admin` that `CLUB_TIME_ZONE_UPDATED` and the
 * environment-safety override take. `INV-PRIV-012` files a row by its AFFECTED
 * DOMAIN, and `docs/guides/audit-log.md` files "Setup, backups, platform-level
 * events" under `system`: the affected domain here is the club's setup journey,
 * the same thing `setup_progress.steps_marked_stale` is about, not an
 * administrator's own settings and not the installation's identity. It widens
 * nobody's access — `system` is readable with `support:view` alone, which is
 * exactly who can already read the setup-progress rows this one sits among —
 * and the row names no member, no booking and no amount.
 *
 * NO NO-OP COMPARISON HERE, deliberately: `ARCHITECTURE.md` → "Admin/member
 * layer" puts the dirty gate at the FORM layer, through the hook's `isDirty`,
 * and states that routes keep no ad-hoc comparison of their own. The `from`/`to`
 * pair in the details makes a pristine write from a direct API caller
 * self-evident rather than invisible.
 */

const putSchema = z
  .object({
    legacySurfacesHidden: z.boolean(),
  })
  .strict();

export async function GET() {
  const admin = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!admin.ok) return admin.response;

  return NextResponse.json({ settings: await loadSetupSurfaceSettings() });
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!admin.ok) return admin.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose whether the legacy setup surfaces are shown or hidden." },
      { status: 400 },
    );
  }

  try {
    const before = await loadSetupSurfaceSettings();

    const saved = await prisma.setupSurfaceSettings.upsert({
      where: { id: SETUP_SURFACE_SETTINGS_ID },
      // Lazily created, like every other settings singleton here: a club that
      // has never opened this section has no row and reads the default.
      create: {
        id: SETUP_SURFACE_SETTINGS_ID,
        ...parsed.data,
        updatedByMemberId: admin.session.user.id,
      },
      update: { ...parsed.data, updatedByMemberId: admin.session.user.id },
    });

    const ipAddress =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    // Fire-and-forget, matching the setup-progress writers: it runs AFTER the
    // upsert commits, so a failed audit write never fails the operator's save
    // and a rolled-back save records nothing.
    logAudit({
      action: "setup_surfaces.legacy_visibility_changed",
      category: "system",
      memberId: admin.session.user.id,
      entityType: "SetupSurfaceSettings",
      entityId: SETUP_SURFACE_SETTINGS_ID,
      details: JSON.stringify({
        from: before.legacySurfacesHidden,
        to: parsed.data.legacySurfacesHidden,
      }),
      ipAddress,
      outcome: "success",
    });

    return NextResponse.json({
      settings: normalizeSetupSurfaceSettings(saved),
    });
  } catch (err) {
    logger.error({ err }, "Failed to save setup surface settings");
    return NextResponse.json(
      { error: "Failed to save these settings" },
      { status: 500 },
    );
  }
}
