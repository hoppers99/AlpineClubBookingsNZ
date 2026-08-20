import { prisma } from "@/lib/prisma";

/**
 * Retention for maintenance-report photos and submitter fingerprints (#2780).
 *
 * THIS IS THE ISSUE-REPORT PATTERN, REUSED RATHER THAN REINVENTED. It is the
 * same shape as `src/lib/issue-report-retention.ts`: the expiry is stamped on
 * the row at submit time, and a daily cron REDACTS the sensitive columns in
 * place with `updateMany` rather than deleting the row. The report itself is
 * operational history a club needs — "the pump failed twice last winter" — and
 * survives; what expires is the photo and the fingerprint of whoever sent it.
 *
 * The one difference from the issue-report helper is where the window comes
 * from. There it is a hardcoded 30 days; here it is
 * `MaintenanceReportSettings.photoRetentionDays`, because a club could
 * reasonably answer that differently (INV-CONFIG-001). The window is resolved
 * ONCE, at submit time, and written onto the row — so lengthening the setting
 * never un-expires a photo already due, and shortening it never retroactively
 * destroys one a club expected to keep. Both are properties of stamping the
 * absolute expiry rather than recomputing it at sweep time.
 *
 * Both this and the issue-report helper are driven by the SAME cron route,
 * `POST /api/cron/issue-reports`. One sweep, two redactions, one schedule for an
 * operator to keep working — rather than a second cron entry that a club
 * upgrading would have to be told to add.
 */

const RETENTION_EXPIRED_REASON = "retention_expired";

type MaintenanceReportRetentionClient = Pick<typeof prisma, "maintenanceReport">;

export async function redactExpiredMaintenanceReportSensitiveData(
  now: Date = new Date(),
  db: MaintenanceReportRetentionClient = prisma,
) {
  const [photos, fingerprints] = await Promise.all([
    db.maintenanceReport.updateMany({
      where: {
        photoDataUrl: { not: null },
        photoExpiresAt: { lte: now },
      },
      data: {
        photoDataUrl: null,
        // The content type goes with the bytes: keeping it would describe a
        // photo nobody can look at any more.
        photoContentType: null,
        photoDeletedAt: now,
        photoDeletedById: null,
        photoDeleteReason: RETENTION_EXPIRED_REASON,
      },
    }),
    db.maintenanceReport.updateMany({
      where: {
        submitterIpHash: { not: null },
        submitterIpHashExpiresAt: { lte: now },
      },
      data: {
        submitterIpHash: null,
        submitterIpHashDeletedAt: now,
      },
    }),
  ]);

  return {
    maintenancePhotosRedacted: photos.count,
    maintenanceSubmitterFingerprintsRedacted: fingerprints.count,
  };
}
