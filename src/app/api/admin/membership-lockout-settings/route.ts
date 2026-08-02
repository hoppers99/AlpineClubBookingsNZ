import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  getFinancialYearResolution,
  refreshFinancialYearConfig,
} from "@/lib/financial-year-server";
import {
  MEMBERSHIP_LOCKOUT_SETTINGS_ID,
  SUBSCRIPTION_LOCKOUT_MODES,
  legacyEnabledForLockoutMode,
  loadPersistedMembershipLockoutSettings,
  normalizeMembershipLockoutSettings,
} from "@/lib/membership-lockout-settings";
import {
  getNonSubscriptionFeeItemCodes,
  getSubscriptionItemCodes,
} from "@/lib/xero-mappings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z
  .object({
    /**
     * #2543 — the three-way lockout policy replaces the old `enabled` boolean.
     * Deliberately NOT accepting `enabled` any more: the schema is `.strict()`,
     * so an old client that still sends the boolean is REFUSED rather than
     * silently ignored. A silent ignore is the dangerous direction here — an
     * admin would see their "turn the lockout off" click succeed while the club
     * carried on hard-blocking members.
     */
    mode: z.enum(SUBSCRIPTION_LOCKOUT_MODES).optional(),
    financialYearEndMonthOverride: z
      .number()
      .int()
      .min(1)
      .max(12)
      .nullable()
      .optional(),
    textFallbackEnabled: z.boolean().optional(),
    useFeeScheduleItemCodes: z.boolean().optional(),
  })
  .strict();

/**
 * Compute the fee-schedule detection preview (#2109): the resolved item-code set
 * paid detection would match under look-through, plus the subset of those codes
 * that also identify a non-subscription fee (hut/joining/promo) — an overlap
 * that would let an unpaid fee invoice masquerade as a subscription in the
 * widened set, surfaced as a settings warning.
 */
async function buildFeeScheduleItemCodePreview(): Promise<{
  feeScheduleItemCodes: string[];
  overlappingCodes: string[];
}> {
  const [feeScheduleItemCodes, nonSubscriptionCodes] = await Promise.all([
    getSubscriptionItemCodes(),
    getNonSubscriptionFeeItemCodes(),
  ]);
  const nonSubscriptionSet = new Set(nonSubscriptionCodes);
  const overlappingCodes = feeScheduleItemCodes.filter((code) =>
    nonSubscriptionSet.has(code)
  );
  return { feeScheduleItemCodes, overlappingCodes };
}

/**
 * The fee-schedule code lists are finance-domain data — they enumerate Xero
 * item codes — so the preview is gated on finance VIEW (#2109 FIX-4b). A
 * membership-only admin receives the settings WITHOUT the code lists; the panel
 * hides the finance detection card for them and defaults the absent fields to
 * `[]`, so omitting the keys is safe.
 */
async function buildFeeScheduleItemCodePreviewForViewer(
  user: Parameters<typeof hasAdminAreaAccess>[0]
): Promise<{ feeScheduleItemCodes: string[]; overlappingCodes: string[] } | null> {
  if (!hasAdminAreaAccess(user, { area: "finance", level: "view" })) {
    return null;
  }
  return buildFeeScheduleItemCodePreview();
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const persisted = await loadPersistedMembershipLockoutSettings();
  const financialYear = await getFinancialYearResolution();
  const preview = await buildFeeScheduleItemCodePreviewForViewer(
    guard.session.user
  );
  return NextResponse.json({
    settings: normalizeMembershipLockoutSettings(persisted),
    financialYear,
    persisted,
    ...(preview ?? {}),
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const before = await prisma.membershipLockoutSettings.findUnique({
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
  });

  // #2543. Resolve the unchanged mode through `normalizeMembershipLockoutSettings`
  // rather than reading `before.mode` directly: `mode` is null for every club
  // that has not saved this panel since the #2543 migration, and the normaliser
  // is what maps that null through the legacy `enabled` boolean. Reading the
  // column raw and defaulting a null to HARD_BLOCK would turn the lockout back ON
  // for a club that had switched it off, the moment an admin saved any OTHER
  // field on this panel.
  const mode = parsed.data.mode ?? normalizeMembershipLockoutSettings(before).mode;

  const data = {
    mode,
    // The legacy column is written in step with `mode` for as long as it exists;
    // see `legacyEnabledForLockoutMode`.
    enabled: legacyEnabledForLockoutMode(mode),
    financialYearEndMonthOverride:
      parsed.data.financialYearEndMonthOverride !== undefined
        ? parsed.data.financialYearEndMonthOverride
        : (before?.financialYearEndMonthOverride ?? null),
    textFallbackEnabled:
      parsed.data.textFallbackEnabled ?? before?.textFallbackEnabled ?? true,
    useFeeScheduleItemCodes:
      parsed.data.useFeeScheduleItemCodes ??
      before?.useFeeScheduleItemCodes ??
      false,
    updatedByMemberId: session.user.id,
  };

  const record = await prisma.membershipLockoutSettings.upsert({
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    create: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID, ...data },
    update: data,
  });

  // Reseed the financial-year cache so the change takes effect immediately on
  // this instance.
  await refreshFinancialYearConfig();

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "MEMBERSHIP_LOCKOUT_SETTINGS_UPDATED",
      actor: { memberId: session.user.id },
      entity: {
        type: "MembershipLockoutSettings",
        id: MEMBERSHIP_LOCKOUT_SETTINGS_ID,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Membership booking lockout settings updated",
      metadata: { previousSettings: before, newSettings: data },
      request: getAuditRequestContext(request),
    })
  );

  const financialYear = await getFinancialYearResolution();
  const preview = await buildFeeScheduleItemCodePreviewForViewer(
    session.user
  );
  return NextResponse.json({
    settings: normalizeMembershipLockoutSettings(record),
    financialYear,
    persisted: record,
    ...(preview ?? {}),
  });
}
