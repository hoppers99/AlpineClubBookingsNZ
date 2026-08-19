import type { Prisma } from "@prisma/client";

/**
 * The admin queue's read shape (#2780).
 *
 * ONE SELECT AND ONE MAPPER, shared by the list route, the detail route and the
 * page's server load, so the three cannot disagree about what an officer is shown
 * — in particular about whether a photo is still retained, which is a privacy
 * answer and not a rendering detail.
 *
 * THE PHOTO IS NOT RETURNED BY THE LIST. `MAINTENANCE_REPORT_LIST_SELECT` omits
 * `photoDataUrl` deliberately: a page of twenty reports would otherwise ship up to
 * eighty megabytes of base64 to a phone, and the list has no use for the bytes.
 * The detail select adds them.
 */

export const MAINTENANCE_REPORT_LIST_SELECT = {
  id: true,
  lodgeId: true,
  source: true,
  status: true,
  summary: true,
  reporterName: true,
  reporterContact: true,
  photoContentType: true,
  photoCapturedAt: true,
  photoExpiresAt: true,
  photoDeletedAt: true,
  photoDeleteReason: true,
  resolvedAt: true,
  resolutionNote: true,
  createdAt: true,
  updatedAt: true,
  lodge: { select: { id: true, name: true } },
  member: { select: { id: true, firstName: true, lastName: true, email: true } },
  answers: {
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      questionLabel: true,
      questionType: true,
      answerText: true,
    },
  },
} satisfies Prisma.MaintenanceReportSelect;

export const MAINTENANCE_REPORT_DETAIL_SELECT = {
  ...MAINTENANCE_REPORT_LIST_SELECT,
  photoDataUrl: true,
} satisfies Prisma.MaintenanceReportSelect;

type ListRow = Prisma.MaintenanceReportGetPayload<{
  select: typeof MAINTENANCE_REPORT_LIST_SELECT;
}>;
type DetailRow = Prisma.MaintenanceReportGetPayload<{
  select: typeof MAINTENANCE_REPORT_DETAIL_SELECT;
}>;

/**
 * Is the photo still there to look at?
 *
 * Checked against the clock as well as against `photoDeletedAt`, because the
 * retention cron runs daily: between a photo's expiry and the next sweep the bytes
 * are still in the row, and showing them would quietly extend the window the club
 * told its members about. So an expired photo reads as gone from the moment it
 * expires, and the cron's job is to remove the bytes rather than to decide
 * visibility. Mirrors the issue-report admin mapper.
 */
function photoRetained(
  report: {
    photoCapturedAt: Date | null;
    photoExpiresAt: Date | null;
    photoDeletedAt: Date | null;
  },
  now: Date,
): boolean {
  if (!report.photoCapturedAt || report.photoDeletedAt) return false;
  return !report.photoExpiresAt || report.photoExpiresAt > now;
}

function mapCommon(report: ListRow, now: Date) {
  const retained = photoRetained(report, now);
  return {
    id: report.id,
    lodge: report.lodge,
    source: report.source,
    status: report.status,
    summary: report.summary,
    // Free text a stranger typed on the QR path, and null on the member path.
    // Named `selfDeclared*` rather than `reporter*` all the way out to the UI so
    // nothing downstream can mistake it for an identity the application verified.
    selfDeclaredName: report.reporterName,
    selfDeclaredContact: report.reporterContact,
    member: report.member,
    photo: {
      contentType: retained ? report.photoContentType : null,
      capturedAt: report.photoCapturedAt,
      expiresAt: report.photoExpiresAt,
      deletedAt: report.photoDeletedAt,
      deleteReason: report.photoDeleteReason,
      retained,
    },
    resolvedAt: report.resolvedAt,
    resolutionNote: report.resolutionNote,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    answers: report.answers,
  };
}

export function mapMaintenanceReportForList(report: ListRow, now = new Date()) {
  return mapCommon(report, now);
}

export function mapMaintenanceReportForDetail(report: DetailRow, now = new Date()) {
  const base = mapCommon(report, now);
  return {
    ...base,
    photo: {
      ...base.photo,
      // Withheld once expired even though the bytes are still in the row — see
      // `photoRetained` above.
      dataUrl: base.photo.retained ? report.photoDataUrl : null,
    },
  };
}

export type AdminMaintenanceReportListItem = ReturnType<
  typeof mapMaintenanceReportForList
>;
export type AdminMaintenanceReportDetail = ReturnType<
  typeof mapMaintenanceReportForDetail
>;
