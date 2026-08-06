import { NextResponse } from "next/server";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  ANALYTICS_SETTINGS_ID,
  describeAnalyticsStatus,
  normalizeAnalyticsSettings,
} from "@/lib/analytics-settings";
import { prisma } from "@/lib/prisma";
import { PUBLIC_LAYOUT_CACHE_TAGS } from "@/lib/public-layout-cache";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";

/**
 * POST /api/admin/integrations/analytics/reconsent — "Ask visitors to choose again"
 * (#2573, owner decision section 6).
 *
 * This is the ONLY writer of `AnalyticsSettings.consentRevision`, and that is the
 * whole design. An ordinary Save on the sibling route must never re-prompt visitors,
 * however much the wording changed: resetting everyone's choice because an admin
 * fixed a typo is exactly what the owner ruled out. So re-consent is a separate,
 * explicitly-invoked action with its own confirmation in the UI, its own audit entry,
 * and the same `finance:edit` permission as the settings themselves.
 *
 * ## Only meaningful while the banner is ON
 *
 * Clarification 2: in banner-off mode there is no prompt to show, so bumping the
 * revision would achieve nothing except discarding a visitor's stored preference —
 * and, worse, a stale revision must NOT re-enable analytics for someone who opted out
 * through the public preferences control (which is why the decision resolver honours
 * a `preferences` record at any revision in banner-off mode). The UI hides the action
 * in that mode; this route refuses it with a 409, so the rule holds even against a
 * stale tab or a direct call.
 *
 * ## What it does not do
 *
 * It records nothing about any visitor, because there is nothing to record: every
 * choice lives in the visitor's own browser. Bumping the number is what invalidates
 * them, and no per-visitor data exists here to be reset, exported or deleted.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const result = await prisma.$transaction(async (tx) => {
    const existingRow = await tx.analyticsSettings.findUnique({
      where: { id: ANALYTICS_SETTINGS_ID },
    });
    const existing = normalizeAnalyticsSettings(existingRow);

    if (!existing.consentBannerEnabled) {
      return { conflict: true as const, settings: existing };
    }

    // Read-and-increment inside the transaction rather than `{ increment: 1 }` on a
    // possibly-absent row: the singleton is created lazily, so an upsert is needed,
    // and the create branch has to name a concrete value. Two racing calls both
    // bumping to the same number is harmless anyway (the point is that the number
    // MOVED), but the transaction means the audit entry records the real before/after.
    const nextRevision = existing.consentRevision + 1;

    const row = await tx.analyticsSettings.upsert({
      where: { id: ANALYTICS_SETTINGS_ID },
      create: {
        id: ANALYTICS_SETTINGS_ID,
        measurementId: existing.measurementId,
        consentBannerEnabled: existing.consentBannerEnabled,
        bannerMessage: existing.bannerMessage,
        consentRevision: nextRevision,
        updatedByMemberId: session.user.id,
      },
      update: {
        consentRevision: nextRevision,
        updatedByMemberId: session.user.id,
      },
    });

    const after = normalizeAnalyticsSettings(row);

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "ANALYTICS_CONSENT_REVISION_BUMPED",
        actor: { memberId: session.user.id },
        entity: { type: "AnalyticsSettings", id: ANALYTICS_SETTINGS_ID },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary:
          "Google Analytics visitors asked to make a new consent choice",
        metadata: {
          previousConsentRevision: existing.consentRevision,
          newConsentRevision: after.consentRevision,
          consentBannerEnabled: after.consentBannerEnabled,
        },
        request: getAuditRequestContext(request),
      }),
    );

    return { conflict: false as const, settings: after };
  });

  if (result.conflict) {
    return NextResponse.json(
      {
        error:
          "Asking visitors to choose again only applies while the consent banner is switched on. Turn the banner on first.",
      },
      { status: 409 },
    );
  }

  // Clear the stored public pages as well as the tag: the consent revision is
  // rendered into the layout, so a stored page would keep handing out the OLD
  // revision — and every visitor would keep matching it and never see the prompt.
  revalidatePublicSite(PUBLIC_LAYOUT_CACHE_TAGS.analytics);

  return NextResponse.json({
    settings: result.settings,
    status: describeAnalyticsStatus(result.settings),
  });
}
