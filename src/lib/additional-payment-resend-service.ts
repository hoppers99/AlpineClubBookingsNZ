import {
  ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES,
  additionalPaymentEpisodeStartedAt,
  isAdditionalPaymentOwed,
  isWithinAdditionalPaymentResendCooldown,
} from "@/lib/additional-payment-chase";
import { createAuditLog } from "@/lib/audit";
import { readBookingNoEmails } from "@/lib/booking-email-suppression";
import { sendAdditionalPaymentReminderEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Admin re-send of the "you still owe this" email (#2350).
 *
 * The automatic chase (src/lib/cron-additional-payment-reminders.ts) covers the
 * ordinary case; this is the officer on the phone who needs the member to have
 * the message in front of them now. It sends the SAME email the cron sends, so
 * an admin override of the wording applies to both.
 *
 * Three properties make it safe to give an admin a button that emails a member:
 *
 *  1. **It cannot fan out.** The stamp that suppresses the automatic reminder is
 *     also the cooldown record, and it is written by a guarded `updateMany`
 *     BEFORE the send. Two clicks in the same second leave one winner; the loser
 *     is told the message just went out.
 *  2. **Auto and manual share one clock.** Because both write the same stamp, a
 *     cron reminder sent minutes ago blocks a re-send exactly as another
 *     re-send would, and a re-send suppresses the day-N nudge that was coming.
 *  3. **Silence is honoured up front.** A booking with the "No emails" switch on
 *     is refused with an explanation rather than being handed to the mailer to
 *     withhold — the admin is standing right there, and a silent withhold looks
 *     identical to a successful send.
 */

export type ResendAdditionalPaymentEmailResult =
  | {
      ok: true;
      sentAt: Date;
      additionalAmountCents: number;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export async function resendAdditionalPaymentEmail(params: {
  bookingId: string;
  actorMemberId: string;
  auditRequest?: {
    id?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
  now?: Date;
}): Promise<ResendAdditionalPaymentEmailResult> {
  const now = params.now ?? new Date();

  const booking = await prisma.booking.findUnique({
    where: { id: params.bookingId },
    select: {
      id: true,
      memberId: true,
      status: true,
      checkIn: true,
      checkOut: true,
      deletedAt: true,
      lodgeId: true,
      member: { select: { email: true, firstName: true } },
      payment: {
        select: {
          id: true,
          additionalAmountCents: true,
          additionalPaymentStatus: true,
          additionalReminderSentAt: true,
          additionalFinalReminderSentAt: true,
          createdAt: true,
          transactions: {
            where: { kind: "ADDITIONAL" },
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  if (!booking) {
    return { ok: false, status: 404, error: "Booking not found" };
  }
  if (booking.deletedAt) {
    return {
      ok: false,
      status: 409,
      error: "This booking has been deleted, so no payment request can be sent.",
    };
  }
  const payment = booking.payment;
  if (!isAdditionalPaymentOwed(payment) || !payment) {
    return {
      ok: false,
      status: 409,
      error: "This booking has no outstanding additional payment.",
    };
  }

  let silenced: boolean;
  try {
    silenced = await readBookingNoEmails(booking.id);
  } catch (err) {
    // Fail closed: an unreadable switch is not permission to email.
    logger.error(
      { err, bookingId: booking.id },
      'Could not read the booking "No emails" switch before an additional-payment re-send',
    );
    return {
      ok: false,
      status: 503,
      error:
        "We could not check this booking's email settings, so nothing was sent. Please try again.",
    };
  }
  if (silenced) {
    return {
      ok: false,
      status: 409,
      error:
        'This booking has the "No emails" switch turned on, so nothing was sent. Turn it off first if the member should hear from us.',
    };
  }

  if (
    isWithinAdditionalPaymentResendCooldown({
      now,
      reminderSentAt: payment.additionalReminderSentAt,
      finalReminderSentAt: payment.additionalFinalReminderSentAt,
    })
  ) {
    return {
      ok: false,
      status: 429,
      error: `A payment request was already emailed to this member in the last ${ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES} minutes. Please wait before sending another.`,
    };
  }

  // The read above is advisory; this claim is the one that decides. Re-stating
  // the cooldown and the owed test in the WHERE means two concurrent clicks (or
  // a cron pass landing in between) cannot both send.
  const cooldownCutoff = new Date(
    now.getTime() - ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES * 60_000,
  );
  const claimed = await prisma.payment.updateMany({
    where: {
      id: payment.id,
      additionalAmountCents: { gt: 0 },
      AND: [
        {
          OR: [
            { additionalPaymentStatus: null },
            { additionalPaymentStatus: { not: "SUCCEEDED" } },
          ],
        },
        {
          OR: [
            { additionalReminderSentAt: null },
            { additionalReminderSentAt: { lte: cooldownCutoff } },
          ],
        },
        {
          OR: [
            { additionalFinalReminderSentAt: null },
            { additionalFinalReminderSentAt: { lte: cooldownCutoff } },
          ],
        },
      ],
    },
    data: { additionalReminderSentAt: now },
  });
  if (claimed.count === 0) {
    return {
      ok: false,
      status: 429,
      error: `A payment request was already emailed to this member in the last ${ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES} minutes. Please wait before sending another.`,
    };
  }

  const episodeStartedAt = additionalPaymentEpisodeStartedAt({
    paymentCreatedAt: payment.createdAt,
    latestAdditionalTransactionCreatedAt:
      payment.transactions[0]?.createdAt ?? null,
  });

  try {
    await sendAdditionalPaymentReminderEmail({
      bookingId: booking.id,
      email: booking.member.email,
      firstName: booking.member.firstName,
      additionalAmountCents: payment.additionalAmountCents,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      requestedOn: episodeStartedAt,
      lodgeId: booking.lodgeId,
    });
  } catch (err) {
    // Give the stamp back so the automatic chase is not silently disarmed by a
    // send that never happened. Guarded on the value we wrote, so a reminder
    // that landed in between is not clobbered.
    await prisma.payment
      .updateMany({
        where: { id: payment.id, additionalReminderSentAt: now },
        data: { additionalReminderSentAt: payment.additionalReminderSentAt },
      })
      .catch((restoreErr) =>
        logger.error(
          { err: restoreErr, bookingId: booking.id },
          "Failed to restore the additional-payment reminder stamp after a failed re-send",
        ),
      );
    logger.error(
      { err, bookingId: booking.id },
      "Failed to re-send the additional-payment request email",
    );
    return {
      ok: false,
      status: 502,
      error: "We could not send the payment request email. Please try again.",
    };
  }

  await createAuditLog({
    action: "booking.additionalPayment.reminderResent",
    memberId: params.actorMemberId,
    actorMemberId: params.actorMemberId,
    subjectMemberId: booking.memberId,
    targetId: booking.id,
    entityType: "Booking",
    entityId: booking.id,
    category: "payment",
    severity: "info",
    outcome: "success",
    summary: "Additional payment request re-sent to the member",
    details:
      "Admin re-sent the email asking the member to pay the extra amount a booking change added. Nothing about the booking or the amount owed was changed.",
    metadata: {
      additionalAmountCents: payment.additionalAmountCents,
      additionalPaymentStatus: payment.additionalPaymentStatus,
      requestedOn: episodeStartedAt.toISOString(),
      previousReminderSentAt:
        payment.additionalReminderSentAt?.toISOString() ?? null,
    },
    requestId: params.auditRequest?.id,
    ipAddress: params.auditRequest?.ipAddress,
    userAgent: params.auditRequest?.userAgent,
  });

  return {
    ok: true,
    sentAt: now,
    additionalAmountCents: payment.additionalAmountCents,
  };
}
