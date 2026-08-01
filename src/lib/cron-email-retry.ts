import { prisma } from "./prisma";
import nodemailer from "nodemailer";
import { EMAIL_FROM, formatEmailFromAddress } from "./email-sender";
import { htmlToPlainText } from "./email-text";
import logger from "@/lib/logger";
import { resolveEmailDeliveryConfig } from "@/lib/email-delivery";
import { getActiveEmailSuppression } from "@/lib/email-suppression";
import {
  ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES,
  resolveBookingEmailGate,
} from "@/lib/booking-email-suppression";
import { resolveBookingEmailLink } from "@/lib/booking-email-authority";
import {
  finalizeBookingEmailHtml,
  hasBookingDetailHref,
} from "@/lib/booking-email-html";

const MAX_ATTEMPTS = 3;
const RETRY_FAILURE_ALERT_TEMPLATE = "admin-email-failure";

async function retireUnverifiableBookingEmail(params: {
  emailLogId: string;
  bookingId: string;
  templateName: string;
  to: string;
  expectedAttempts: number;
  expectedHtmlBody: string;
  errorMessage: string;
  logMessage: string;
}): Promise<void> {
  const retired = await prisma.emailLog
    .updateMany({
      where: {
        id: params.emailLogId,
        status: "FAILED",
        attempts: params.expectedAttempts,
        htmlBody: params.expectedHtmlBody,
      },
      data: {
        attempts: MAX_ATTEMPTS,
        lastAttemptAt: new Date(),
        htmlBody: null,
        errorMessage: params.errorMessage,
      },
    })
    .catch((err) => {
      logger.error(
        { err, emailLogId: params.emailLogId, bookingId: params.bookingId },
        "Failed to retire an unverifiable booking email",
      );
      return { count: 0 };
    });
  if (retired.count !== 1) return;
  logger.warn(
    {
      emailLogId: params.emailLogId,
      bookingId: params.bookingId,
      templateName: params.templateName,
      to: params.to,
    },
    params.logMessage,
  );
}

/**
 * N-11: Retry failed emails with backoff.
 * Queries EmailLog for FAILED records with attempts < 3 and re-sends.
 * Token-bearing templates are intentionally excluded because their HTML bodies
 * are not retained in EmailLog.
 * SES/SNS bounce and complaint feedback marks undeliverable messages as
 * BOUNCED, so they are excluded from retry recovery. Suppression is
 * re-checked per row before each retry send (F26, #1885) because a FAILED
 * row can predate the suppression that SNS feedback created.
 * Each row is claimed (FAILED -> QUEUED) with a guarded update before the
 * send so an interrupted or concurrent run can never deliver the same email
 * twice (F33, #1885).
 * Runs every 30 minutes.
 */
