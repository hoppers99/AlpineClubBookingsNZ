import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  sendMail: vi.fn(),
  resolveEmailDeliveryConfig: vi.fn(),
  sendEmail: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: {
      findMany: mocks.findMany,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
    member: {
      findMany: mocks.memberFindMany,
      findUnique: mocks.memberFindUnique,
    },
    // #2258: the retry cron re-reads the booking's "No emails" switch before
    // every replay.
    booking: {
      findUnique: mocks.bookingFindUnique,
    },
  },
}));

vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mocks.sendMail })),
  },
}));

vi.mock("@/lib/email-sender", () => ({
  EMAIL_FROM: "noreply@example.test",
  formatEmailFromAddress: (from: string) => from,
}));

vi.mock("@/lib/email-text", () => ({
  htmlToPlainText: (html: string) => html,
}));

vi.mock("@/lib/email-delivery", () => ({
  resolveEmailDeliveryConfig: mocks.resolveEmailDeliveryConfig,
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
}));

import { retryFailedEmails } from "@/lib/cron-email-retry";

function failedEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: "email_1",
    to: "member@example.test",
    subject: "Booking update",
    htmlBody: "<p>hello</p>",
    templateName: "booking-confirmed",
    // #2258: rows written since the migration carry their booking. The
    // NULL-bookingId cases (pre-migration rows) are exercised explicitly below.
    bookingId: "bk_1",
    bookingRecipientMemberId: "member_1",
    bookingBodyOverrideApplied: false,
    bookingDetailLinkIncluded: false,
    attempts: 0,
    ...overrides,
  };
}

