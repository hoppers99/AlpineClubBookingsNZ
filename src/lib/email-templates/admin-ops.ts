/**
 * Admin operations alerts: the daily digest, member-reported issues, the
 * public website's contact form, and the two "an email did not get through"
 * alerts.
 *
 * The family boundary is `src/lib/email/admin-alerts-ops.ts`. The last three
 * arrived in #2689: they used to build their HTML at the send site, which left
 * them unpinnable by the rendered-output gate — a refactor could have changed
 * what an operator receives with nothing going red. Their markup is moved here
 * VERBATIM, so this PR changes no byte of any of them; that several of them do
 * not use `layout()` and so carry no club shell is pre-existing, and making
 * them look like every other admin alert is a content change for another PR.
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

// ---- N-13: Admin Daily Digest ----

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

/**
 * The public website's contact form, delivered to whoever the committee
 * assignment routes it to.
 *
 * Moved verbatim out of `src/app/api/contact/route.ts` (#2689): the markup,
 * the inline colours and the escaping are exactly as that route built them, so
 * the rendered body is unchanged. It deliberately does NOT use `layout()` —
 * that is how it has always looked, and restyling it is a content decision.
 */
export function websiteContactTemplate(data: {
  name: string;
  email: string;
  message: string;
}): string {
  return `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e293b;">New Contact Form Submission</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; font-weight: bold; color: #475569; vertical-align: top; width: 80px;">Name:</td>
              <td style="padding: 8px 0; color: #1e293b;">${escapeHtml(data.name)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-weight: bold; color: #475569; vertical-align: top;">Email:</td>
              <td style="padding: 8px 0; color: #1e293b;"><a href="mailto:${escapeHtml(data.email)}">${escapeHtml(data.email)}</a></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-weight: bold; color: #475569; vertical-align: top;">Message:</td>
              <td style="padding: 8px 0; color: #1e293b; white-space: pre-wrap;">${escapeHtml(data.message)}</td>
            </tr>
          </table>
        </div>
      `;
}

/**
 * `admin-email-failure`, as the retry cron sends it: a member's email has now
 * failed MAX_ATTEMPTS times and will not be tried again.
 *
 * This is the shape the registry's default body describes, which is why it is
 * the one `REGISTRY_KEY_RENDERERS` maps the key to. Moved verbatim out of
 * `src/lib/cron-email-retry.ts` (#2689).
 *
 * Values are interpolated UNESCAPED, exactly as the send site did. `to` and
 * `templateName` are an address and a registry key, not free text, and
 * changing that here would change the rendered bytes — which is the one thing
 * this move must not do. Escaping them is a follow-up worth making on its own.
 */
export function adminEmailDeliveryFailedTemplate(data: {
  recipient: string;
  templateName: string;
  attemptCount: number;
}): string {
  return `<p>Email to ${data.recipient} (template: ${data.templateName}) has failed after ${data.attemptCount} attempts and will not be retried.</p>`;
}

/**
 * `admin-email-failure`, as the FAIL-CLOSED path sends it: a booking's
 * "No emails" flag could not be read, so the message was withheld rather than
 * risk sending one that was meant to be held back (#2258).
 *
 * A second body under the same registry key, which is pre-existing: the key
 * has always carried two different messages. It has no `REGISTRY_KEY_RENDERERS`
 * row of its own because that map is one renderer per key; the render gate
 * still pins it, because the gate walks every exported function in this module.
 *
 * Moved verbatim out of `src/lib/email/core.ts` (#2689). That module already
 * reaches this layer — `core.ts` imports `email-message-renderer`, which
 * imports `email-templates/layout` — so importing a template module here adds
 * no dependency the alert did not already have, and this function is a pure,
 * synchronous string builder with no database, network or provider call in it.
 * That matters more than usual: this is the email that reports an email
 * failure, so it must not be able to fail the same way.
 */
export function adminEmailWithheldTemplate(data: {
  templateName: string;
  bookingId: string;
}): string {
  return (
    `<p>An email to a member was NOT sent and will NOT be retried automatically.</p>` +
    `<p>Template: <strong>${data.templateName}</strong><br/>` +
    `Booking: <strong>${data.bookingId}</strong></p>` +
    `<p>The booking's "No emails" setting could not be read, so the system withheld the message rather than risk sending one that was meant to be held back. ` +
    `The setting itself may well be off — check the booking, then re-send the message if it is.</p>`
  );
}
