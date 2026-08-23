import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mailer's environment-safety boundary (ENV-SAFETY 2, #3035; epic #2986;
 * INV-CONFIG-004).
 *
 * FOUR OUTCOMES THAT MUST STAY FOUR, which is the whole issue. A message can go
 * unsent because the club decided not to email this person, because this
 * installation is a copy, because nobody has said what this installation is, or
 * because the provider broke. They need four different remedies, so a test that
 * only proved "nothing was sent" would prove almost nothing.
 *
 * Every case below also asserts the provider was never REACHED, not merely that
 * no message arrived — on a copy holding the club's real member addresses,
 * "we called SES and it refused" and "we never called SES" are entirely different
 * facts.
 */

const mocks = vi.hoisted(() => ({
  emailLogCreate: vi.fn(),
  emailLogUpdate: vi.fn(),
  bookingFindUnique: vi.fn(),
  environmentSafetyFindUnique: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
  getAdminEmails: vi.fn(),
  sendMail: vi.fn(),
  getEmailTransporter: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: { create: mocks.emailLogCreate, update: mocks.emailLogUpdate },
    booking: { findUnique: mocks.bookingFindUnique },
    environmentSafetySettings: { findUnique: mocks.environmentSafetyFindUnique },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/email-sender", () => ({
  EMAIL_FROM: "club@club.test",
  SUPPORT_EMAIL: "support@club.test",
}));
vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_FROM_NAME: "Club Bookings",
  formatEmailFromAddressWithSettings: () => "Club <club@club.test>",
}));
vi.mock("@/lib/email-message-renderer", () => ({
  prepareEmailMessage: async ({
    subject,
    html,
  }: {
    subject: string;
    html: string;
  }) => ({ subject, html, settings: {}, bodyOverrideApplied: false }),
}));
vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));
vi.mock("@/lib/email/admin-alerts-shared", () => ({
  getAdminEmails: mocks.getAdminEmails,
}));
vi.mock("@/lib/email/internal", () => ({
  getEmailTransporter: mocks.getEmailTransporter,
  shouldPersistEmailHtml: () => true,
}));

import { sendEmail, __resetFailClosedAlertThrottle } from "@/lib/email/core";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";

const MESSAGE = {
  to: "member@example.com",
  subject: "Your booking",
  html: "<p>body</p>",
  templateName: "booking-modified",
  bookingContext: "none",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.emailLogCreate.mockResolvedValue({ id: "log_1" });
  mocks.emailLogUpdate.mockResolvedValue({});
  mocks.getActiveEmailSuppression.mockResolvedValue(null);
  mocks.environmentSafetyFindUnique.mockResolvedValue(null);
  mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });
  mocks.getEmailTransporter.mockResolvedValue({
    transporter: { sendMail: mocks.sendMail },
    modeLabel: "test",
  });
  mocks.getAdminEmails.mockResolvedValue([]);
  mocks.bookingFindUnique.mockResolvedValue({ noEmails: false });
  __resetFailClosedAlertThrottle();
  // Not a build-mode safety decision: the dev short-circuit is kept as a local
  // convenience, and these tests are about the boundary ABOVE it, so they run in
  // the mode a deployed container runs in.
  vi.stubEnv("NODE_ENV", "production");
});

describe("confirmed PRODUCTION", () => {
  beforeEach(() => {
    declareEnvironmentRole("production");
  });

  it("delivers exactly as before, through a clearance-gated transport", async () => {
    await expectEnvironmentRolePremise("PRODUCTION");

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome).toEqual({
      status: "sent",
      emailLogId: "log_1",
      messageId: "msg_1",
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    // The transport was obtained WITH a clearance, not with nothing: that
    // argument is what makes the boundary unbypassable at compile time.
    expect(mocks.getEmailTransporter).toHaveBeenCalledTimes(1);
    expect(mocks.getEmailTransporter.mock.calls[0]?.[0]).toBeTruthy();
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });

  it("still honours the booking's own No emails switch, which is a different rule", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const outcome = await sendEmail({
      ...MESSAGE,
      bookingContext: {
        bookingId: "bk_1",
        recipient: { kind: "non-login-public-contact" },
      },
    });

    expect(outcome).toEqual({
      status: "withheld_for_booking",
      emailLogId: "log_1",
      bookingId: "bk_1",
      reason: "booking_no_emails",
    });
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "SKIPPED_NO_EMAILS" }),
    });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("still records a bounced recipient as BOUNCED, not as an environment withhold", async () => {
    mocks.getActiveEmailSuppression.mockResolvedValue({
      id: "sup_1",
      reason: "BOUNCE",
    });

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome.status).toBe("suppressed");
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "BOUNCED" }),
    });
    expect(mocks.getEmailTransporter).not.toHaveBeenCalled();
  });

  it("records a real provider failure as FAILED with NO block reason", async () => {
    /*
      The distinguishability requirement, from the other side. A transport failure
      and an unconfirmed environment both land on FAILED — they have to, because
      both are retryable — so the only thing separating them is the
      `deliveryBlockReason` column. A transport failure must leave it unset.
    */
    mocks.sendMail.mockRejectedValue(new Error("SES said no"));

    await expect(sendEmail({ ...MESSAGE })).rejects.toThrow("SES said no");

    const update = mocks.emailLogUpdate.mock.calls.at(-1)?.[0];
    expect(update.data.status).toBe("FAILED");
    expect(update.data).not.toHaveProperty("deliveryBlockReason");
  });
});

