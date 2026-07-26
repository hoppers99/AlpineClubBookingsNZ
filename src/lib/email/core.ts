import { EMAIL_FROM } from "../email-sender";
import { htmlToPlainText } from "../email-text";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  formatEmailFromAddressWithSettings,
} from "@/lib/email-message-settings";
import {
  prepareEmailMessage,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";
import {
  getActiveEmailSuppression,
  normalizeEmailAddress,
} from "@/lib/email-suppression";
import {
  resolveBookingEmailGate,
  type EmailBookingContext,
} from "@/lib/booking-email-suppression";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";
import {
  getEmailTransporter,
  shouldPersistEmailHtml,
  type EmailAttachment,
} from "./internal";

export type EmailSendOutcome =
  | {
      status: "sent";
      emailLogId: string | null;
      messageId: string | null;
    }
  | {
      status: "suppressed";
      emailLogId: string | null;
      emailSuppressionId: string;
      reason: string;
    }
  // A club-internal walk-in placeholder recipient (#1935): the owner has no
  // real address, so nothing is ever sent — independent of any notify choice.
  | {
      status: "skipped_placeholder_recipient";
      emailLogId: null;
      reason: string;
    }
  // #2258 (owner decision D10): the booking this message belongs to carries the
  // per-booking "No emails" switch, so nothing was transmitted. `reason`
  // separates the deliberate case from the fail-closed one:
  //   booking_no_emails      — the switch is on (EmailLog SKIPPED_NO_EMAILS)
  //   booking_flag_unreadable — the switch could not be read, so the gate
  //                             withheld the send anyway (EmailLog FAILED, so
  //                             the retry cron re-evaluates it later)
  // Callers are NOT expected to act on this: almost every booking send is an
  // un-awaited `.catch(log)`, so the mailer records the outcome itself.
  | {
      status: "withheld_for_booking";
      emailLogId: string | null;
      bookingId: string;
      reason: "booking_no_emails" | "booking_flag_unreadable";
    };

function assertNoCrlf(value: string, field: string) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Email header field ${field} contains CR/LF`);
  }
}

// Defense-in-depth: subject lines interpolate user-controlled member names
// (issue #323). Schema-level sanitization at API boundaries is the first line
// of defense, but a contaminated row from before the fix would still trip the
// CRLF guard on `from`/`to`. Strip CRLF from the subject before send so the
// email never silently fails — `from`/`to` keep the throw because CRLF there
// indicates a configuration/normalizer bug, not user input.
function sanitizeEmailSubject(subject: string) {
  return subject.replace(/[\r\n]+/g, " ").trim();
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  templateName = "unknown",
  templateData,
  attachments,
  logRecipient,
  lodgeId,
  bookingContext,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  templateName?: string;
  templateData?: EmailTemplateData;
  attachments?: EmailAttachment[];
  logRecipient?: string;
  // Lodge whose identity this message carries (multi-lodge phase 8);
  // omitted/null resolves the club's default lodge identity.
  lodgeId?: string | null;
  // Which booking this message belongs to (#2258). REQUIRED and a discriminated
  // union on purpose: every new send site is a compile error until its author
  // states either the real booking id or the explicit `"none"`. A booking-scoped
  // message that passes `"none"` escapes the per-booking "No emails" switch, so
  // thread the real id wherever one exists.
  bookingContext: EmailBookingContext;
}): Promise<EmailSendOutcome> {
  const prepared = await prepareEmailMessage({
    templateName,
    subject,
    html,
    templateData,
    lodgeId,
  });
  const from = formatEmailFromAddressWithSettings(
    prepared.settings,
    EMAIL_FROM,
  );
  const plainTextBody = text || htmlToPlainText(prepared.html);
  const normalizedRecipient = normalizeEmailAddress(to);

  // Walk-in placeholder owners (#1935) have a club-internal, undeliverable
  // `.invalid` address stored so `Member.email` stays non-nullable. No message
  // is ever sent to them — this short-circuits every send path (booking
  // confirmation/hold, waitlist, cron, webhooks) regardless of any per-booking
  // notify choice, and it does not create an EmailLog row (nothing was queued).
  if (isPlaceholderContactEmail(normalizedRecipient)) {
    logger.info(
      { templateName },
      "Skipped email to walk-in placeholder recipient",
    );
    return {
      status: "skipped_placeholder_recipient",
      emailLogId: null,
      reason: "placeholder_recipient",
    };
  }

  const emailLogRecipient = logRecipient?.trim() || to;
  const recipientRedactedInLogs = emailLogRecipient !== to;
  const persistHtmlBody =
    !recipientRedactedInLogs && shouldPersistEmailHtml(templateName);
  const sanitizedSubject = sanitizeEmailSubject(prepared.subject);

  assertNoCrlf(from, "from");
  assertNoCrlf(to, "to");
  assertNoCrlf(normalizedRecipient, "to");
  assertNoCrlf(emailLogRecipient, "logRecipient");

  // Create EmailLog record (fire-and-forget logging won't break email delivery)
  let emailLogId: string | null = null;
  try {
    const log = await prisma.emailLog.create({
      data: {
        to: emailLogRecipient,
        subject: sanitizedSubject,
        templateName,
        htmlBody: persistHtmlBody ? prepared.html : null,
        status: "QUEUED",
        lastAttemptAt: new Date(),
        // #2258: booking attribution on every booking-scoped message, not just
        // withheld ones — the retry cron re-evaluates the switch from this
        // column before it replays a FAILED row.
        bookingId: bookingContext === "none" ? null : bookingContext.bookingId,
      },
    });
    emailLogId = log.id;
  } catch (err) {
    logger.error({ err }, "Failed to create EmailLog record");
  }

  // ---------------------------------------------------------------------
  // Per-booking "No emails" switch (#2258, owner decision D10).
  //
  // Runs BEFORE the SES bounce check and before the dev-mode short-circuit, so
  // no code path below can transmit. Note the deliberate asymmetry with the
  // bounce check further down: THAT one fails open (`.catch(... return null)`)
  // because an unreachable suppression table must not stop the club's mail.
  // This one fails CLOSED — see booking-email-suppression.ts.
  // ---------------------------------------------------------------------
  const bookingGate = await resolveBookingEmailGate(bookingContext, templateName);
  if (bookingGate.decision !== "send") {
    const withheld = bookingGate.decision === "withhold";
    const errorMessage = withheld
      ? 'Withheld: this booking has the "No emails" switch turned on'
      : 'Withheld: the booking\'s "No emails" switch could not be read, so the send failed closed';
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            // A deliberate withhold is terminal and must never be replayed, so
            // it gets its own status and its body is dropped. An unreadable
            // switch is a transient fault: FAILED lets the retry cron pick the
            // row up again, and that cron re-checks the switch before replaying.
            status: withheld ? "SKIPPED_NO_EMAILS" : "FAILED",
            ...(withheld ? { htmlBody: null } : {}),
            errorMessage,
          },
        });
      } catch (err) {
        logger.error(
          { err, to: emailLogRecipient, templateName },
          "Failed to update EmailLog for a withheld booking email",
        );
      }
    }

    logger.warn(
      {
        to: emailLogRecipient,
        templateName,
        bookingId: bookingGate.bookingId,
        failClosed: !withheld,
      },
      withheld
        ? 'Withheld email for a booking with "No emails" turned on'
        : 'Withheld email: the booking\'s "No emails" switch could not be read',
    );

    return {
      status: "withheld_for_booking",
      emailLogId,
      bookingId: bookingGate.bookingId,
      reason: withheld ? "booking_no_emails" : "booking_flag_unreadable",
    };
  }

  const activeSuppression = await getActiveEmailSuppression(
    normalizedRecipient,
  ).catch((err) => {
    logger.error(
      { err, to: emailLogRecipient, templateName },
      "Failed to check email suppression state",
    );
    return null;
  });

  if (activeSuppression) {
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "BOUNCED",
            htmlBody: null,
            errorMessage: `Email suppressed after SES ${activeSuppression.reason.toLowerCase()} feedback`,
          },
        });
      } catch (err) {
        logger.error(
          { err, to: emailLogRecipient },
          "Failed to update suppressed email log",
        );
      }
    }

    logger.warn(
      {
        to: emailLogRecipient,
        templateName,
        emailSuppressionId: activeSuppression.id,
        reason: activeSuppression.reason,
      },
      "Skipped email to suppressed recipient",
    );
    return {
      status: "suppressed",
      emailLogId,
      emailSuppressionId: activeSuppression.id,
      reason: activeSuppression.reason,
    };
  }

  if (process.env.NODE_ENV === "development") {
    logger.info(
      { to: emailLogRecipient, subject: sanitizedSubject, templateName },
      "Email sent (dev mode)",
    );
    if (persistHtmlBody) {
      logger.debug({ html: prepared.html }, "Email HTML content");
    } else {
      logger.debug(
        { templateName },
        "Email HTML content redacted for sensitive template",
      );
    }
    // Mark as SENT in dev mode
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: { status: "SENT", sentAt: new Date() },
        });
      } catch (err) {
        logger.error(
          { err, to: emailLogRecipient, templateName },
          "Failed to update EmailLog",
        );
      }
    }
    return {
      status: "sent",
      emailLogId,
      messageId: null,
    };
  }

  try {
    const { transporter, modeLabel } = getEmailTransporter();
    const result = await transporter.sendMail({
      from,
      to,
      subject: sanitizedSubject,
      html: prepared.html,
      text: plainTextBody,
      attachments,
    });

    logger.debug(
      { templateName, to: emailLogRecipient, mode: modeLabel },
      "Email delivered",
    );

    // Update EmailLog to SENT
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "SENT",
            sentAt: new Date(),
            messageId: result.messageId || null,
          },
        });
      } catch (err) {
        logger.error({ err }, "Failed to update EmailLog to SENT");
      }
    }
    return {
      status: "sent",
      emailLogId,
      messageId: result.messageId || null,
    };
  } catch (err) {
    // Update EmailLog to FAILED
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "FAILED",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
      } catch (logErr) {
        logger.error({ err: logErr }, "Failed to update EmailLog to FAILED");
      }
    }
    if (!persistHtmlBody) {
      logger.warn(
        { templateName },
        "Sensitive email delivery failed and cannot be automatically retried because HTML retention is disabled",
      );
    }
    throw err;
  }
}

/**
 * N-08: Check notification preferences before sending a member email.
 * Maps template categories to preference fields.
 * Admin alerts bypass preferences entirely.
 */
const CATEGORY_TO_PREFERENCE: Record<
  string,
  keyof Omit<
    import("@prisma/client").NotificationPreference,
    "id" | "memberId" | "createdAt" | "updatedAt"
  >
> = {
  bookingConfirmation: "bookingConfirmation",
  bookingReminder: "bookingReminder",
  bookingBumped: "bookingBumped",
  bookingCancelled: "bookingCancelled",
  choreRoster: "choreRoster",
  bookingWaitlist: "bookingWaitlist",
  marketingEmails: "marketingEmails",
};

// test seam
export async function shouldSendEmail(
  memberId: string,
  category: string,
): Promise<boolean> {
  const prefField = CATEGORY_TO_PREFERENCE[category];
  if (!prefField) {
    // Unknown category — default to sending
    return true;
  }

  const pref = await prisma.notificationPreference.findUnique({
    where: { memberId },
  });

  if (!pref) {
    // No preference record = defaults (all true except marketingEmails)
    return category !== "marketingEmails";
  }

  return Boolean(pref[prefField]);
}

/**
 * Resolve whether a chore-roster email should be sent to a specific booking
 * guest, honoring the "Chore Roster" notification preference.
 *
 * #1285 Option C (hybrid — owner decision). Chore rosters are delivered per
 * guest, and a dependent guest's mail is delivered to the primary member's
 * inbox (see `getEffectiveEmail`, which resolves delivery via
 * `inheritEmailFromId`). Preference resolution mirrors that delivery:
 *
 *   1. If the guest has their OWN `NotificationPreference` row, it wins — a
 *      full member with their own login controls their own chore-roster mail.
 *   2. If the guest has NO own row but inherits their email from a primary
 *      member (`inheritEmailFromId`), fall back to that primary's preference,
 *      since the roster lands in the primary's inbox.
 *   3. If neither has a row (or the guest is a non-member with no member id),
 *      default to SENDING — preserving the documented "no preference → send"
 *      contract for optional/operational mail.
 */
export async function shouldSendChoreRoster(
  memberId: string | null | undefined,
  inheritEmailFromId: string | null | undefined,
): Promise<boolean> {
  // Non-member guest: no member record, no preference to consult → send.
  if (!memberId) return true;

  // The guest's own preference row wins when it exists.
  const ownPref = await prisma.notificationPreference.findUnique({
    where: { memberId },
  });
  if (ownPref) return Boolean(ownPref.choreRoster);

  // No own row: an inherited-email dependent follows the primary whose inbox
  // actually receives the mail. `shouldSendEmail` returns the documented
  // "no preference → send" default when the primary has no row either.
  if (inheritEmailFromId) {
    return shouldSendEmail(inheritEmailFromId, "choreRoster");
  }

  // No own row and not inheriting from anyone: preserve "no preference → send".
  return true;
}
