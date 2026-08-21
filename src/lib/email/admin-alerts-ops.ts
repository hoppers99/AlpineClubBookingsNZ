import {
  adminDailyDigestTemplate,
  adminIssueReportTemplate,
  adminMaintenanceReportTemplate,
} from "@/lib/email-templates/admin-ops";
import { sendToAdmins } from "./admin-alerts-shared";
import { renderEmailHtml } from "@/lib/email-theme";

// N-13: Admin daily digest
export async function sendAdminDailyDigestAlert(sections: {
  newBookings: number;
  paymentFailures: number;
  capacityWarnings: number;
  bookingsBumped: number;
  pendingDeadlines: number;
  xeroErrors: number;
  totalAlerts: number;
}) {
  await sendToAdmins({
    subject: `Admin Daily Digest - ${sections.totalAlerts} alert${sections.totalAlerts !== 1 ? "s" : ""} in past 24h`,
    html: await renderEmailHtml(() => adminDailyDigestTemplate(sections)),
    templateName: "admin-daily-digest",
    templateData: {
      ...sections,
      count: sections.totalAlerts,
      s: sections.totalAlerts === 1 ? "" : "s",
    },
    preferenceKey: "adminDailyDigest",
  });
}

export async function sendAdminIssueReportAlert(data: {
  memberName: string;
  memberEmail: string;
  pageUrl: string;
  pageTitle?: string | null;
  description: string;
  issueReportUrl: string;
  hasScreenshot: boolean;
}) {
  await sendToAdmins({
    subject: `Issue Report: ${data.memberName}`,
    html: await renderEmailHtml(() => adminIssueReportTemplate({
      memberName: data.memberName,
      memberEmail: data.memberEmail,
      pageUrl: data.pageUrl,
      pageTitle: data.pageTitle,
      description: data.description,
      issueReportUrl: data.issueReportUrl,
      hasScreenshot: data.hasScreenshot,
    })),
    templateName: "admin-issue-report",
    templateData: {
      ...data,
      pageTitle: data.pageTitle ?? data.pageUrl,
    },
    preferenceKey: "adminIssueReport",
  });
}

/**
 * #2780: a maintenance report was lodged.
 *
 * WHO GETS THIS is not decided here. `sendToAdmins` resolves the audience from
 * the access-role matrix via the `adminMaintenanceReport` preference key, whose
 * requirement is `{ area: "lodge", level: "edit" }` — so "the maintenance
 * officer" is whoever the club has given Lodge Operations to, and a club with a
 * different committee shape changes a permission rather than a line of code.
 * The club-wide delivery rules at /admin/notification-rules still sit upstream
 * and can mute it entirely.
 *
 * `answersText` is the plain-text rendering of the same answers the HTML shows,
 * so an operator who has rewritten this template at /admin/email-messages gets
 * the answers too rather than a message that silently drops them.
 */
export async function sendAdminMaintenanceReportAlert(data: {
  lodgeName: string;
  reportedBy: string;
  sourceLabel: string;
  photoLabel: string;
  summary: string;
  answers: Array<{ label: string; value: string }>;
  maintenanceReportUrl: string;
}) {
  const answersText = data.answers
    .map((answer) => `${answer.label}: ${answer.value}`)
    .join("\n");

  await sendToAdmins({
    subject: `Maintenance report: ${data.lodgeName}`,
    html: await renderEmailHtml(() => adminMaintenanceReportTemplate(data)),
    templateName: "admin-maintenance-report",
    templateData: {
      lodgeName: data.lodgeName,
      reportedBy: data.reportedBy,
      sourceLabel: data.sourceLabel,
      photoLabel: data.photoLabel,
      summary: data.summary,
      answersText,
      maintenanceReportUrl: data.maintenanceReportUrl,
    },
    preferenceKey: "adminMaintenanceReport",
  });
}
