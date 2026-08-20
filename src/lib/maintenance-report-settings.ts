import type { MaintenanceReportSettings } from "@prisma/client";

import {
  DEFAULT_MAINTENANCE_REPORT_SETTINGS,
  MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX,
  MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN,
} from "@/config/club-settings-defaults";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Server loader for the single-row ("default") maintenance-report policy
 * singleton (#2780).
 *
 * Follows the `member-guest-settings.ts` shape: the row is created LAZILY, so a
 * club that has never opened the settings section reads the schema defaults and
 * writes nothing, and the migration seeds no row.
 *
 * EVERY FAILURE PATH HERE IS CLOSED, NOT OPEN. A missing row, a table that does
 * not exist yet during a blue/green window, or a database error all resolve to
 * `DEFAULT_MAINTENANCE_REPORT_SETTINGS`, in which `anonymousReportsEnabled` is
 * `false`. So the unauthenticated QR endpoint cannot be opened by an outage —
 * the worst a fault can do is close a door that was open, never open one that
 * was shut.
 */

export const MAINTENANCE_REPORT_SETTINGS_ID = "default";

export type MaintenanceReportSettingsValues = {
  anonymousReportsEnabled: boolean;
  photosEnabled: boolean;
  anonymousPhotosEnabled: boolean;
  photoRetentionDays: number;
  anonymousContactPrompt: boolean;
};

type MaintenanceReportSettingsRecord = Pick<
  MaintenanceReportSettings,
  keyof MaintenanceReportSettingsValues
>;

/**
 * Clamp rather than reject, because this is a READ path: a stored value outside
 * the bounds (an older release, a hand-edited row, a restored backup) must still
 * produce a usable retention window rather than throwing into a submit. The
 * admin WRITE path validates and refuses instead — see the settings route.
 */
export function clampPhotoRetentionDays(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAINTENANCE_REPORT_SETTINGS.photoRetentionDays;
  }
  return Math.min(
    MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX,
    Math.max(MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN, Math.trunc(value)),
  );
}

export function normalizeMaintenanceReportSettings(
  record?: Partial<MaintenanceReportSettingsRecord> | null,
): MaintenanceReportSettingsValues {
  return {
    anonymousReportsEnabled:
      record?.anonymousReportsEnabled ??
      DEFAULT_MAINTENANCE_REPORT_SETTINGS.anonymousReportsEnabled,
    photosEnabled:
      record?.photosEnabled ?? DEFAULT_MAINTENANCE_REPORT_SETTINGS.photosEnabled,
    anonymousPhotosEnabled:
      record?.anonymousPhotosEnabled ??
      DEFAULT_MAINTENANCE_REPORT_SETTINGS.anonymousPhotosEnabled,
    photoRetentionDays: clampPhotoRetentionDays(
      record?.photoRetentionDays ??
        DEFAULT_MAINTENANCE_REPORT_SETTINGS.photoRetentionDays,
    ),
    anonymousContactPrompt:
      record?.anonymousContactPrompt ??
      DEFAULT_MAINTENANCE_REPORT_SETTINGS.anonymousContactPrompt,
  };
}

export async function loadMaintenanceReportSettings(): Promise<MaintenanceReportSettingsValues> {
  try {
    const record = await prisma.maintenanceReportSettings.findUnique({
      where: { id: MAINTENANCE_REPORT_SETTINGS_ID },
    });
    return normalizeMaintenanceReportSettings(record);
  } catch (err) {
    logger.error(
      { err },
      "Failed to load maintenance report settings; using defaults",
    );
    return { ...DEFAULT_MAINTENANCE_REPORT_SETTINGS };
  }
}

/** When a photo captured now stops being retained. */
export function getMaintenancePhotoExpiresAt(
  retentionDays: number,
  capturedAt: Date = new Date(),
): Date {
  return new Date(
    capturedAt.getTime() +
      clampPhotoRetentionDays(retentionDays) * 24 * 60 * 60 * 1000,
  );
}
