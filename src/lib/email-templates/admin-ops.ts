/**
 * Admin operations alerts: the daily digest and member-reported issues.
 *
 * The family boundary is `src/lib/email/admin-alerts-ops.ts`.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  BASE_URL,
  button,
  heading,
  infoTable,
  layout,
  paragraph,
} from "./layout";
import { emailPalette } from "@/lib/email-theme";

export function adminDailyDigestTemplate(sections: {
  newBookings: number;
  paymentFailures: number;
  capacityWarnings: number;
  bookingsBumped: number;
  pendingDeadlines: number;
  xeroErrors: number;
  totalAlerts: number;
}): string {
  const p = emailPalette();
  const rows: Array<{ label: string; value: string; link: string }> = [];

  if (sections.newBookings > 0) rows.push({ label: "New Bookings", value: String(sections.newBookings), link: "/admin/bookings" });
  if (sections.paymentFailures > 0) rows.push({ label: "Payment Failures", value: String(sections.paymentFailures), link: "/admin/payments" });
  if (sections.capacityWarnings > 0) rows.push({ label: "Capacity Warnings", value: String(sections.capacityWarnings), link: "/admin/bookings" });
  if (sections.bookingsBumped > 0) rows.push({ label: "Bookings Bumped", value: String(sections.bookingsBumped), link: "/admin/bookings" });
  if (sections.pendingDeadlines > 0) rows.push({ label: "Pending Deadlines", value: String(sections.pendingDeadlines), link: "/admin/bookings" });
  if (sections.xeroErrors > 0) rows.push({ label: "Xero Errors", value: String(sections.xeroErrors), link: "/admin/xero" });

  const tableRowsHtml = rows
    .map(
      (r) => `
    <tr>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${r.label}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep}; font-weight: 700;">${r.value}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist};"><a href="${BASE_URL}${r.link}" style="color: ${p.gold}; text-decoration: none;">View</a></td>
    </tr>`
    )
    .join("");

  const noAlerts = rows.length === 0
    ? paragraph("No alerts were triggered in the past 24 hours. All systems running normally.")
    : "";

  return layout(`
    ${heading("Admin Daily Digest")}
    ${paragraph("Summary of admin alerts from the past 24 hours.")}
    ${noAlerts}
    ${rows.length > 0 ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Alert Type</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Count</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Action</th>
      </tr>
      ${tableRowsHtml}
    </table>` : ""}
    ${paragraph("<strong>Total alerts:</strong> " + sections.totalAlerts)}
    ${button("Open Admin Dashboard", BASE_URL + "/admin/dashboard")}
  `);
}

export function adminIssueReportTemplate(data: {
  memberName: string;
  memberEmail: string;
  pageUrl: string;
  pageTitle?: string | null;
  description: string;
  issueReportUrl: string;
  hasScreenshot: boolean;
}): string {
  return layout(`
    ${heading("Issue Report Submitted")}
    ${paragraph(escapeHtml(data.memberName) + " has reported an issue from the bookings site.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Email", value: escapeHtml(data.memberEmail) },
      { label: "Page", value: escapeHtml(data.pageTitle || data.pageUrl) },
      { label: "Screenshot", value: data.hasScreenshot ? "Available in admin" : "Not included" },
    ])}
    ${alertBox(escapeHtml(data.description), "info")}
    ${button("Review Issue Report", data.issueReportUrl, { sameOrigin: true })}
    ${button("Open Reported Page", data.pageUrl, { sameOrigin: true })}
  `);
}
