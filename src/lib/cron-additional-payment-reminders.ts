import {
  ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN,
  ADDITIONAL_PAYMENT_REMINDER_DAYS,
  additionalPaymentEpisodeStartedAt,
  isAdditionalPaymentOwed,
  resolveAdditionalPaymentChase,
  type AdditionalPaymentReminderKind,
} from "@/lib/additional-payment-chase";
import { readBookingNoEmails } from "@/lib/booking-email-suppression";
import { getTodayDateOnly } from "@/lib/date-only";
import { sendAdditionalPaymentReminderEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  buildAdditionalOwedPaymentWhere,
  buildAdditionalOwedWhere,
} from "@/lib/unpaid-finished-stays";

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
 * The claim also pins the amount and the episode the read decided on, and a lost
 * claim is re-read rather than assumed to be someone else's win — otherwise a
 * modification landing in that window would be emailed at its old amount while
 * its new, larger delta was stamped as already chased.
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
    include: CHASE_BOOKING_INCLUDE,
    orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
  });

  for (const found of bookings) {
    // The owed predicate above already guarantees a payment row; the guard is
    // for the type, not for a case that can happen.
    if (!found.payment) continue;

    // Decided in memory as well as in SQL, so a widened query can never start
    // emailing about a cancelled booking or a settled extra.
    if (
      !isAdditionalPaymentOwed({
        bookingStatus: found.status,
        payment: found.payment,
      })
    ) {
      result.skippedBookingIds.push(found.id);
      continue;
    }

    const dueOnRead = resolveChaseFor({ booking: found, now, today });
    if (!dueOnRead) {
      result.skippedBookingIds.push(found.id);
      continue;
    }

    let silenced: boolean;
    try {
      silenced = await readBookingNoEmails(found.id);
    } catch (err) {
      // Fail closed, the same direction as the mailer gate: an unreadable
      // switch means we do not know whether silence was asked for.
      logger.error(
        { err, bookingId: found.id, job: "additionalPaymentReminders" },
        'Could not read the booking "No emails" switch; skipping the additional-payment reminder',
      );
      result.suppressedBookingIds.push(found.id);
      continue;
    }
    if (silenced) {
      result.suppressedBookingIds.push(found.id);
      continue;
    }

    /*
      Claim, and on failure re-read rather than assuming another runner won.
      The claim fences the EPISODE (no ADDITIONAL transaction newer than the one
      we read) as well as pinning the amount, so anything that starts a new
      obligation in the read→claim window fails it. The episode fence is the
      load-bearing half: a member retrying a failed charge mints a new Stripe
      intent and therefore a new ADDITIONAL transaction row carrying the SAME
      amount, which an amount-only pin would sail straight through — and
      carrying on would email the old obligation while stamping the new one as
      already chased, burning its first reminder for good. One re-read is
      enough: the decision is then made on the current truth, and a second
      collision in the same instant simply waits for the next pass.
    */
    let booking = found;
    let claim: ClaimedAdditionalPaymentReminder | null = null;

    for (let attempt = 0; attempt < 2 && !claim; attempt += 1) {
      if (attempt > 0) {
        const fresh = await reloadChaseBooking(found.id);
        if (!fresh?.payment) break;
        booking = fresh;
        if (
          !isAdditionalPaymentOwed({
            bookingStatus: booking.status,
            payment: booking.payment,
          })
        ) {
          break;
        }
      }

      const due = resolveChaseFor({ booking, now, today });
      if (!due) break;

      claim = await claimAdditionalPaymentReminder({ ...due, now });
    }

    if (!claim) {
      result.skippedBookingIds.push(found.id);
      continue;
    }

    const { kind, episodeStartedAt, additionalAmountCents } = claim;

    try {
      const outcome = await sendAdditionalPaymentReminderEmail({
        bookingId: booking.id,
        email: booking.member.email,
        firstName: booking.member.firstName,
        additionalAmountCents,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        requestedOn: episodeStartedAt,
        lodgeId: booking.lodgeId,
      });

      if (outcome.status !== "sent") {
        /*
          The mailer RETURNS rather than throws when nothing was transmitted —
          a suppressed (bounced/complained) address, a walk-in placeholder
          `.invalid` address, or the per-booking "No emails" switch flipping on
          between our own check above and the send. Treating that as a send
          would leave the stamp burned and this obligation never chased again,
          which is the opposite of what the stamp is for.

          The stamp is given back only when the withholding is expected to lift
          by itself: the switch being ON is a deliberate, reversible operator
          choice, so the reminder must still be due once it comes off. The
          others are kept, because re-attempting every three hours cannot help —
          a dead or placeholder address never accepts mail, and the
          unreadable-switch case leaves a FAILED EmailLog the retry cron
          replays, so restoring would risk a second copy. Either way the delta
          stays in the admin queues and the panel's re-send button.
        */
        const reversible =
          outcome.status === "withheld_for_booking" &&
          outcome.reason === "booking_no_emails";
        if (reversible) {
          await restoreAdditionalPaymentStamps({ claim, now });
        }
        logger.warn(
          {
            bookingId: booking.id,
            job: "additionalPaymentReminders",
            outcome: outcome.status,
            stampRestored: reversible,
          },
          "Additional-payment reminder was not transmitted",
        );
        result.suppressedBookingIds.push(booking.id);
        continue;
      }

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
 * Everything one pass needs about a booking, read the same way whether it came
 * from the sweep or from a re-read after a lost claim.
 */
const CHASE_BOOKING_INCLUDE = {
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
} as const;

type ChaseBooking = Awaited<ReturnType<typeof reloadChaseBooking>>;

function reloadChaseBooking(bookingId: string) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: CHASE_BOOKING_INCLUDE,
  });
}

