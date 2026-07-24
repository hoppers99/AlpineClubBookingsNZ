import "server-only";

import { getAppBaseUrl } from "@/lib/app-url";
import { sendEmail } from "@/lib/email";
import { noticePublishedTemplate } from "@/lib/email-templates";
import logger from "@/lib/logger";
import { resolveNoticeAudienceMembers } from "@/lib/notices";
import { prisma } from "@/lib/prisma";

// Throttling mirrors the admin bulk-communication send loop so a large audience
// never overwhelms SMTP.
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

/**
 * Email a published notice to its audience. Runs OUTSIDE any DB transaction and
 * is intended to be invoked fire-and-forget AFTER the publish transaction
 * commits and AFTER the caller has claimed the single-send guard (emailedAt).
 *
 * Preference + suppression handling mirrors the Communications bulk send:
 *  - recipients are filtered to those who opted in to `marketingEmails` (the
 *    same opt-in club-communication preference the bulk-communication path
 *    uses; no dedicated notice preference exists — see the carry-forward note);
 *  - EmailSuppression is enforced automatically inside sendEmail.
 *
 * The financialMembersOnly audience filter is already applied by
 * resolveNoticeAudienceMembers.
 */
export async function sendNoticePublishedEmails(
  noticeId: string,
): Promise<{ sent: number; skipped: number }> {
  const notice = await prisma.notice.findUnique({
    where: { id: noticeId },
    select: { id: true, title: true, status: true },
  });
  if (!notice || notice.status !== "PUBLISHED") {
    return { sent: 0, skipped: 0 };
  }

  const audience = await resolveNoticeAudienceMembers(noticeId);
  if (audience.length === 0) {
    return { sent: 0, skipped: 0 };
  }

  // Filter to members opted in to club communications (marketingEmails).
  const prefs = await prisma.member.findMany({
    where: { id: { in: audience.map((a) => a.memberId) } },
    select: {
      id: true,
      firstName: true,
      notificationPreference: { select: { marketingEmails: true } },
    },
  });
  const firstNameById = new Map(prefs.map((p) => [p.id, p.firstName]));
  const optedIn = new Set(
    prefs
      .filter((p) => p.notificationPreference?.marketingEmails === true)
      .map((p) => p.id),
  );

  const recipients = audience.filter((a) => optedIn.has(a.memberId));
  const noticeUrl = `${getAppBaseUrl()}/notices/${noticeId}`;

  let sent = 0;
  let skipped = audience.length - recipients.length;

  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];
    const firstName = firstNameById.get(recipient.memberId) ?? "there";
    try {
      const outcome = await sendEmail({
        to: recipient.email,
        subject: `New notice: ${notice.title}`,
        html: noticePublishedTemplate(firstName, notice.title, noticeUrl),
        templateName: "notice-published",
        templateData: {
          firstName,
          noticeTitle: notice.title,
          noticeUrl,
        },
      });
      if (outcome.status === "sent") {
        sent += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      skipped += 1;
      logger.error(
        { err, memberId: recipient.memberId, noticeId },
        "Failed to send notice-published email",
      );
    }

    if ((i + 1) % BATCH_SIZE === 0 && i + 1 < recipients.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return { sent, skipped };
}
