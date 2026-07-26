import { EmailLogStatus } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";

/**
 * Per-booking "No emails" switch (#2258, owner decision D10).
 *
 * A booking can be put into a state where the system withholds EVERYTHING it
 * would otherwise send about that booking: confirmation, modification, payment,
 * reminders, arrival information, cancellation, waitlist offers, chore rosters,
 * and even the invoice email Xero would send on our behalf. This module owns the
 * mechanism; the booking-page warning banner that lists what was withheld is
 * issue #2259 and reads {@link getWithheldBookingEmails}.
 *
 * Three rules make this safe:
 *
 *  1. **Keyed strictly on the booking, never on the recipient address.** An
 *     address-keyed shortcut would also swallow two-factor codes, password
 *     resets, magic-link logins and email-change notices (src/lib/email/
 *     account.ts). That is account lockout, not a mail preference.
 *  2. **Admin-audience mail is never withheld.** Admin/system alerts exist so an
 *     operator finds out something went wrong; the registry's
 *     `EmailTemplateDefinition.audience` is the single source of truth
 *     (see {@link isBookingSuppressibleTemplate}).
 *  3. **The read fails CLOSED.** The SES bounce check in `email/core.ts`
 *     deliberately fails OPEN (an unreachable suppression table must not stop
 *     the club's mail). This gate is the opposite: an unreadable switch means we
 *     do not know whether the admin asked for silence, and sending anyway is the
 *     unrecoverable direction.
 */

/**
 * Booking identity for a send. A discriminated union rather than an optional
 * `bookingId?: string`, so every call site — including every future one — has to
 * state which it is and cannot silently default to "not a booking email".
 */
export type EmailBookingContext = { bookingId: string } | "none";

/**
 * Pseudo template names for the two messages XERO sends on our behalf. They are
 * not registry templates (we never render or transmit them), but a withheld one
 * still needs a name so #2259's banner can say what was held back.
 */
export const XERO_BOOKING_INVOICE_EMAIL_TEMPLATE = "xero-booking-invoice-email";
export const XERO_GROUP_SETTLEMENT_INVOICE_EMAIL_TEMPLATE =
  "xero-group-settlement-invoice-email";

/**
 * Whether the "No emails" switch may withhold this template at all.
 *
 * Admin- and system-audience templates are exempt without exception (rule 2
 * above). An UNREGISTERED template name is treated as suppressible: reaching the
 * gate at all required the caller to hand us a real bookingId, so an ad-hoc
 * booking-scoped send should honour the switch rather than escape it.
 */
export function isBookingSuppressibleTemplate(templateName: string): boolean {
  const definition = getEmailTemplateDefinition(templateName);
  if (!definition) return true;
  return definition.audience === "member";
}

/**
 * Read the switch. THROWS on any database error — callers must fail closed
 * rather than treat an unreadable flag as "off".
 */
export async function readBookingNoEmails(bookingId: string): Promise<boolean> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { noEmails: true },
  });
  // A missing booking is not an error state for the mailer (the row may have
  // been hard-deleted between queueing and sending); nothing is suppressed.
  return booking?.noEmails === true;
}

export type BookingEmailGateDecision =
  // Nothing withholds this message.
  | { decision: "send" }
  // The switch is on: withhold and record it.
  | { decision: "withhold"; bookingId: string }
  // The switch could not be read: withhold anyway (fail closed) and record the
  // send as a transport failure so the retry cron re-evaluates it later.
  | { decision: "unknown"; bookingId: string };

/**
 * Resolve the gate for one send. Never throws.
 */
export async function resolveBookingEmailGate(
  bookingContext: EmailBookingContext,
  templateName: string,
): Promise<BookingEmailGateDecision> {
  if (bookingContext === "none") return { decision: "send" };
  if (!isBookingSuppressibleTemplate(templateName)) return { decision: "send" };

  const { bookingId } = bookingContext;
  try {
    const suppressed = await readBookingNoEmails(bookingId);
    return suppressed ? { decision: "withhold", bookingId } : { decision: "send" };
  } catch (err) {
    logger.error(
      { err, bookingId, templateName },
      'Failed to read the booking "No emails" switch; withholding the email (fail closed)',
    );
    return { decision: "unknown", bookingId };
  }
}

/**
 * Record that a message was deliberately withheld, without ever transmitting it.
 *
 * Most booking sends are un-awaited `.catch(log)` calls (waitlist.ts,
 * booking-create.ts, the crons), so the outcome cannot be returned to the caller
 * and be relied on — the MAILER records it. Used by `email/core.ts` for the
 * templates we render ourselves and directly by the two Xero paths, where the
 * provider (not this system) would have done the sending.
 *
 * The rendered body is deliberately NOT retained: nothing was sent, and the
 * retry cron only ever replays rows with a retained body.
 */
export async function recordWithheldBookingEmail(params: {
  bookingId: string;
  templateName: string;
  subject: string;
  to: string;
  detail?: string;
}): Promise<string | null> {
  try {
    const log = await prisma.emailLog.create({
      data: {
        to: params.to,
        subject: params.subject,
        templateName: params.templateName,
        htmlBody: null,
        status: EmailLogStatus.SKIPPED_NO_EMAILS,
        bookingId: params.bookingId,
        errorMessage:
          params.detail ??
          'Withheld: this booking has the "No emails" switch turned on',
        lastAttemptAt: new Date(),
      },
      select: { id: true },
    });
    return log.id;
  } catch (err) {
    logger.error(
      { err, bookingId: params.bookingId, templateName: params.templateName },
      "Failed to record a withheld booking email",
    );
    return null;
  }
}

export interface WithheldBookingEmail {
  id: string;
  templateName: string;
  subject: string;
  createdAt: Date;
}

/**
 * Everything withheld for a booking, newest first — the read behind #2259's
 * persistent "these messages were not sent" warning.
 */
export async function getWithheldBookingEmails(
  bookingId: string,
  options?: { limit?: number },
): Promise<WithheldBookingEmail[]> {
  return prisma.emailLog.findMany({
    where: { bookingId, status: EmailLogStatus.SKIPPED_NO_EMAILS },
    orderBy: { createdAt: "desc" },
    take: options?.limit ?? 100,
    select: { id: true, templateName: true, subject: true, createdAt: true },
  });
}