describe("confirmed NON_PRODUCTION", () => {
  it("contacts no provider, and records a terminal SKIPPED_NON_PRODUCTION with no body", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome).toEqual({
      status: "withheld_for_environment",
      emailLogId: "log_1",
      reason: "environment_non_production",
    });
    // Not merely "no message arrived" — no transport was even asked for, so no
    // credential was used and no connection was opened.
    expect(mocks.getEmailTransporter).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: {
        status: "SKIPPED_NON_PRODUCTION",
        htmlBody: null,
        bookingRetryHtmlBody: null,
        errorMessage: expect.stringContaining("Held back"),
      },
    });
  });

  it("suppresses when an administrator has forced the copy, even under a declared production", async () => {
    declareEnvironmentRole("production");
    mocks.environmentSafetyFindUnique.mockResolvedValue({
      forceNonProduction: true,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedByMemberId: "m_1",
    });
    await expectEnvironmentRolePremise("NON_PRODUCTION");

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome.status).toBe("withheld_for_environment");
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.emailLogUpdate.mock.calls.at(-1)?.[0].data.errorMessage).toContain(
      "safer override",
    );
  });

  it("does not use the terminal status for the club's own No emails switch", async () => {
    // The two must never collapse into one another: one is an administrator's
    // decision about a booking, the other is a fact about the installation.
    declareEnvironmentRole("non-production");
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const outcome = await sendEmail({
      ...MESSAGE,
      bookingContext: {
        bookingId: "bk_1",
        recipient: { kind: "non-login-public-contact" },
      },
    });

    expect(outcome.status).toBe("withheld_for_booking");
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "SKIPPED_NO_EMAILS" }),
    });
  });
});

describe("UNKNOWN environment", () => {
  it("contacts no provider, and leaves a RETRYABLE row that names why", async () => {
    undeclareEnvironmentRole();
    await expectEnvironmentRolePremise("UNKNOWN");

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome).toEqual({
      status: "withheld_for_environment",
      emailLogId: "log_1",
      reason: "environment_unknown",
    });
    expect(mocks.getEmailTransporter).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: {
        status: "FAILED",
        deliveryBlockReason: "ENVIRONMENT_DECLARATION_MISSING",
        errorMessage: expect.stringContaining("APP_ENVIRONMENT_ROLE"),
      },
    });
  });

  it("keeps the retained body, because this outcome is meant to self-heal", async () => {
    /*
      The reason this is FAILED rather than a second terminal status. An
      installation that upgraded without the declaration is a LIVE club whose
      members are waiting; the moment an operator sets the variable, the retry
      cron replays what was held back. Dropping the body would make that
      impossible and would need every message re-triggered by hand.
    */
    undeclareEnvironmentRole();

    await sendEmail({ ...MESSAGE });

    const update = mocks.emailLogUpdate.mock.calls.at(-1)?.[0];
    expect(update.data).not.toHaveProperty("htmlBody");
    expect(update.data).not.toHaveProperty("bookingRetryHtmlBody");
  });

  it("distinguishes a refused declaration from a missing one", async () => {
    declareEnvironmentRole("staging");
    await expectEnvironmentRolePremise("UNKNOWN");

    await sendEmail({ ...MESSAGE });

    expect(mocks.emailLogUpdate.mock.calls.at(-1)?.[0].data.deliveryBlockReason).toBe(
      "ENVIRONMENT_DECLARATION_INVALID",
    );
  });

  it("distinguishes a database that cannot answer from a deployment that said nothing", async () => {
    declareEnvironmentRole("production");
    mocks.environmentSafetyFindUnique.mockRejectedValue(
      new Error("relation does not exist"),
    );
    await expectEnvironmentRolePremise("UNKNOWN");

    await sendEmail({ ...MESSAGE });

    expect(mocks.emailLogUpdate.mock.calls.at(-1)?.[0].data.deliveryBlockReason).toBe(
      "ENVIRONMENT_OVERRIDE_UNREADABLE",
    );
  });

  it("raises no admin email about it, because that alert would be held back too", async () => {
    /*
      Deliberately unlike the #2258 fail-closed withhold beside it, which does
      alert. That alert is itself an email: on this path it would be blocked by
      this very gate, and on a copy it would mail the club's real admins from a
      copy. The unresolved state is surfaced where it can be acted on instead —
      the boot log, the setup checklist and Admin -> Environment (all #3034).
    */
    undeclareEnvironmentRole();

    await sendEmail({ ...MESSAGE });

    expect(mocks.getAdminEmails).not.toHaveBeenCalled();
  });
});
