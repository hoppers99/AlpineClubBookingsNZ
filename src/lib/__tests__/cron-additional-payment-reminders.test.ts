import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chasing an uncollected additional payment (#2350).
 *
 * The whole point of this cron is that it is SAFE to run every three hours: it
 * must send at most two emails per outstanding amount, never touch a booking,
 * never chase a stay that is over, and never speak to a member whose booking has
 * been silenced. These tests are the due/not-due matrix that pins each of those.
 */

const {
  mockPrisma,
  mockSendAdditionalPaymentReminderEmail,
  mockReadBookingNoEmails,
  mockLogger,
} = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findMany: vi.fn() },
    payment: { updateMany: vi.fn() },
  },
  mockSendAdditionalPaymentReminderEmail: vi.fn(),
  mockReadBookingNoEmails: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/email", () => ({
  sendAdditionalPaymentReminderEmail: mockSendAdditionalPaymentReminderEmail,
}));
vi.mock("@/lib/booking-email-suppression", () => ({
  readBookingNoEmails: mockReadBookingNoEmails,
}));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import { sendAdditionalPaymentReminders } from "@/lib/cron-additional-payment-reminders";

// NZ today for the frozen clock below is 2026-06-11 (NZST is UTC+12).
const NOW = new Date("2026-06-10T22:00:00.000Z");
const TODAY = new Date("2026-06-11T00:00:00.000Z");

/** An owing booking whose extra was raised well over the reminder threshold. */
function booking(overrides: Record<string, unknown> = {}) {
  const payment = {
    id: "payment-1",
    additionalAmountCents: 21_000,
    additionalPaymentStatus: "PENDING",
    additionalReminderSentAt: null,
    additionalFinalReminderSentAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    // Raised 10 days ago, so the day-3 nudge is overdue.
    transactions: [{ createdAt: new Date("2026-06-01T00:00:00.000Z") }],
    ...((overrides.payment as Record<string, unknown>) ?? {}),
  };
  return {
    id: "booking-1",
    lodgeId: "lodge-1",
    // Well outside the pre-check-in window, so only the day-3 nudge applies.
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    member: { email: "member@example.org", firstName: "Alice" },
    ...overrides,
    payment,
  };
}

const EPISODE_STARTED_AT = new Date("2026-06-01T00:00:00.000Z");

