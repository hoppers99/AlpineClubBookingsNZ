/**
 * Chasing an OUTSTANDING additional payment (#2350).
 *
 * When a booking is modified upwards after it was already paid — an admin adds
 * a non-member guest to a PAID booking, say — the extra owed is recorded on the
 * booking's `Payment` row as `additionalAmountCents` with an
 * `additionalPaymentStatus` of PENDING (awaiting the member's card) or FAILED
 * (the charge was attempted and did not go through). Until #2350 nothing ever
 * chased the member for it and no admin surface showed it.
 *
 * This module is the shared, side-effect-free brain for that chase: what counts
 * as owed, when the current obligation began, and which reminder (if any) is due
 * right now. It deliberately imports nothing from Prisma or the server runtime so
 * the admin bookings list, the booking page panel, the reminder cron, and the
 * manual re-send route can all agree by construction.
 *
 * The owed test itself lives in `buildAdditionalOwedWhere`
 * (src/lib/unpaid-finished-stays.ts) for the database side; the predicate here is
 * its in-memory twin and the two must always say the same thing.
 */

/** Days after the extra was raised before the first reminder goes out. */
export const ADDITIONAL_PAYMENT_REMINDER_DAYS = 3;

/**
 * Days before check-in for the last-chance reminder. Deliberately inside the
 * pre-arrival reminder's own 3-day window so the two land close together and a
 * member who is about to travel is told once, clearly, that money is still owing.
 */
export const ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN = 2;

/**
 * How long an admin must wait before re-sending the payment request by hand.
 * Shared by the auto reminders, so an automatic nudge and a manual one can never
 * reach the member inside the same hour.
 */
export const ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES = 60;

const MS_PER_DAY = 86_400_000;

/** The `Payment` columns every surface here reads. */
export interface AdditionalPaymentChasePayment {
  additionalAmountCents: number;
  additionalPaymentStatus: string | null;
  additionalReminderSentAt: Date | null;
  additionalFinalReminderSentAt: Date | null;
  createdAt: Date;
}

/**
 * Is an upward modification delta still uncollected?
 *
 * PENDING, FAILED and a null status on a legacy row are all treated as owed —
 * only SUCCEEDED means the money arrived. Same rule as
 * `buildAdditionalOwedWhere`, the member dashboard, and the booking detail page.
 */
export function isAdditionalPaymentOwed(
  payment: Pick<
    AdditionalPaymentChasePayment,
    "additionalAmountCents" | "additionalPaymentStatus"
  > | null
    | undefined,
): boolean {
  if (!payment) return false;
  return (
    payment.additionalAmountCents > 0 &&
    payment.additionalPaymentStatus !== "SUCCEEDED"
  );
}

/**
 * When the CURRENT additional-payment obligation began.
 *
 * The `Payment` summary columns only ever describe the LATEST additional
 * transaction (see syncPaymentAdditionalSummary in payment-transactions.ts), so
 * that transaction's `createdAt` is the start of the episode the member is being
 * chased about. Legacy rows written before per-transaction records existed have
 * no such row; they fall back to the payment's own creation, which is stable and
 * always earlier than any stamp we could have written, so a stamp is never
 * wrongly discarded.
 */
export function additionalPaymentEpisodeStartedAt(params: {
  paymentCreatedAt: Date;
  latestAdditionalTransactionCreatedAt?: Date | null;
}): Date {
  return params.latestAdditionalTransactionCreatedAt ?? params.paymentCreatedAt;
}

/**
 * Does this stamp belong to the CURRENT episode?
 *
 * Reading the stamps relative to the episode is what lets a later modification
 * raise a fresh delta and be chased from scratch without any writer having to
 * reset the columns: a stamp from the previous, already-settled episode is older
 * than the new episode's start and simply stops counting.
 */
export function isCurrentEpisodeStamp(
  stamp: Date | null | undefined,
  episodeStartedAt: Date,
): boolean {
  return stamp != null && stamp.getTime() >= episodeStartedAt.getTime();
}

export type AdditionalPaymentReminderKind = "initial" | "final";

export interface AdditionalPaymentChaseInput {
  /** Wall-clock now. */
  now: Date;
  /** NZ date-only today, as the rest of the booking domain means it. */
  today: Date;
  /** Booking check-in, date-only. */
  checkIn: Date;
  /** Booking check-out, date-only. */
  checkOut: Date;
  episodeStartedAt: Date;
  reminderSentAt: Date | null;
  finalReminderSentAt: Date | null;
}

/**
 * Which reminder is due for this booking right now, or `null` for none.
 *
 * The chase stops the moment the stay is over (`checkOut <= today`): a finished
 * stay with money still owing is the admin dashboard's unpaid-finished-stay queue
 * (#1723 path 2), which is a follow-up conversation rather than an automated
 * nudge. There is deliberately no auto-cancel and no expiry — nothing here ever
 * changes the booking.
 *
 * When both reminders are due at once the FINAL one wins and the caller stamps
 * both: inside the pre-arrival window the gentler "a few days ago you were asked"
 * nudge has nothing left to add, and sending two emails in one cron pass would be
 * exactly the noise the stamps exist to prevent.
 */
export function resolveAdditionalPaymentChase(
  input: AdditionalPaymentChaseInput,
): AdditionalPaymentReminderKind | null {
  if (input.checkOut.getTime() <= input.today.getTime()) return null;

  const finalWindowStart =
    input.checkIn.getTime() -
    ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN * MS_PER_DAY;
  if (
    input.today.getTime() >= finalWindowStart &&
    !isCurrentEpisodeStamp(input.finalReminderSentAt, input.episodeStartedAt)
  ) {
    return "final";
  }

  const initialDueAt =
    input.episodeStartedAt.getTime() +
    ADDITIONAL_PAYMENT_REMINDER_DAYS * MS_PER_DAY;
  if (
    input.now.getTime() >= initialDueAt &&
    !isCurrentEpisodeStamp(input.reminderSentAt, input.episodeStartedAt)
  ) {
    return "initial";
  }

  return null;
}

/**
 * Has the member been emailed about this delta within the manual re-send
 * cooldown? Checks BOTH stamps, so an automatic reminder that has just gone out
 * blocks an admin's re-send just as another re-send would.
 */
export function isWithinAdditionalPaymentResendCooldown(params: {
  now: Date;
  reminderSentAt: Date | null;
  finalReminderSentAt: Date | null;
}): boolean {
  const cutoff =
    params.now.getTime() - ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES * 60_000;
  return [params.reminderSentAt, params.finalReminderSentAt].some(
    (stamp) => stamp != null && stamp.getTime() > cutoff,
  );
}

/** Whole days between the delta being raised and now, floored at 0. */
export function additionalPaymentAgeDays(params: {
  now: Date;
  episodeStartedAt: Date;
}): number {
  return Math.max(
    0,
    Math.floor(
      (params.now.getTime() - params.episodeStartedAt.getTime()) / MS_PER_DAY,
    ),
  );
}
