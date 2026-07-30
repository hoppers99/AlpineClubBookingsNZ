import { describe, expect, it } from "vitest";

import {
  ADDITIONAL_OWED_BOOKING_STATUSES,
  ADDITIONAL_PAYMENT_CHASE_STARTS_AT,
  isAdditionalPaymentOwed,
  resolveAdditionalPaymentChase,
} from "@/lib/additional-payment-chase";
import { buildAdditionalOwedWhere } from "@/lib/unpaid-finished-stays";

/**
 * The shared brain of the additional-payment chase (#2350).
 *
 * Everything downstream — the admin queues, the bookings list chip, the booking
 * page panel, the finance figures, the reports summary, the reminder cron and
 * the manual re-send — asks this module the same two questions: is anything
 * owed, and is a reminder due. So the answers are pinned here, once.
 */

const PAYMENT = {
  additionalAmountCents: 21_000,
  additionalPaymentStatus: "PENDING" as string | null,
};

describe("isAdditionalPaymentOwed", () => {
  it("says yes for every uncollected state on a live booking", () => {
    for (const status of ["PENDING", "FAILED", null]) {
      expect(
        isAdditionalPaymentOwed({
          bookingStatus: "PAID",
          payment: { ...PAYMENT, additionalPaymentStatus: status },
        }),
      ).toBe(true);
    }
  });

  it("says no once the money has arrived, or when there is none to collect", () => {
    expect(
      isAdditionalPaymentOwed({
        bookingStatus: "PAID",
        payment: { ...PAYMENT, additionalPaymentStatus: "SUCCEEDED" },
      }),
    ).toBe(false);
    expect(
      isAdditionalPaymentOwed({
        bookingStatus: "PAID",
        payment: { ...PAYMENT, additionalAmountCents: 0 },
      }),
    ).toBe(false);
    expect(
      isAdditionalPaymentOwed({ bookingStatus: "PAID", payment: null }),
    ).toBe(false);
  });

  /*
    The finding this test exists for: cancelling a booking marks the additional
    intent FAILED (or leaves it PENDING where no intent was ever created) and
    NEVER zeroes additionalAmountCents. An amount-and-status-only test therefore
    reads every cancelled booking as still owing — and the chase would email its
    member a payment demand for money they do not owe.
  */
  it("says no on a booking whose lifecycle has ended the obligation", () => {
    for (const bookingStatus of [
      "CANCELLED",
      "BUMPED",
      "DRAFT",
      "PENDING",
      "PAYMENT_PENDING",
      "WAITLISTED",
      "AWAITING_REVIEW",
      null,
      undefined,
    ]) {
      expect(
        isAdditionalPaymentOwed({
          bookingStatus,
          payment: { ...PAYMENT, additionalPaymentStatus: "FAILED" },
        }),
      ).toBe(false);
    }
  });

  it("agrees with the SQL predicate it claims to be the twin of", () => {
    const where = buildAdditionalOwedWhere();

    // One status list, not two that have to be kept in step by hand.
    expect(where.status).toEqual({ in: [...ADDITIONAL_OWED_BOOKING_STATUSES] });
    for (const status of ADDITIONAL_OWED_BOOKING_STATUSES) {
      expect(
        isAdditionalPaymentOwed({ bookingStatus: status, payment: PAYMENT }),
      ).toBe(true);
    }
  });
});

describe("resolveAdditionalPaymentChase", () => {
  const AFTER_CUTOFF = new Date(
    ADDITIONAL_PAYMENT_CHASE_STARTS_AT.getTime() + 86_400_000,
  );

  function chase(overrides: Record<string, unknown> = {}) {
    return resolveAdditionalPaymentChase({
      now: new Date(AFTER_CUTOFF.getTime() + 5 * 86_400_000),
      today: new Date(AFTER_CUTOFF.getTime() + 5 * 86_400_000),
      checkIn: new Date(AFTER_CUTOFF.getTime() + 30 * 86_400_000),
      checkOut: new Date(AFTER_CUTOFF.getTime() + 32 * 86_400_000),
      episodeStartedAt: AFTER_CUTOFF,
      reminderSentAt: null,
      finalReminderSentAt: null,
      ...overrides,
    });
  }

  it("sends the day-three nudge once the extra has been owing long enough", () => {
    expect(chase()).toBe("initial");
    expect(
      chase({ now: new Date(AFTER_CUTOFF.getTime() + 86_400_000) }),
    ).toBeNull();
  });

  it("prefers the last-chance nudge inside the pre-arrival window", () => {
    const today = new Date(AFTER_CUTOFF.getTime() + 29 * 86_400_000);
    expect(chase({ now: today, today })).toBe("final");
  });

  /*
    The first-deploy guard. On the day this shipped, every already-outstanding
    delta was long past the day-3 threshold, so without this the first cron pass
    would have emailed the club's whole backlog at once — quoting, for legacy
    rows with no ADDITIONAL transaction, a "requested on" date it had to invent
    from the payment row's creation.
  */
  it("never chases an obligation raised before the chase existed", () => {
    const before = new Date(
      ADDITIONAL_PAYMENT_CHASE_STARTS_AT.getTime() - 86_400_000,
    );
    expect(chase({ episodeStartedAt: before })).toBeNull();
    // Including the last-chance one, which is checked first.
    const today = new Date(AFTER_CUTOFF.getTime() + 29 * 86_400_000);
    expect(chase({ episodeStartedAt: before, now: today, today })).toBeNull();
    // And the guard is a floor, not a window: at the instant itself, it chases.
    expect(
      chase({ episodeStartedAt: ADDITIONAL_PAYMENT_CHASE_STARTS_AT }),
    ).toBe("initial");
  });
});