describe("retryFailedEmails (issue #820)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: true,
      transportOptions: { host: "smtp.example.test" },
      issues: [],
    });
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.getActiveEmailSuppression.mockResolvedValue(null);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: { noEmails?: boolean } }) =>
        args.select?.noEmails
          ? { noEmails: false }
          : { memberId: "member_1", deletedAt: null, guests: [] },
    );
    mocks.memberFindUnique.mockResolvedValue({
      role: "USER",
      financeAccessLevel: "NONE",
      active: true,
      archivedAt: null,
      canLogin: true,
      accessRoles: [],
    });
  });

  it("only queries retryable failures: FAILED, under max attempts, with a retained HTML body", async () => {
    mocks.findMany.mockResolvedValue([]);

    await retryFailedEmails();

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "FAILED",
          attempts: { lt: 3 },
          htmlBody: { not: null },
        }),
      }),
    );
  });

  it("marks a successfully re-sent email as SENT and increments attempts", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 1 })]);
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    // The row is claimed atomically (FAILED -> QUEUED, attempts incremented)
    // before the send so a concurrent/interrupted run cannot double-send (F33).
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "email_1",
        status: "FAILED",
        attempts: 1,
        htmlBody: "<p>hello</p>",
      },
      data: expect.objectContaining({ status: "QUEUED", attempts: 2 }),
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "email_1" },
        data: expect.objectContaining({ status: "SENT", messageId: "msg_1" }),
      }),
    );
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("keeps a still-retryable email FAILED and does not alert admins yet", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 0 })]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 421"));

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 0, failed: 1 });
    // attempts incremented, status restored to FAILED for the next run
    // (the pre-send claim moved it to QUEUED).
    const updateArg = mocks.update.mock.calls[0][0];
    expect(updateArg.data.attempts).toBe(1);
    expect(updateArg.data.status).toBe("FAILED");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("re-checks suppression and marks the row BOUNCED without sending (F26, #1885)", async () => {
    // Race: the FAILED row was created before an SNS bounce/complaint
    // suppressed the recipient. The retry must re-check and never re-deliver.
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 1 })]);
    mocks.getActiveEmailSuppression.mockResolvedValue({
      id: "sup-1",
      reason: "BOUNCE",
    });

    const result = await retryFailedEmails();

    expect(mocks.getActiveEmailSuppression).toHaveBeenCalledWith(
      "member@example.test",
    );
    expect(mocks.sendMail).not.toHaveBeenCalled();
    // Never claimed — a suppressed skip is not a retry attempt.
    expect(mocks.updateMany).not.toHaveBeenCalled();
    // Mirrors core.ts's suppressed write: BOUNCED, body dropped, same reason string.
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "email_1" },
      data: {
        status: "BOUNCED",
        htmlBody: null,
        errorMessage: "Email suppressed after SES bounce feedback",
      },
    });
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });

  it("does not send when the pre-send claim is lost (row already claimed/sent) (F33, #1885)", async () => {
    mocks.findMany.mockResolvedValue([failedEmail()]);
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const result = await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });

  it("never restores FAILED when the post-send SENT write fails, so an interrupted retry cannot re-send (F33, #1885)", async () => {
    mocks.findMany.mockResolvedValue([failedEmail()]);
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });
    // SES accepted the message but the SENT write dies (crash-equivalent).
    mocks.update.mockRejectedValue(new Error("db connection lost"));

    const result = await retryFailedEmails();

    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    // The row must stay QUEUED (claimed) — writing FAILED back would re-send
    // an email SES already accepted on the next cron run.
    for (const call of mocks.update.mock.calls) {
      expect(call[0].data.status).not.toBe("FAILED");
    }
    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
  });

  it("alerts admins when an email exhausts its retries", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 2 })]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 550"));
    mocks.memberFindMany.mockResolvedValue([{ email: "admin@example.test" }]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 0, failed: 1 });
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.test",
        templateName: "admin-email-failure",
      }),
    );
  });

  it("does not re-alert when the failing email is itself the admin failure alert", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({ attempts: 2, templateName: "admin-email-failure" }),
    ]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 550"));

    await retryFailedEmails();

    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("throws when email delivery configuration is invalid", async () => {
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: false,
      transportOptions: null,
      issues: ["missing EMAIL_FROM"],
    });

    await expect(retryFailedEmails()).rejects.toThrow(/delivery config invalid/);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe('retryFailedEmails and the per-booking "No emails" switch (#2258)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: true,
      transportOptions: { host: "smtp.example.test" },
      issues: [],
    });
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.getActiveEmailSuppression.mockResolvedValue(null);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: { noEmails?: boolean } }) =>
        args.select?.noEmails
          ? { noEmails: false }
          : { memberId: "member_1", deletedAt: null, guests: [] },
    );
    mocks.memberFindUnique.mockResolvedValue({
      role: "USER",
      financeAccessLevel: "NONE",
      active: true,
      archivedAt: null,
      canLogin: true,
      accessRoles: [],
    });
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });
  });

  it("does NOT replay a FAILED email whose booking now has the switch on", async () => {
    // The exact hole the gate exists for: the row was queued and failed BEFORE
    // an admin turned the switch on, so the pre-send check in core.ts passed.
    mocks.findMany.mockResolvedValue([failedEmail({ bookingId: "bk_1" })]);
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const result = await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    // Not claimed, so it is not counted as a retry attempt.
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "email_1" },
      data: expect.objectContaining({
        status: "SKIPPED_NO_EMAILS",
        htmlBody: null,
      }),
    });
  });

  it("fails closed and leaves the row untouched when the switch cannot be read", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ bookingId: "bk_1" })]);
    mocks.bookingFindUnique.mockRejectedValue(new Error("connection reset"));

    const result = await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });

  it("replays normally when the booking's switch is off", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ bookingId: "bk_1" })]);

    const result = await retryFailedEmails();

    expect(mocks.bookingFindUnique).toHaveBeenCalledWith({
      where: { id: "bk_1" },
      select: { noEmails: true },
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(1);
  });

  it("removes a retained booking-detail CTA when the member's authority was revoked", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody:
          '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="http://localhost:3000/bookings/bk_1">View booking</a></td></tr></table><p>Operational update</p>',
        bookingDetailLinkIncluded: true,
      }),
    ]);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: { noEmails?: boolean } }) =>
        args.select?.noEmails
          ? { noEmails: false }
          : { memberId: "different_owner", deletedAt: null, guests: [] },
    );

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const retry = mocks.sendMail.mock.calls[0][0];
    expect(retry.html).toContain("Operational update");
    expect(retry.html).not.toContain("/bookings/bk_1");
    expect(retry.html).not.toContain("View booking");
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ htmlBody: retry.html }),
      }),
    );
  });

  it("retires a stored override rather than rewriting its link after authority is revoked", async () => {
    const storedOverride =
      '<p>Club-authored body</p><a href="http://localhost:3000/bookings/bk_1">Open booking</a>';
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody: storedOverride,
        bookingBodyOverrideApplied: true,
        bookingDetailLinkIncluded: true,
      }),
    ]);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: { noEmails?: boolean } }) =>
        args.select?.noEmails
          ? { noEmails: false }
          : { memberId: "different_owner", deletedAt: null, guests: [] },
    );

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "email_1", status: "FAILED" }),
      data: expect.objectContaining({
        attempts: 3,
        htmlBody: null,
        errorMessage: expect.stringContaining("stored body override"),
      }),
    });
  });

  it("retries an authorized stored override byte-for-byte", async () => {
    const storedOverride =
      '<p>Club-authored body</p><a href="http://localhost:3000/bookings/bk_1">Open booking</a>';
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody: storedOverride,
        bookingBodyOverrideApplied: true,
        bookingDetailLinkIncluded: true,
      }),
    ]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail.mock.calls[0][0].html).toBe(storedOverride);
    expect(mocks.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      "htmlBody",
    );
  });

  it("preserves a public recipient's bearer consent action during retry", async () => {
    const bearerHtml =
      '<p>Please answer</p><a href="http://localhost:3000/bookings/consent/guest_1">Answer for this member</a>';
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody: bearerHtml,
        bookingRecipientMemberId: null,
        bookingDetailLinkIncluded: false,
      }),
    ]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail.mock.calls[0][0].html).toBe(bearerHtml);
  });

  it("fails closed when a known retained detail link cannot be located after URL drift", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody:
          '<a href="https://old-bookings.example.nz/bookings/bk_1">Open booking</a>',
        bookingDetailLinkIncluded: true,
      }),
    ]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "email_1", status: "FAILED" }),
      data: expect.objectContaining({
        attempts: 3,
        htmlBody: null,
        errorMessage: expect.stringContaining("current application URL"),
      }),
    });
  });

  it("retires a legacy booking row whose recipient authority context is unknown", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({
        bookingRecipientMemberId: null,
        bookingBodyOverrideApplied: null,
        bookingDetailLinkIncluded: null,
      }),
    ]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "email_1", status: "FAILED" }),
      data: expect.objectContaining({
        attempts: 3,
        htmlBody: null,
        errorMessage: expect.stringContaining("recipient authorization context"),
      }),
    });
  });

  it("guards fail-closed retirement against a concurrent row claim", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({
        bookingBodyOverrideApplied: null,
        bookingDetailLinkIncluded: null,
      }),
    ]);
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "email_1",
        status: "FAILED",
        attempts: 0,
        htmlBody: "<p>hello</p>",
      },
      data: expect.objectContaining({ attempts: 3, htmlBody: null }),
    });
  });

  // #2258 review finding: EmailLog.bookingId did not exist before the migration,
  // so EVERY row queued by the previous release is NULL — including booking
  // ones. Replaying those blind in the post-deploy window would send a
  // confirmation for a booking that has since been silenced.
  it("refuses to replay a NULL-bookingId row whose template is always booking-scoped", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({ id: "email_1", bookingId: null, templateName: "booking-confirmed" }),
    ]);

    const result = await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    // Not claimed, so not counted as a retry attempt...
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    // ...but RETIRED, not left as found: attempts goes to the max so the row
    // leaves this cron's selection window and enters the >=3 operator review
    // queue, with an errorMessage saying what to do about it.
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "email_1" },
      data: expect.objectContaining({
        attempts: 3,
        errorMessage: expect.stringContaining("No emails"),
      }),
    });
  });

  // The reason retiring matters, not just tidiness: the query is
  // status=FAILED + attempts<3 + retained body, ordered oldest-first, take 50.
  // Rows left below the threshold stay selectable forever, so a backlog of them
  // refills the same batch every run and retry dies for everything newer.
  it("does not let refused rows starve the queue: they leave the selection window", async () => {
    const stuck = Array.from({ length: 50 }, (_, i) =>
      failedEmail({ id: `stuck_${i}`, bookingId: null, templateName: "booking-confirmed" }),
    );
    mocks.findMany.mockResolvedValue(stuck);

    await retryFailedEmails();

    // Every one of them is retired in this single run, so the next run's batch
    // is free for newer mail rather than re-selecting these.
    expect(mocks.update).toHaveBeenCalledTimes(50);
    for (const call of mocks.update.mock.calls) {
      expect(call[0].data.attempts).toBe(3);
    }
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("still replays NULL-bookingId account, membership and admin rows untouched", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({ id: "e1", bookingId: null, templateName: "password-reset" }),
      failedEmail({ id: "e2", bookingId: null, templateName: "membership-approved" }),
      failedEmail({ id: "e3", bookingId: null, templateName: "admin-new-booking" }),
      // Genuinely pre-booking: a public request has no booking to silence.
      failedEmail({ id: "e4", bookingId: null, templateName: "booking-request-verification" }),
    ]);

    const result = await retryFailedEmails();

    expect(mocks.sendMail).toHaveBeenCalledTimes(4);
    expect(result.succeeded).toBe(4);
  });

  it("never consults the switch for a row with no booking, and never for an admin-audience template", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({ id: "email_1", bookingId: null, templateName: "password-reset" }),
      failedEmail({
        id: "email_2",
        bookingId: "bk_1",
        templateName: "admin-new-booking",
      }),
    ]);
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const result = await retryFailedEmails();

    // Neither row reads the switch: the first has no bookingId, and the second
    // is short-circuited by its admin audience before the read. BOTH replay.
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toBe(2);
  });
});
