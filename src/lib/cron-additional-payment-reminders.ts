import {
  ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN,
  ADDITIONAL_PAYMENT_REMINDER_DAYS,
  additionalPaymentEpisodeStartedAt,
  resolveAdditionalPaymentChase,
  type AdditionalPaymentReminderKind,
} from "@/lib/additional-payment-chase";
import { readBookingNoEmails } from "@/lib/booking-email-suppression";
import { getTodayDateOnly } from "@/lib/date-only";
import { sendAdditionalPaymentReminderEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { buildAdditionalOwedWhere } from "@/lib/unpaid-finished-stays";

/**
 * Chase an uncollected additional payment (#2350).
 *
 * A booking change that raises the price after the booking was already paid
 * records the extra on the `Payment` row and, until this job existed, waited
 * silently for the member to notice. This cron emails them twice at most: a few
 * days after the change, and once more shortly before check-in. It never
 * cancels, never expires anything, and stops entirely once the stay is over —
 * that phase belongs to the admin dashboard's unpaid-finished-stays queue.
 *
 * Idempotent by claim-then-send, the same shape as the pre-arrival cron: the
 * reminder stamp is written with a guarded `updateMany` whose WHERE still
 * requires the money to be owed and the stamp to be unset for THIS obligation,
 * so a rerun (or two runners racing) claims nothing and therefore sends nothing.
 *
 * Honours the per-booking "No emails" switch explicitly rather than letting the
 * mailer withhold the message: withholding would still burn the stamp, so a
 * booking that was silenced during the reminder window would never be chased
 * once the switch came off. Skipping leaves the stamp unset and the reminder due.
 */

export interface AdditionalPaymentReminderResult {
  reminderDays: number;
  finalReminderDaysBeforeCheckIn: number;
  /** Booking ids emailed, split by which reminder went out. */
  initialSentBookingIds: string[];
  finalSentBookingIds: string[];
  /** Owed bookings that were considered but were not due, or were silenced. */
  skippedBookingIds: string[];
  suppressedBookingIds: string[];
  failedBookingIds: string[];
}

export async function sendAdditionalPaymentReminders(): Promise<AdditionalPaymentReminderResult> {
  const now = new Date();
  const today = getTodayDateOnly();

  const result: AdditionalPaymentReminderResult = {
    reminderDays: ADDITIONAL_PAYMENT_REMINDER_DAYS,
    finalReminderDaysBeforeCheckIn:
      ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN,
    initialSentBookingIds: [],
    finalSentBookingIds: [],
    skippedBookingIds: [],
    suppressedBookingIds: [],
    failedBookingIds: [],
  };

  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      // The stay is still ahead of (or in) the current NZ day. A finished stay
      // is the dashboard queue's business, not this job's.
      checkOut: { gt: today },
      ...buildAdditionalOwedWhere(),
    },
    include: {
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
    orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
  });

  for (const booking of bookings) {
    const payment = booking.payment;
    // The owed predicate above already guarantees a payment row; the guard is
    // for the type, not for a case that can happen.
    if (!payment) continue;

    const episodeStartedAt = additionalPaymentEpisodeStartedAt({
      paymentCreatedAt: payment.createdAt,
      latestAdditionalTransactionCreatedAt:
        payment.transactions[0]?.createdAt ?? null,
    });

    const kind = resolveAdditionalPaymentChase({
      now,
      today,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      episodeStartedAt,
      reminderSentAt: payment.additionalReminderSentAt,
      finalReminderSentAt: payment.additionalFinalReminderSentAt,
    });

    if (!kind) {
      result.skippedBookingIds.push(booking.id);
      continue;
    }

    let silenced: boolean;
    try {
      silenced = await readBookingNoEmails(booking.id);
    } catch (err) {
      // Fail closed, the same direction as the mailer gate: an unreadable
      // switch means we do not know whether silence was asked for.
      logger.error(
        { err, bookingId: booking.id, job: "additionalPaymentReminders" },
        'Could not read the booking "No emails" switch; skipping the additional-payment reminder',
      );
      result.suppressedBookingIds.push(booking.id);
      continue;
    }
    if (silenced) {
      result.suppressedBookingIds.push(booking.id);
      continue;
    }

    const claimed = await claimAdditionalPaymentReminder({
      paymentId: payment.id,
      kind,
      episodeStartedAt,
      now,
    });
    if (!claimed) {
      result.skippedBookingIds.push(booking.id);
      continue;
    }

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
      if (kind === "final") {
        result.finalSentBookingIds.push(booking.id);
      } else {
        result.initialSentBookingIds.push(booking.id);
      }
    } catch (err) {
      // The stamp stays written, exactly as the pre-arrival cron leaves it: a
      // transport failure is replayed by the email retry cron from its FAILED
      // EmailLog row, and an admin can always re-send by hand from the booking.
      logger.error(
        { err, bookingId: booking.id, job: "additionalPaymentReminders" },
        "Failed to send an additional-payment reminder",
      );
      result.failedBookingIds.push(booking.id);
    }
  }

  return result;
}

/**
 * Write the stamp(s) for one reminder, but only if the money is still owed and
 * nothing has already stamped this obligation. Returns false when another runner
 * (or an admin's manual re-send) got there first.
 *
 * The final reminder stamps BOTH columns: once the member has been told inside
 * the pre-arrival window, the gentler day-N nudge has nothing left to say, and
 * leaving its stamp unset would let a later run send it as well.
 */
async function claimAdditionalPaymentReminder(params: {
  paymentId: string;
  kind: AdditionalPaymentReminderKind;
  episodeStartedAt: Date;
  now: Date;
}): Promise<boolean> {
  const unstampedForThisEpisode = (
    field: "additionalReminderSentAt" | "additionalFinalReminderSentAt",
  ) => ({
    OR: [
      { [field]: null },
      { [field]: { lt: params.episodeStartedAt } },
    ],
  });

  const claimed = await prisma.payment.updateMany({
    where: {
      id: params.paymentId,
      additionalAmountCents: { gt: 0 },
      AND: [
        {
          OR: [
            { additionalPaymentStatus: null },
            { additionalPaymentStatus: { not: "SUCCEEDED" } },
          ],
        },
        unstampedForThisEpisode(
          params.kind === "final"
            ? "additionalFinalReminderSentAt"
            : "additionalReminderSentAt",
        ),
      ],
    },
    data:
      params.kind === "final"
        ? {
            additionalFinalReminderSentAt: params.now,
            additionalReminderSentAt: params.now,
          }
        : { additionalReminderSentAt: params.now },
  });

  return claimed.count > 0;
}