describe("sendAdditionalPaymentReminders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    mockReadBookingNoEmails.mockResolvedValue(false);
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("only considers owing bookings whose stay has not finished", async () => {
    await sendAdditionalPaymentReminders();

    const args = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      deletedAt: null,
      checkOut: { gt: TODAY },
      status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
      payment: {
        is: {
          additionalAmountCents: { gt: 0 },
          OR: [
            { additionalPaymentStatus: null },
            { additionalPaymentStatus: { not: "SUCCEEDED" } },
          ],
        },
      },
    });
  });

  it("sends the day-three nudge once the extra has been owing long enough", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).toHaveBeenCalledWith({
      bookingId: "booking-1",
      email: "member@example.org",
      firstName: "Alice",
      additionalAmountCents: 21_000,
      checkIn: new Date("2026-07-01T00:00:00.000Z"),
      checkOut: new Date("2026-07-03T00:00:00.000Z"),
      requestedOn: EPISODE_STARTED_AT,
      lodgeId: "lodge-1",
    });
    expect(result.initialSentBookingIds).toEqual(["booking-1"]);
    expect(result.finalSentBookingIds).toEqual([]);
    // Only the day-three stamp is written; the pre-arrival one stays free.
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { additionalReminderSentAt: NOW } }),
    );
  });

  it("stays quiet while the extra is younger than the reminder threshold", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        payment: {
          transactions: [{ createdAt: new Date("2026-06-09T00:00:00.000Z") }],
        },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  it("sends the last-chance nudge close to check-in and closes both stamps", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        checkIn: new Date("2026-06-12T00:00:00.000Z"),
        checkOut: new Date("2026-06-14T00:00:00.000Z"),
        payment: {
          // Raised yesterday: the day-three nudge is NOT due, but check-in is.
          transactions: [{ createdAt: new Date("2026-06-10T00:00:00.000Z") }],
        },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(result.finalSentBookingIds).toEqual(["booking-1"]);
    expect(result.initialSentBookingIds).toEqual([]);
    // Both stamps close: inside the pre-arrival window the gentler nudge has
    // nothing left to add, and leaving it unset would send a second email.
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          additionalFinalReminderSentAt: NOW,
          additionalReminderSentAt: NOW,
        },
      }),
    );
  });

  it("never chases a stay that has already ended", async () => {
    // The database filter excludes these, but the decision is also made in
    // memory so a widened query can never start emailing about finished stays.
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        checkIn: new Date("2026-06-05T00:00:00.000Z"),
        checkOut: new Date("2026-06-07T00:00:00.000Z"),
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  it("chases a FAILED charge exactly as it chases a pending one", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({ payment: { additionalPaymentStatus: "FAILED" } }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(result.initialSentBookingIds).toEqual(["booking-1"]);
  });

  it("does not re-send once this obligation has been stamped", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        payment: {
          additionalReminderSentAt: new Date("2026-06-05T00:00:00.000Z"),
        },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  /*
    The stamps are read RELATIVE to the current obligation, which is what lets a
    later modification raise a fresh delta and be chased from scratch without any
    writer having to reset the columns.
  */
  it("chases a NEW obligation even though the previous one was stamped", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        payment: {
          additionalReminderSentAt: new Date("2026-05-20T00:00:00.000Z"),
          additionalFinalReminderSentAt: new Date("2026-05-20T00:00:00.000Z"),
          // Raised AFTER those stamps, so they belong to a settled episode.
          transactions: [{ createdAt: new Date("2026-06-01T00:00:00.000Z") }],
        },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(result.initialSentBookingIds).toEqual(["booking-1"]);
  });

  it("says nothing about a booking whose emails are switched off", async () => {
    mockReadBookingNoEmails.mockResolvedValue(true);
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    // No stamp is burned, so the reminder is still due once the switch is off.
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.suppressedBookingIds).toEqual(["booking-1"]);
  });

  it("fails closed when the no-emails switch cannot be read", async () => {
    mockReadBookingNoEmails.mockRejectedValue(new Error("database unavailable"));
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.suppressedBookingIds).toEqual(["booking-1"]);
  });

  it("sends nothing when another runner claimed the reminder first", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  it("re-states the owed test in the claim so a settled extra cannot be chased", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);

    await sendAdditionalPaymentReminders();

    const where = mockPrisma.payment.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe("payment-1");
    expect(where.additionalAmountCents).toEqual({ gt: 0 });
    expect(where.AND).toContainEqual({
      OR: [
        { additionalPaymentStatus: null },
        { additionalPaymentStatus: { not: "SUCCEEDED" } },
      ],
    });
    expect(where.AND).toContainEqual({
      OR: [
        { additionalReminderSentAt: null },
        { additionalReminderSentAt: { lt: EPISODE_STARTED_AT } },
      ],
    });
  });

  it("records a transport failure without pretending the email went out", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockSendAdditionalPaymentReminderEmail.mockRejectedValue(
      new Error("SES unavailable"),
    );

    const result = await sendAdditionalPaymentReminders();

    expect(result.failedBookingIds).toEqual(["booking-1"]);
    expect(result.initialSentBookingIds).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  /*
    The property the whole design exists for: running the job twice back to back
    must not email the member twice. The second pass sees the stamp the first
    wrote — modelled here by feeding it back in, which is what the real re-read
    would return.
  */
  it("sends nothing on an immediate rerun", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    await sendAdditionalPaymentReminders();
    expect(mockSendAdditionalPaymentReminderEmail).toHaveBeenCalledTimes(1);

    mockSendAdditionalPaymentReminderEmail.mockClear();
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({ payment: { additionalReminderSentAt: NOW } }),
    ]);

    const rerun = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(rerun.initialSentBookingIds).toEqual([]);
  });
});
