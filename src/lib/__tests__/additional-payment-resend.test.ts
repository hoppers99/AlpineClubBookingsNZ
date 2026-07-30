import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin "Resend payment request email" action (#2350).
 *
 * This is a button that emails a member, handed to every Booking Officer, so the
 * tests here are about what stops it being abused or misread: it cannot fan out,
 * it shares one cooldown clock with the automatic chase, it refuses on a silenced
 * booking instead of silently withholding, and it gives the stamp back if the
 * send never happened.
 */

const {
  mockPrisma,
  mockSendAdditionalPaymentReminderEmail,
  mockReadBookingNoEmails,
  mockCreateAuditLog,
  mockLogger,
} = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findUnique: vi.fn() },
    payment: { updateMany: vi.fn() },
  },
  mockSendAdditionalPaymentReminderEmail: vi.fn(),
  mockReadBookingNoEmails: vi.fn(),
  mockCreateAuditLog: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/email", () => ({
  sendAdditionalPaymentReminderEmail: mockSendAdditionalPaymentReminderEmail,
}));
vi.mock("@/lib/booking-email-suppression", () => ({
  readBookingNoEmails: mockReadBookingNoEmails,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mockCreateAuditLog }));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import { resendAdditionalPaymentEmail } from "@/lib/additional-payment-resend-service";

const NOW = new Date("2026-06-10T22:00:00.000Z");
const RAISED_AT = new Date("2026-06-01T00:00:00.000Z");

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "PAID",
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    deletedAt: null,
    lodgeId: "lodge-1",
    member: { email: "member@example.org", firstName: "Alice" },
    ...overrides,
    payment:
      overrides.payment === null
        ? null
        : {
            id: "payment-1",
            additionalAmountCents: 21_000,
            additionalPaymentStatus: "PENDING",
            additionalReminderSentAt: null,
            additionalFinalReminderSentAt: null,
            createdAt: new Date("2026-05-01T00:00:00.000Z"),
            transactions: [{ createdAt: RAISED_AT }],
            ...((overrides.payment as Record<string, unknown>) ?? {}),
          },
  };
}

async function resend() {
  return resendAdditionalPaymentEmail({
    bookingId: "booking-1",
    actorMemberId: "admin-1",
    now: NOW,
  });
}

describe("resendAdditionalPaymentEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.booking.findUnique.mockResolvedValue(booking());
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    mockReadBookingNoEmails.mockResolvedValue(false);
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue(undefined);
  });

  it("sends the same email the cron sends, stamps it, and audits the action", async () => {
    const result = await resend();

    expect(result).toMatchObject({ ok: true, additionalAmountCents: 21_000 });
    expect(mockSendAdditionalPaymentReminderEmail).toHaveBeenCalledWith({
      bookingId: "booking-1",
      email: "member@example.org",
      firstName: "Alice",
      additionalAmountCents: 21_000,
      checkIn: new Date("2026-07-01T00:00:00.000Z"),
      checkOut: new Date("2026-07-03T00:00:00.000Z"),
      requestedOn: RAISED_AT,
      lodgeId: "lodge-1",
    });
    // Writes the SAME stamp the automatic day-three nudge writes, which is what
    // stops the two arriving one after the other.
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { additionalReminderSentAt: NOW } }),
    );
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.additionalPayment.reminderResent",
        entityId: "booking-1",
        subjectMemberId: "member-1",
        outcome: "success",
      }),
    );
  });

  it("refuses when nothing is owed", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({ payment: { additionalPaymentStatus: "SUCCEEDED" } }),
    );

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
  });

  it("refuses on a booking with no payment row at all", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(booking({ payment: null }));

    expect(await resend()).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses on a deleted booking", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({ deletedAt: new Date("2026-06-02T00:00:00.000Z") }),
    );

    expect(await resend()).toMatchObject({ ok: false, status: 409 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
  });

  it("404s on an unknown booking", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(null);

    expect(await resend()).toMatchObject({ ok: false, status: 404 });
  });

  it("chases a FAILED charge just as it chases a pending one", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({ payment: { additionalPaymentStatus: "FAILED" } }),
    );

    expect(await resend()).toMatchObject({ ok: true });
  });

  it("refuses, rather than silently withholding, on a silenced booking", async () => {
    mockReadBookingNoEmails.mockResolvedValue(true);

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(
      result.ok === false ? result.error : "",
    ).toContain("No emails");
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when the no-emails switch cannot be read", async () => {
    mockReadBookingNoEmails.mockRejectedValue(new Error("database unavailable"));

    expect(await resend()).toMatchObject({ ok: false, status: 503 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
  });

  it("rate-limits a second send inside the cooldown", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          additionalReminderSentAt: new Date("2026-06-10T21:30:00.000Z"),
        },
      }),
    );

    expect(await resend()).toMatchObject({ ok: false, status: 429 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("counts an automatic pre-arrival reminder against the same cooldown", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          additionalFinalReminderSentAt: new Date("2026-06-10T21:30:00.000Z"),
        },
      }),
    );

    expect(await resend()).toMatchObject({ ok: false, status: 429 });
  });

  it("allows a re-send once the cooldown has passed", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          additionalReminderSentAt: new Date("2026-06-10T20:30:00.000Z"),
        },
      }),
    );

    expect(await resend()).toMatchObject({ ok: true });
  });

  it("lets only one of two simultaneous clicks through", async () => {
    // The read said nothing had been sent; the guarded write disagrees, which is
    // exactly the race the claim exists to lose safely.
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    expect(await resend()).toMatchObject({ ok: false, status: 429 });
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
  });

  it("gives the stamp back when the send fails, so the automatic chase survives", async () => {
    mockSendAdditionalPaymentReminderEmail.mockRejectedValue(
      new Error("SES unavailable"),
    );

    const result = await resend();

    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(mockPrisma.payment.updateMany).toHaveBeenLastCalledWith({
      where: { id: "payment-1", additionalReminderSentAt: NOW },
      data: { additionalReminderSentAt: null },
    });
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});