interface DueAdditionalPaymentReminder {
  paymentId: string;
  kind: AdditionalPaymentReminderKind;
  episodeStartedAt: Date;
  /** The amount as read; the claim pins it so the email cannot quote a stale one. */
  additionalAmountCents: number;
  /** Stamp values before the claim, so a withheld send can hand them back. */
  previousReminderSentAt: Date | null;
  previousFinalReminderSentAt: Date | null;
}

type ClaimedAdditionalPaymentReminder = DueAdditionalPaymentReminder;

/** Which reminder (if any) this booking is due, as its current row reads. */
function resolveChaseFor(params: {
  booking: NonNullable<ChaseBooking>;
  now: Date;
  today: Date;
}): DueAdditionalPaymentReminder | null {
  const payment = params.booking.payment;
  if (!payment) return null;

  const episodeStartedAt = additionalPaymentEpisodeStartedAt({
    paymentCreatedAt: payment.createdAt,
    latestAdditionalTransactionCreatedAt:
      payment.transactions[0]?.createdAt ?? null,
  });

  const kind = resolveAdditionalPaymentChase({
    now: params.now,
    today: params.today,
    checkIn: params.booking.checkIn,
    checkOut: params.booking.checkOut,
    episodeStartedAt,
    reminderSentAt: payment.additionalReminderSentAt,
    finalReminderSentAt: payment.additionalFinalReminderSentAt,
  });
  if (!kind) return null;

  return {
    paymentId: payment.id,
    kind,
    episodeStartedAt,
    additionalAmountCents: payment.additionalAmountCents,
    previousReminderSentAt: payment.additionalReminderSentAt,
    previousFinalReminderSentAt: payment.additionalFinalReminderSentAt,
  };
}

/**
 * Hand the stamp(s) back after a send that never transmitted. Guarded on the
 * value this pass wrote, so a reminder that landed in between is not clobbered.
 */
async function restoreAdditionalPaymentStamps(params: {
  claim: ClaimedAdditionalPaymentReminder;
  now: Date;
}): Promise<void> {
  const { claim, now } = params;
  const isFinal = claim.kind === "final";

  await prisma.payment
    .updateMany({
      where: {
        id: claim.paymentId,
        additionalReminderSentAt: now,
        ...(isFinal ? { additionalFinalReminderSentAt: now } : {}),
      },
      data: {
        additionalReminderSentAt: claim.previousReminderSentAt,
        ...(isFinal
          ? { additionalFinalReminderSentAt: claim.previousFinalReminderSentAt }
          : {}),
      },
    })
    .catch((err) =>
      logger.error(
        { err, paymentId: claim.paymentId, job: "additionalPaymentReminders" },
        "Failed to restore the additional-payment reminder stamp after a withheld send",
      ),
    );
}

/**
 * Write the stamp(s) for one reminder, but only if the money is still owed, the
 * obligation is still the one we read, and nothing has already stamped it.
 * Returns null when another runner (or an admin's manual re-send) got there
 * first, or when the delta moved under us.
 *
 * The WHERE pins THREE things the read decided on, not just the stamp:
 *  - the owed test in full, booking lifecycle status included, so a
 *    cancellation landing in the window cannot be emailed about;
 *  - the exact `additionalAmountCents`, so an email can never quote an amount
 *    the member no longer owes;
 *  - that no ADDITIONAL transaction newer than this episode exists, so a second
 *    upward modification starts a fresh chase instead of inheriting a stamp
 *    that would suppress its first reminder for good.
 *
 * The final reminder stamps BOTH columns: once the member has been told inside
 * the pre-arrival window, the gentler day-N nudge has nothing left to say, and
 * leaving its stamp unset would let a later run send it as well.
 *
 * ACCEPTED RESIDUAL: claim-then-send means a crash (or a pod eviction) between
 * the stamp and the mailer loses that reminder permanently — no EmailLog row
 * exists yet, so the email retry cron has nothing to replay, and for the final
 * branch BOTH stamps are already spent. The alternative, send-then-stamp, trades
 * a lost reminder for a duplicate one on every retry, and this is a chase for
 * money the club already has a record of: the delta stays on the booking panel,
 * the bookings list, the dashboard card and the sidebar badge, and an admin can
 * re-send by hand. Same trade as the pre-arrival cron (#1651), deliberately.
 */
async function claimAdditionalPaymentReminder(
  params: DueAdditionalPaymentReminder & { now: Date },
): Promise<ClaimedAdditionalPaymentReminder | null> {
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
      AND: [
        buildAdditionalOwedPaymentWhere(),
        { additionalAmountCents: params.additionalAmountCents },
        {
          transactions: {
            none: {
              kind: "ADDITIONAL",
              createdAt: { gt: params.episodeStartedAt },
            },
          },
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

  return claimed.count > 0
    ? {
        paymentId: params.paymentId,
        kind: params.kind,
        episodeStartedAt: params.episodeStartedAt,
        additionalAmountCents: params.additionalAmountCents,
        previousReminderSentAt: params.previousReminderSentAt,
        previousFinalReminderSentAt: params.previousFinalReminderSentAt,
      }
    : null;
}