export async function retryFailedEmails(): Promise<{
  retried: number;
  succeeded: number;
  failed: number;
}> {
  const emailDelivery = resolveEmailDeliveryConfig();
  if (!emailDelivery.ok || !emailDelivery.transportOptions) {
    throw new Error(
      `Email retry skipped: delivery config invalid (${emailDelivery.issues.join("; ")})`,
    );
  }
  const transporter = nodemailer.createTransport(
    emailDelivery.transportOptions,
  );

  // Backoff: don't retry emails until at least 15 minutes after the last attempt
  const backoffThreshold = new Date(Date.now() - 15 * 60 * 1000);

  const failedEmails = await prisma.emailLog.findMany({
    where: {
      status: "FAILED",
      attempts: { lt: MAX_ATTEMPTS },
      htmlBody: { not: null },
      lastAttemptAt: { not: { gte: backoffThreshold } },
    },
    orderBy: { createdAt: "asc" },
    take: 50, // Process in batches to avoid overload
  });

  let retried = 0;
  let succeeded = 0;
  let failed = 0;

  for (const emailLog of failedEmails) {
    let retryHtml = emailLog.htmlBody!;
    // F26 (#1885): a FAILED row can be created before an SNS bounce/complaint
    // suppresses the recipient (the pre-send check in core.ts passed, then the
    // SMTP send failed after the suppression landed). Re-check here so a
    // suppressed recipient is never re-delivered. Mirrors core.ts: on check
    // failure proceed (fail-open, same as the pre-send path); on an active
    // suppression mark the row BOUNCED with the same reason string and drop
    // the retained body.
    const activeSuppression = await getActiveEmailSuppression(
      emailLog.to,
    ).catch((err) => {
      logger.error(
        { err, to: emailLog.to, templateName: emailLog.templateName },
        "Failed to check email suppression state before retry",
      );
      return null;
    });

    if (activeSuppression) {
      await prisma.emailLog
        .update({
          where: { id: emailLog.id },
          data: {
            status: "BOUNCED",
            htmlBody: null,
            errorMessage: `Email suppressed after SES ${activeSuppression.reason.toLowerCase()} feedback`,
          },
        })
        .catch((err) => {
          logger.error(
            { err, emailLogId: emailLog.id },
            "Failed to update suppressed email log during retry",
          );
        });
      logger.warn(
        {
          to: emailLog.to,
          templateName: emailLog.templateName,
          emailSuppressionId: activeSuppression.id,
          reason: activeSuppression.reason,
        },
        "Skipped email retry to suppressed recipient",
      );
      // A suppressed skip is not a retry attempt.
      continue;
    }

    // #2258: this cron replays a retained body through its OWN nodemailer
    // transport, so it never passes back through sendEmail's gate. A FAILED row
    // can easily predate the moment an admin turned the booking's "No emails"
    // switch on — including the fail-closed FAILED row the gate itself writes
    // when it cannot read the switch — so re-evaluate the switch from the row's
    // bookingId before EVERY replay, and fail closed the same way the mailer
    // does.
    //
    // Rows with NO bookingId fall into two groups. Most are account, security,
    // membership, family and admin mail, which the switch must never touch and
    // which replay unchanged. But EmailLog.bookingId did not exist before the
    // #2258 migration, so every row queued by the previous release is NULL —
    // including booking-scoped ones. In the window after deploy such a row could
    // otherwise replay a confirmation for a booking that has since been
    // silenced. When the template is one that is ALWAYS about a booking, refuse
    // the replay and leave the row FAILED, so it stays in the operator's
    // email-failure review queue instead of going out or vanishing.
    if (!emailLog.bookingId) {
      if (ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has(emailLog.templateName)) {
        // Retire the row TERMINALLY rather than leaving it as found. Leaving it
        // at attempts < 3 would have been the worst of both worlds: the row is
        // below the >=3 threshold the operator review queue reads, so it would
        // surface NOWHERE; and it stays inside this cron's selection window
        // (status FAILED, attempts < MAX, retained body) forever, so once fifty
        // such rows exist the batch of 50 is refilled with the same stuck rows
        // every run and retry dies for every newer email behind them.
        // Pushing attempts to MAX_ATTEMPTS drops it out of the query and lands
        // it in the review queue, which is what the operator needs.
        await prisma.emailLog
          .update({
            where: { id: emailLog.id },
            data: {
              attempts: MAX_ATTEMPTS,
              lastAttemptAt: new Date(),
              errorMessage:
                "Not retried: this booking email predates the per-booking \"No emails\" switch (#2258) and carries no booking, so it cannot be checked against it. Re-send it by hand if the booking still needs it.",
            },
          })
          .catch((err) => {
            logger.error(
              { err, emailLogId: emailLog.id },
              "Failed to retire an unattributable booking email",
            );
          });
        logger.warn(
          {
            emailLogId: emailLog.id,
            templateName: emailLog.templateName,
            to: emailLog.to,
            expectedAttempts: emailLog.attempts,
            expectedHtmlBody: retryHtml,
          },
          "Retired a booking-scoped email with no recorded booking (queued before #2258); it cannot be checked against the booking's \"No emails\" switch",
        );
        // Not a retry attempt: nothing was sent.
        continue;
      }
    } else {
      const bookingGate = await resolveBookingEmailGate(
        { bookingId: emailLog.bookingId },
        emailLog.templateName,
      );
      if (bookingGate.decision === "unknown") {
        // Fail closed: leave the row FAILED and untouched so a later run (with
        // a healthy database) decides. Not a retry attempt.
        logger.error(
          { emailLogId: emailLog.id, bookingId: emailLog.bookingId },
          "Skipped email retry: the booking's \"No emails\" switch could not be read",
        );
        continue;
      }
      if (bookingGate.decision === "withhold") {
        await prisma.emailLog
          .update({
            where: { id: emailLog.id },
            data: {
              status: "SKIPPED_NO_EMAILS",
              htmlBody: null,
              errorMessage:
                'Withheld: this booking has the "No emails" switch turned on',
            },
          })
          .catch((err) => {
            logger.error(
              { err, emailLogId: emailLog.id },
              "Failed to mark a retry as withheld for a no-emails booking",
            );
          });
        logger.warn(
          {
            to: emailLog.to,
            templateName: emailLog.templateName,
            bookingId: emailLog.bookingId,
          },
          'Skipped email retry for a booking with "No emails" turned on',
        );
        // A withheld skip is not a retry attempt.
        continue;
      }

      if (ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has(emailLog.templateName)) {
        // #2362: `bookingId` is not enough to repeat the privacy decision. An
        // email address is not authority, and old rows do not record the member
        // id or whether the retained body came from an admin override. Retire
        // those rows instead of replaying a previously-authorized URL blind.
        if (
          emailLog.bookingBodyOverrideApplied == null ||
          emailLog.bookingDetailLinkIncluded == null
        ) {
          await retireUnverifiableBookingEmail({
            emailLogId: emailLog.id,
            bookingId: emailLog.bookingId,
            templateName: emailLog.templateName,
            to: emailLog.to,
            expectedAttempts: emailLog.attempts,
            expectedHtmlBody: retryHtml,
            errorMessage:
              "Not retried: this booking email predates retry-time recipient authorization context (#2362). Re-send it by hand if the recipient still needs it.",
            logMessage:
              "Retired a booking email with no durable retry-time recipient authorization context",
          });
          continue;
        }

        // The boolean was computed with the then-current application origin.
        // If configuration drift means the retained href can no longer be
        // located by the same-origin matcher, do not append a second link or
        // send an old one that cannot be safely removed.
        if (
          emailLog.bookingDetailLinkIncluded &&
          !hasBookingDetailHref(retryHtml)
        ) {
          await retireUnverifiableBookingEmail({
            emailLogId: emailLog.id,
            bookingId: emailLog.bookingId,
            templateName: emailLog.templateName,
            to: emailLog.to,
            expectedAttempts: emailLog.attempts,
            expectedHtmlBody: retryHtml,
            errorMessage:
              "Not retried: the retained booking-detail link could not be safely located under the current application URL (#2362). Re-send it by hand after reviewing the recipient and deployment URL.",
            logMessage:
              "Retired a booking email whose retained detail link could not be safely re-finalized",
          });
          continue;
        }

        const bookingLink = await resolveBookingEmailLink({
          bookingId: emailLog.bookingId,
          templateName: emailLog.templateName,
          recipient: emailLog.bookingRecipientMemberId
            ? { kind: "member", memberId: emailLog.bookingRecipientMemberId }
            : { kind: "non-login-public-contact" },
        });

        if (emailLog.bookingBodyOverrideApplied) {
          // Stored overrides remain byte-for-byte admin-authored contracts. If
          // one retained an authenticated booking href that the recipient may
          // no longer use, fail closed instead of silently rewriting the
          // override or sending the stale disclosure.
          if (!bookingLink.bookingUrl && emailLog.bookingDetailLinkIncluded) {
            await retireUnverifiableBookingEmail({
              emailLogId: emailLog.id,
              bookingId: emailLog.bookingId,
              templateName: emailLog.templateName,
              to: emailLog.to,
              expectedAttempts: emailLog.attempts,
              expectedHtmlBody: retryHtml,
              errorMessage:
                "Not retried: the recipient no longer has access to the retained booking-detail link, and the stored body override cannot be rewritten (#2362). Re-send it by hand after reviewing the recipient and template.",
              logMessage:
                "Retired a stored-override booking email after recipient authority was revoked",
            });
            continue;
          }
        } else {
          retryHtml = finalizeBookingEmailHtml({
            html: retryHtml,
            bookingUrl: bookingLink.bookingUrl,
            bookingScoped: true,
            bodyOverrideApplied: false,
          });
        }
      }
    }

    const newAttempts = emailLog.attempts + 1;

    // F33 (#1885): claim the row before sending. If a previous run crashed
    // after SES accepted the message but before the SENT write committed, the
    // row is no longer FAILED, the claim finds nothing, and we never
    // double-send. Two overlapping cron runs race the same guarded update and
    // only one wins.
    const claim = await prisma.emailLog.updateMany({
      where: {
        id: emailLog.id,
        status: "FAILED",
        attempts: emailLog.attempts,
        htmlBody: emailLog.htmlBody,
      },
      data: {
        status: "QUEUED",
        attempts: newAttempts,
        lastAttemptAt: new Date(),
        ...(retryHtml !== emailLog.htmlBody ? { htmlBody: retryHtml } : {}),
      },
    });
    if (claim.count !== 1) {
      // Already claimed (or resolved) by another run — not a retry attempt.
      continue;
    }

    retried++;

    if (process.env.NODE_ENV === "development") {
      logger.info(
        { to: emailLog.to, subject: emailLog.subject },
        "Email retry (dev mode)",
      );
      await prisma.emailLog
        .update({
          where: { id: emailLog.id },
          data: {
            status: "SENT",
            sentAt: new Date(),
            errorMessage: null,
          },
        })
        .catch((err) => {
          logger.error(
            { err, emailLogId: emailLog.id },
            "Failed to update EmailLog to SENT after dev-mode retry",
          );
        });
      succeeded++;
      continue;
    }

    let result: Awaited<ReturnType<typeof transporter.sendMail>>;
    try {
      result = await transporter.sendMail({
        from: formatEmailFromAddress(EMAIL_FROM),
        to: emailLog.to,
        subject: emailLog.subject,
        html: retryHtml,
        text: htmlToPlainText(retryHtml),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, emailLogId: emailLog.id, attempt: newAttempts },
        "Email retry failed",
      );

      await prisma.emailLog
        .update({
          where: { id: emailLog.id },
          data: {
            // Restore FAILED (the claim moved the row to QUEUED) — will
            // retry again if attempts < MAX.
            status: "FAILED",
            attempts: newAttempts,
            lastAttemptAt: new Date(),
            errorMessage,
          },
        })
        .catch((updateErr) => {
          logger.error(
            { err: updateErr, emailLogId: emailLog.id },
            "Failed to update EmailLog after retry failure",
          );
        });

      // Alert admin when email exhausts retries
      if (
        newAttempts >= MAX_ATTEMPTS &&
        emailLog.templateName !== RETRY_FAILURE_ALERT_TEMPLATE
      ) {
        try {
          const { sendEmail } = await import("./email");
          const admins = await prisma.member.findMany({
            where: { role: "ADMIN", active: true },
            select: { email: true },
          });
          for (const admin of admins) {
            await sendEmail({
              to: admin.email,
              subject: "Email delivery permanently failed",
              html: `<p>Email to ${emailLog.to} (template: ${emailLog.templateName}) has failed after ${newAttempts} attempts and will not be retried.</p>`,
              // Admin failure alert: never withheld by a booking flag (#2258).
              bookingContext: "none",
              templateName: RETRY_FAILURE_ALERT_TEMPLATE,
              templateData: {
                originalRecipient: emailLog.to,
                originalTemplateName: emailLog.templateName,
                attemptCount: newAttempts,
              },
            }).catch(() => {}); // Don't let alert failure break the cron
          }
        } catch {
          // Non-critical
        }
      }

      failed++;
      continue;
    }

    // The provider accepted the message. If this SENT write fails, leave the
    // row QUEUED (claimed) rather than restoring FAILED: a FAILED row would
    // be re-sent on the next run even though the email already went out
    // (F33, #1885). At-most-once beats a duplicate money-adjacent email.
    await prisma.emailLog
      .update({
        where: { id: emailLog.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          messageId: result.messageId || null,
          errorMessage: null,
        },
      })
      .catch((err) => {
        logger.error(
          { err, emailLogId: emailLog.id },
          "Failed to update EmailLog to SENT after retry; leaving the row QUEUED so it is not re-sent",
        );
      });
    succeeded++;
  }

  return { retried, succeeded, failed };
}
