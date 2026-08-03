import type { ClubModuleSettings } from "@prisma/client";
import {
  CLUB_MODULE_SETTINGS_COLUMN_SELECT,
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  type ModuleKey,
  type ModuleSettingsValues,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { isAnalyticsIntegrationConfigured } from "@/lib/analytics-settings";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

export const CLUB_MODULE_SETTINGS_ID = "default";

type ModuleReadinessStatus =
  | "ready"
  | "admin_disabled"
  // MG1 (#2306) added a fourth state, `not_available_yet`, for a module whose
  // flag existed before its behaviour did. `memberGuests` was its only producer
  // and MG2 (#2307) shipped that behaviour, so the state is gone with it rather
  // than left as an unreachable branch a reader has to reason about.
  | "credentials_missing";

interface ModuleStatus {
  key: ModuleKey;
  label: string;
  description: string;
  adminEnabled: boolean;
  effectiveEnabled: boolean;
  readiness: {
    status: ModuleReadinessStatus;
    message: string;
    dependencies: string[];
  };
}

export interface ClubModuleSettingsPayload {
  settings: ModuleSettingsValues;
  modules: ModuleStatus[];
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

type ClubModuleSettingsRecord = Pick<
  ClubModuleSettings,
  ModuleKey | "updatedAt" | "updatedByMemberId"
>;

export function normalizeClubModuleSettings(
  record?: Partial<ClubModuleSettingsRecord> | null,
): ModuleSettingsValues {
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, record?.[key] ?? DEFAULT_MODULE_SETTINGS[key]]),
  ) as ModuleSettingsValues;
}

function readinessMessage(params: {
  key: ModuleKey;
  label: string;
  adminEnabled: boolean;
  /**
   * Whether the Google Analytics integration has a valid measurement ID saved
   * (#2573). Resolved by the CALLER, because it is a database read and this
   * function is synchronous — and left `undefined` when the caller had no reason
   * to resolve it, which reads as "not configured" and so keeps the readiness
   * message fail-closed.
   */
  analyticsConfigured?: boolean;
}): { status: ModuleReadinessStatus; message: string } {
  if (!params.adminEnabled) {
    return {
      status: "admin_disabled",
      message: `${params.label} is turned off in the admin Modules settings.`,
    };
  }

  // MG1's `memberGuests` "not available yet" branch stood here for exactly one
  // release and is deleted by MG2 (#2307), in the same change that turns the
  // widening on — as MG1's own comment instructed. The module now gates real
  // behaviour, so it reports itself ready like any other credential-free module,
  // and `member-guest-widening.test.ts` asserts both that it does and that no
  // `not_available_yet` state survives anywhere in this file.

  if (
    params.key === "addressAutocomplete" &&
    (!process.env.ADDY_API_KEY?.trim() || !process.env.ADDY_API_SECRET?.trim())
  ) {
    return {
      status: "credentials_missing",
      message:
        "Address autocomplete is enabled, but ADDY_API_KEY and ADDY_API_SECRET are not both configured.",
    };
  }

  // Google sign-in credentials are DB-only now (#2087) and the module cannot be
  // enabled until a real OAuth verify passes (the enable-gate in
  // PUT /api/admin/modules), so an ENABLED googleLogin is already configured +
  // verified — there is no env var to check here. Setup + verification live on
  // the in-app wizard (/admin/google/setup).

  // Google Analytics configuration is DB-only since #2573 (measurement ID, consent
  // banner mode and message), and `NEXT_PUBLIC_GA_MEASUREMENT_ID` was removed from
  // runtime entirely in the same change — there is no environment variable left to
  // check here, and no fallback to it. So an enabled-but-unconfigured module points
  // the admin at the in-app setup instead of at a deploy-time variable.
  if (params.key === "analytics" && !params.analyticsConfigured) {
    return {
      status: "credentials_missing",
      message:
        "Google Analytics is enabled, but no valid GA4 measurement ID has been saved. Complete the setup under Admin → Integrations → Google Analytics.",
    };
  }

  return {
    status: "ready",
    message: `${params.label} is enabled.`,
  };
}

function buildModuleStatusList(
  settings: ModuleSettingsValues,
  context?: ModuleStatusContext,
): ModuleStatus[] {
  return MODULE_KEYS.map((key) => {
    const definition = MODULE_DEFINITIONS[key];
    const adminEnabled = settings[key];
    const readiness = readinessMessage({
      key,
      label: definition.label,
      adminEnabled,
      analyticsConfigured: context?.analyticsConfigured,
    });

    return {
      key,
      label: definition.label,
      description: definition.description,
      adminEnabled,
      effectiveEnabled: adminEnabled,
      readiness: {
        ...readiness,
        dependencies: definition.dependencies,
      },
    };
  });
}

/**
 * Readiness facts a caller has already resolved. Optional throughout: a caller that
 * omits one gets the fail-closed reading of it (#2573).
 */
export interface ModuleStatusContext {
  analyticsConfigured?: boolean;
}

export function buildClubModuleSettingsPayload(
  record?: Partial<ClubModuleSettingsRecord> | null,
  context?: ModuleStatusContext,
): ClubModuleSettingsPayload {
  const settings = normalizeClubModuleSettings(record);

  return {
    settings,
    modules: buildModuleStatusList(settings, context),
    updatedAt: record?.updatedAt?.toISOString() ?? null,
    updatedByMemberId: record?.updatedByMemberId ?? null,
  };
}

export async function loadClubModuleSettings(): Promise<ClubModuleSettingsPayload> {
  const [record, analyticsConfigured] = await Promise.all([
    prisma.clubModuleSettings.findUnique({
      where: { id: CLUB_MODULE_SETTINGS_ID },
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    }),
    // Never throws: a read failure reports "not configured", which shows the
    // "complete the setup" readiness message rather than failing the whole page.
    isAnalyticsIntegrationConfigured(),
  ]);

  return buildClubModuleSettingsPayload(record, { analyticsConfigured });
}

const DISABLED_MODULE_FLAGS: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, false]),
) as FeatureFlags;

export async function loadEffectiveModuleFlags(): Promise<FeatureFlags> {
  try {
    const record = await prisma.clubModuleSettings.findUnique({
      where: { id: CLUB_MODULE_SETTINGS_ID },
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    });

    return getEffectiveModuleFlags(normalizeClubModuleSettings(record));
  } catch (err) {
    logger.error(
      { err },
      "Failed to load club module settings; disabling optional modules",
    );
    return DISABLED_MODULE_FLAGS;
  }
}
