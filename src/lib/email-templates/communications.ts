/**
 * Broadcast emails: an admin bulk message, and a committee notice.
 *
 * Sent from the admin communications route and `notices-email.ts` rather than
 * an `src/lib/email/*` sender, so this family has no sender-module twin.
 */
import { escapeHtml } from "./escape";
import { BASE_URL, button, heading, layout, muted } from "./layout";
import { CLUB_NAME } from "@/config/club-identity";
import { emailPalette } from "@/lib/email-theme";

export function bulkCommunicationTemplate(
  subject: string,
  body: string
): string {
  const p = emailPalette();
  return layout(`
    ${heading(escapeHtml(subject))}
    <div style="color: ${p.deep}; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(body)}</div>
    ${muted(`This email was sent to you by the ${escapeHtml(CLUB_NAME)} administration. You can update your email preferences in your account settings.`)}
    ${button("Manage Preferences", BASE_URL + "/profile")}
  `);
}

// ---- Member notice published ----

export function noticePublishedTemplate(
  firstName: string,
  noticeTitle: string,
  noticeUrl: string
): string {
  const p = emailPalette();
  return layout(`
    ${heading("New notice from the committee")}
    <p style="color: ${p.deep}; font-size: 15px; line-height: 1.6;">Hi ${escapeHtml(firstName)},</p>
    <p style="color: ${p.deep}; font-size: 15px; line-height: 1.6;">The ${escapeHtml(CLUB_NAME)} committee has posted a new notice:</p>
    <p style="color: ${p.deep}; font-size: 17px; font-weight: 600; line-height: 1.5;">${escapeHtml(noticeTitle)}</p>
    ${button("Read the notice", noticeUrl)}
    ${muted(`You are receiving this because you opted in to club communications. You can update your email preferences in your account settings.`)}
    ${button("Manage Preferences", BASE_URL + "/profile")}
  `);
}

// ---- N-13: Admin Daily Digest ----
