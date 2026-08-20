import {
  adminDailyDigestTemplate,
  adminIssueReportTemplate,
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
