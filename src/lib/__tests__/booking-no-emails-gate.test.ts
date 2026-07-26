import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Per-booking "No emails" switch — the MAILER GATE (#2258, owner decision D10).
 *
 * These tests pin the three properties the mechanism exists for:
 *   1. flag on  -> nothing is transmitted, and the withhold is auditable
 *   2. flag off -> byte-for-byte unchanged behaviour
 *   3. the flag is read from the BOOKING, never from the recipient address, so
 *      account/security mail and admin alerts are untouched.
 */

const mocks = vi.hoisted(() => ({
  emailLogCreate: vi.fn(),
  emailLogUpdate: vi.fn(),
  bookingFindUnique: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
  sendMail: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: { create: mocks.emailLogCreate, update: mocks.emailLogUpdate },
    booking: { findUnique: mocks.bookingFindUnique },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/email-sender", () => ({ EMAIL_FROM: "club@club.test" }));
vi.mock("@/lib/email-message-settings", () => ({
  formatEmailFromAddressWithSettings: () => "Club <club@club.test>",
}));
vi.mock("@/lib/email-message-renderer", () => ({
  prepareEmailMessage: async ({
    subject,
    html,
  }: {
    subject: string;
    html: string;
  }) => ({ subject, html, settings: {} }),
}));
vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));
vi.mock("@/lib/email/internal", () => ({
  getEmailTransporter: () => ({ sendMail: mocks.sendMail }),
  shouldPersistEmailHtml: () => true,
}));

import { sendEmail } from "@/lib/email/core";

// Every member-facing message class the owner named in D10.
const MEMBER_TEMPLATES = [
  "booking-confirmed",
  "booking-modified",
  "booking-pending",
  "checkin-reminder",
  "pre-arrival-reminder",
  "booking-cancelled",
  "waitlist-offer",
  "chore-roster",
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.emailLogCreate.mockResolvedValue({ id: "log_1" });
  mocks.emailLogUpdate.mockResolvedValue({});
  mocks.getActiveEmailSuppression.mockResolvedValue(null);
  mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });
  mocks.bookingFindUnique.mockResolvedValue({ noEmails: false });
  vi.stubEnv("NODE_ENV", "production");
});

describe('sendEmail gate: booking "No emails" switch on', () => {
  it.each(MEMBER_TEMPLATES)(
    "withholds %s and records a SKIPPED_NO_EMAILS audit row instead of sending",
    async (templateName) => {
      mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

      const outcome = await sendEmail({
        to: "member@example.com",
        subject: "Something about your booking",
        html: "<p>body</p>",
        templateName,
        bookingContext: { bookingId: "bk_1" },
      });

      expect(outcome).toEqual({
        status: "withheld_for_booking",
        emailLogId: "log_1",
        bookingId: "bk_1",
        reason: "booking_no_emails",
      });
      // Nothing was transmitted, and the SES suppression lookup is never even
      // reached (the booking gate runs first).
      expect(mocks.sendMail).not.toHaveBeenCalled();
      expect(mocks.getActiveEmailSuppression).not.toHaveBeenCalled();
      // The withhold is auditable, attributed to the booking, and retains no
      // body (nothing was sent, and the retry cron only replays retained bodies).
      expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
        where: { id: "log_1" },
        data: expect.objectContaining({
          status: "SKIPPED_NO_EMAILS",
          htmlBody: null,
          errorMessage: expect.stringContaining("No emails"),
        }),
      });
      expect(mocks.emailLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ bookingId: "bk_1", templateName }),
      });
    },
  );

  it("keys the gate on the booking, never on the recipient address", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    // Same recipient as the withheld booking mail above, but this send carries
    // no booking — an address-keyed shortcut would lock the member out of their
    // own account here.
    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Your sign-in code",
      html: "<p>123456</p>",
      templateName: "two-factor-code",
      bookingContext: "none",
    });

    expect(outcome.status).toBe("sent");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    "two-factor-code",
    "password-reset",
    "magic-link-login",
    "email-change-notification",
  ])("never withholds the account/security template %s", async (templateName) => {
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Account",
      html: "<p>token</p>",
      templateName,
      bookingContext: "none",
    });

    expect(outcome.status).toBe("sent");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it.each(["admin-payment-failure", "admin-duplicate-capture-refund", "admin-new-booking"])(
    "never withholds the admin-audience template %s even when handed a suppressed booking",
    async (templateName) => {
      mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

      const outcome = await sendEmail({
        to: "admin@example.com",
        subject: "Admin alert",
        html: "<p>alert</p>",
        templateName,
        // Deliberately the strongest case: a real booking id AND the switch on.
        // The registry audience is the authority, so the alert still goes out.
        bookingContext: { bookingId: "bk_1" },
      });

      expect(outcome.status).toBe("sent");
      expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    },
  );

  it("never withholds the system-audience admin-email-failure template", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const outcome = await sendEmail({
      to: "admin@example.com",
      subject: "Email delivery permanently failed",
      html: "<p>alert</p>",
      templateName: "admin-email-failure",
      bookingContext: { bookingId: "bk_1" },
    });

    expect(outcome.status).toBe("sent");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('sendEmail gate: booking "No emails" switch off', () => {
  it.each(MEMBER_TEMPLATES)("sends %s exactly as before", async (templateName) => {
    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Something about your booking",
      html: "<p>body</p>",
      templateName,
      bookingContext: { bookingId: "bk_1" },
    });

    expect(outcome.status).toBe("sent");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.getActiveEmailSuppression).toHaveBeenCalledTimes(1);
  });

  it("stamps the bookingId on the log row of a normal booking send", async () => {
    await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_42" },
    });

    expect(mocks.emailLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ bookingId: "bk_42" }),
    });
  });

  it("stores a null bookingId for a send with no booking", async () => {
    await sendEmail({
      to: "member@example.com",
      subject: "Your sign-in code",
      html: "<p>123456</p>",
      templateName: "two-factor-code",
      bookingContext: "none",
    });

    expect(mocks.emailLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ bookingId: null }),
    });
  });
});

describe("sendEmail gate: fail closed", () => {
  it("does NOT send when the switch cannot be read, and records the row FAILED so the retry cron re-evaluates it", async () => {
    mocks.bookingFindUnique.mockRejectedValue(new Error("connection reset"));

    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_1" },
    });

    expect(outcome).toEqual({
      status: "withheld_for_booking",
      emailLogId: "log_1",
      bookingId: "bk_1",
      reason: "booking_flag_unreadable",
    });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "FAILED" }),
    });
    // Deliberately the OPPOSITE of the SES bounce check, which fails open.
    const failedUpdate = mocks.emailLogUpdate.mock.calls[0][0];
    expect(failedUpdate.data).not.toHaveProperty("htmlBody");
  });

  it("still refuses to send when the EmailLog row could not be created either", async () => {
    mocks.emailLogCreate.mockRejectedValue(new Error("db down"));
    mocks.bookingFindUnique.mockRejectedValue(new Error("db down"));

    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_1" },
    });

    expect(outcome.status).toBe("withheld_for_booking");
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("withholds in development mode too (the dev short-circuit is downstream of the gate)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_1" },
    });

    expect(outcome.status).toBe("withheld_for_booking");
    expect(mocks.emailLogUpdate).not.toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });
});
