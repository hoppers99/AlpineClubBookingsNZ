import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { CLUB_CONFIG_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import {
  loadLodgeSettings,
  updateLodgeSettings,
} from "@/lib/lodge-settings";
import { resolveOptionalConfigurableLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";

/*
  Per-lodge scope (lodge-scoping contract): an explicit lodgeId must name a real
  lodge; omitted keeps the legacy single-row behaviour.

  #221 — this is a CONFIGURATION surface, so `active` is not consulted. A
  per-lodge capacity override is part of setting a lodge up, and the flow that
  sets one up reaches this route: the setup flow's finish step offers "Open
  lodge configuration", whose page reads this route on load and writes the
  capacity override from its own editor. While the check was active-only, that
  GET failed silently (`/admin/lodges/[id]` swallows a non-ok response) and the
  PUT answered "Lodge not found or not active" for a lodge the operator was
  plainly looking at.

  An unknown id is still refused, which is the half that matters: this is the
  `resolveOptionalConfigurableLodgeId` contract, and calling the helper rather
  than re-deriving it is what puts this route on the census in
  `lodge-configurable-resolution.test.ts`. The OMITTED case deliberately does
  NOT take the helper's default-lodge fallback — `null` here means the legacy
  club-wide single row, which `loadLodgeSettings` and `updateLodgeSettings` both
  key on, and resolving it to a lodge id would silently move which row this
  route reads and writes.
*/
async function validateLodgeScope(lodgeId: string | null | undefined) {
  if (!lodgeId) return { ok: true as const };
  const resolved = await resolveOptionalConfigurableLodgeId(prisma, lodgeId);
  if (!resolved) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Lodge not found" }, { status: 400 }),
    };
  }
  return { ok: true as const };
}

const settingsSchema = z
  .object({
    // Null clears the override and falls back to the club config bed total.
    capacity: z.number().int().positive().max(100000).nullable(),
    hutLeaderLookaheadDays: z.number().int().min(1).max(365).optional(),
    // Per-lodge school-group soft cap; null clears it to the code default.
    schoolGroupSoftCap: z.number().int().positive().max(100000).nullable().optional(),
    // Lodge whose per-lodge settings are edited; the lookahead stays
    // club-wide regardless.
    lodgeId: z.string().min(1).optional(),
  })
  .strict();

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const lodgeId = new URL(request.url).searchParams.get("lodgeId");
  const scope = await validateLodgeScope(lodgeId);
  if (!scope.ok) return scope.response;

  const settings = await loadLodgeSettings(prisma, lodgeId);
  return NextResponse.json({
    capacity: settings.capacity,
    hutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    schoolGroupSoftCap: settings.schoolGroupSoftCap,
    clubConfigCapacity: CLUB_CONFIG_LODGE_CAPACITY,
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const body = settingsSchema.safeParse(json.body);
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid input", details: body.error.flatten() },
      { status: 400 },
    );
  }

  const scope = await validateLodgeScope(body.data.lodgeId);
  if (!scope.ok) return scope.response;

  const previousSettings = await loadLodgeSettings(prisma, body.data.lodgeId);
  const settings = await updateLodgeSettings({
    capacity: body.data.capacity,
    hutLeaderLookaheadDays:
      body.data.hutLeaderLookaheadDays ??
      previousSettings.hutLeaderLookaheadDays,
    // Omitted keeps the current value; explicit null clears to the default.
    schoolGroupSoftCap:
      body.data.schoolGroupSoftCap === undefined
        ? previousSettings.schoolGroupSoftCap
        : body.data.schoolGroupSoftCap,
    updatedByMemberId: guard.session.user.id,
    lodgeId: body.data.lodgeId,
  });
  // #2352 slice-1 review. This was `invalidatePublicLodgeCapacity()`, i.e. the
  // capacity TAG only. `{{lodge-capacity}}` is resolved server-side from uncached
  // reads, so the stored CMS page carries no capacity tag and a tag clear expired
  // nothing — `/accommodation` kept advertising the old bed count until the
  // 300-second backstop lapsed AND a further request arrived. The full clear is
  // what makes a capacity save behave like every other admin save.
  revalidatePublicSite();

  await createAuditLog({
    action: "LODGE_SETTINGS_UPDATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "LodgeSettings",
    entityId: body.data.lodgeId ?? "default",
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Lodge settings updated",
    metadata: {
      previousCapacity: previousSettings.capacity,
      newCapacity: settings.capacity,
      previousHutLeaderLookaheadDays:
        previousSettings.hutLeaderLookaheadDays,
      newHutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    },
  });

  return NextResponse.json({
    capacity: settings.capacity,
    hutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    schoolGroupSoftCap: settings.schoolGroupSoftCap,
    clubConfigCapacity: CLUB_CONFIG_LODGE_CAPACITY,
  });
}
