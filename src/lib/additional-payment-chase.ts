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
 * its in-memory twin and the two must always say the same thing. That claim is
 * only true because BOTH halves test the booking's lifecycle status against the
 * one list below: a cancelled booking carries its delta columns unchanged (the
 * cancel path marks the intent FAILED without zeroing the amount), so an
 * amount-and-status-only test would read a cancelled booking as still owing and
 * we would chase a member for money they do not owe.
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

/**
 * When the automatic chase started existing (#2350).
 *
 * On the very first deploy every delta that is already outstanding has been
 * outstanding for far longer than the day-3 threshold, so without this the first
 * cron pass would email the entire historical backlog at once — and for legacy
 * rows with no ADDITIONAL transaction to date the obligation from, the email's
 * "Requested on" line would show the payment row's creation date rather than the
 * day the price actually changed. Neither is a message the club would choose to
 * send.
 *
 * So the automatic chase covers obligations raised from here on: an episode that
 * began before this instant is never emailed about by the cron. Nothing is
 * hidden — the delta still shows on the booking page panel, the bookings list,
 * the dashboard card and the sidebar badge, and an admin can still re-send the
 * request by hand from the booking, which is a person choosing to make contact
 * rather than a robot doing it in bulk.
 *
 * Set to the date of the migration that added the chase stamps
 * (prisma/migrations/20260801120000_add_additional_payment_reminder_stamps).
 * If the deploy slips well past that date, raise this to the actual deploy day
 * before releasing; lowering it (or setting it to the epoch) deliberately opts
 * into chasing the backlog.
 */
export const ADDITIONAL_PAYMENT_CHASE_STARTS_AT = new Date(
  "2026-08-01T00:00:00.000Z",
);

/**
 * Booking lifecycle statuses whose upward-modification delta is still worth
 * collecting. A CANCELLED or BUMPED booking keeps its `additionalAmountCents`
 * and a PENDING/FAILED `additionalPaymentStatus` after cancellation — nothing
 * zeroes them — so the status is part of the owed test, not context around it.
 *
 * Single source of truth: `buildAdditionalOwedWhere`
 * (src/lib/unpaid-finished-stays.ts) builds its SQL `status: { in: ... }` from
 * this same list.
 */
export const ADDITIONAL_OWED_BOOKING_STATUSES = [
  "CONFIRMED",
  "PAID",
  "COMPLETED",
] as const;

export type AdditionalOwedBookingStatus =
  (typeof ADDITIONAL_OWED_BOOKING_STATUSES)[number];

/** Is this booking in a lifecycle state where an addition is still collectable? */
export function isAdditionalOwedBookingStatus(
  status: string | null | undefined,
): status is AdditionalOwedBookingStatus {
  return (
    status != null &&
    (ADDITIONAL_OWED_BOOKING_STATUSES as readonly string[]).includes(status)
  );
}

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
 * The booking-and-payment pair the owed test needs. Deliberately an OBJECT with
 * a required `bookingStatus` key rather than two positional arguments: a caller
 * that forgets the status does not compile, which is the only way to stop this
 * predicate drifting back apart from its SQL twin.
 */
export interface AdditionalPaymentOwedInput {
  /** The booking's lifecycle status (`Booking.status`). */
  bookingStatus: string | null | undefined;
  payment:
    | Pick<
        AdditionalPaymentChasePayment,
        "additionalAmountCents" | "additionalPaymentStatus"
      >
    | null
    | undefined;
}

/**
 * Is an upward modification delta still uncollected AND still worth collecting?
 *
 * Two halves, both required:
 *  - the booking is in a lifecycle state that can still owe money (see
 *    ADDITIONAL_OWED_BOOKING_STATUSES). Cancelling a booking leaves the delta
 *    columns exactly as they were, so without this a cancelled booking reads as
 *    "still owing" and every surface — the chase email most of all — would dun
 *    the member for money they do not owe;
 *  - the money has not arrived. PENDING, FAILED and a null status on a legacy
 *    row are all treated as owed; only SUCCEEDED means it was collected.
 *
 * Same rule as `buildAdditionalOwedWhere`, the admin queues, and the cron.
 */
export function isAdditionalPaymentOwed(
  input: AdditionalPaymentOwedInput,
): boolean {
  if (!input.payment) return false;
  if (!isAdditionalOwedBookingStatus(input.bookingStatus)) return false;
  return (
    input.payment.additionalAmountCents > 0 &&
    input.payment.additionalPaymentStatus !== "SUCCEEDED"
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
  /**
   * First-deploy guard; defaults to ADDITIONAL_PAYMENT_CHASE_STARTS_AT.
   * Injectable so the rule can be tested without depending on the calendar.
   */
  chaseStartsAt?: Date;
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
 *
 * Obligations raised before the chase existed are never emailed about — see
 * ADDITIONAL_PAYMENT_CHASE_STARTS_AT for why the first deploy would otherwise
 * mail the whole backlog at once.
 */
export function resolveAdditionalPaymentChase(
  input: AdditionalPaymentChaseInput,
): AdditionalPaymentReminderKind | null {
  if (input.checkOut.getTime() <= input.today.getTime()) return null;

  const chaseStartsAt = input.chaseStartsAt ?? ADDITIONAL_PAYMENT_CHASE_STARTS_AT;
  if (input.episodeStartedAt.getTime() < chaseStartsAt.getTime()) return null;

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
