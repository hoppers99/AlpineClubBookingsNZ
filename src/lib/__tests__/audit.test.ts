import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildMemberAuditLogWhere,
  classifyAuditRetention,
  createAuditLog,
  createStructuredAuditLog,
  getAuditRetentionExpiresAt,
  sanitizeAuditMetadata,
} from "@/lib/audit";
import { redactSensitiveJson } from "@/lib/redact-sensitive-json";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
  },
}));

function auditDb() {
  return {
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("audit helper", () => {
  const sensitivePaymentMetadataKey = [
    "paymentIntent",
    "Client",
    "Secret",
  ].join("");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps legacy createAuditLog calls compatible", async () => {
    const db = auditDb();

    await createAuditLog(
      {
        action: "legacy.action",
        memberId: "actor-member",
        targetId: "target-id",
        details: "Legacy details",
        ipAddress: "203.0.113.10",
      },
      db as never
    );

    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: "legacy.action",
        memberId: "actor-member",
        targetId: "target-id",
        details: "Legacy details",
        ipAddress: "203.0.113.10",
        actorMemberId: "actor-member",
      },
    });
  });

  it("sanitizes legacy audit detail strings before persistence", async () => {
    const db = auditDb();

    await createAuditLog(
      {
        action: "legacy.secret",
        details:
          "Retry failed for cardNumber=4242 4242 4242 4242 and token=live-token",
      },
      db as never
    );

    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        details:
          "Retry failed for cardNumber=[REDACTED] and token=[REDACTED]",
      }),
    });
  });

  it("maps structured audit events onto actor, subject, entity, and retention fields", async () => {
    const db = auditDb();

    await createStructuredAuditLog(
      {
        action: "booking.payment.succeeded",
        actor: { memberId: "actor-member" },
        subject: { memberId: "subject-member" },
        entity: { type: "Payment", id: "payment-1" },
        category: "payment",
        severity: "critical",
        summary: "Payment succeeded",
        metadata: {
          amountCents: 12345,
          [sensitivePaymentMetadataKey]: "redacted payment credential fixture",
        },
        request: {
          id: "req-1",
          ipAddress: "203.0.113.20",
          userAgent: "Unit Test",
        },
      },
      db as never
    );

    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "booking.payment.succeeded",
        memberId: "actor-member",
        targetId: "subject-member",
        actorMemberId: "actor-member",
        subjectMemberId: "subject-member",
        entityType: "Payment",
        entityId: "payment-1",
        category: "payment",
        severity: "critical",
        outcome: "success",
        summary: "Payment succeeded",
        requestId: "req-1",
        ipAddress: "203.0.113.20",
        userAgent: "Unit Test",
        retentionClass: "critical",
        expiresAt: new Date("2033-01-01T00:00:00.000Z"),
      }),
    });

    const data = db.auditLog.create.mock.calls[0][0].data;
    expect(data.metadata).toEqual({
      amountCents: 12345,
      [sensitivePaymentMetadataKey]: "[REDACTED]",
    });
  });

  it("sanitizes metadata secrets, raw bodies, card data, and long HTML", () => {
    const sanitized = sanitizeAuditMetadata({
      password: "secret",
      passwordHash: "hash",
      resetToken: "reset",
      verificationToken: "verify",
      nominationToken: "nominate",
      sessionToken: "session",
      authSecret: "auth-secret",
      rawBody: { password: "nested" },
      card: { number: "4242424242424242", cvc: "123" },
      safe: {
        changedFields: ["email"],
        note: "safe note",
      },
      emailContent: `<html><body>${"hello".repeat(150)}</body></html>`,
      longText: "x".repeat(1200),
    }) as Record<string, unknown>;

    expect(sanitized.password).toBe("[REDACTED]");
    expect(sanitized.passwordHash).toBe("[REDACTED]");
    expect(sanitized.resetToken).toBe("[REDACTED]");
    expect(sanitized.verificationToken).toBe("[REDACTED]");
    expect(sanitized.nominationToken).toBe("[REDACTED]");
    expect(sanitized.sessionToken).toBe("[REDACTED]");
    expect(sanitized.authSecret).toBe("[REDACTED]");
    expect(sanitized.rawBody).toBe("[REDACTED]");
    expect(sanitized.card).toBe("[REDACTED]");
    expect(sanitized.safe).toEqual({
      changedFields: ["email"],
      note: "safe note",
    });
    expect(sanitized.emailContent).toBe("[REDACTED_LONG_HTML]");
    expect(String(sanitized.longText)).toContain("[TRUNCATED]");
  });

  // #2269 second review. A handful of audit rows exist BECAUSE the metadata is
  // the record — Restore Default deletes a club's email wording with one click
  // and no undo, and the audit row is the only copy left. The 1000-character
  // clip turned a measured 1748-character body into 1014 characters ending
  // "[TRUNCATED]", which is not a copy of anything. Archive mode relaxes size
  // and nothing else.
  describe("archive mode", () => {
    it("keeps a long value whole instead of clipping it at 1000 characters", () => {
      const wording = "x".repeat(1748);
      const sanitized = sanitizeAuditMetadata(
        { deletedOverride: { bodyText: wording } },
        { archiveText: { maxStringLength: 10_000 } }
      ) as { deletedOverride: { bodyText: string } };

      expect(sanitized.deletedOverride.bodyText).toBe(wording);
    });

    it("changes nothing for a caller that does not ask for it", () => {
      const sanitized = sanitizeAuditMetadata({
        deletedOverride: { bodyText: "x".repeat(1748) },
      }) as { deletedOverride: { bodyText: string } };

      expect(sanitized.deletedOverride.bodyText).toContain("[TRUNCATED]");
      expect(sanitized.deletedOverride.bodyText.length).toBeLessThan(1_100);
    });

    it("still redacts secrets, card numbers and sensitive keys", () => {
      const sanitized = sanitizeAuditMetadata(
        {
          apiKey: `${"a".repeat(1200)} sk_live_ABCDEF1234567890`,
          card: { number: "4242424242424242" },
          note: `${"n".repeat(1200)} 4242 4242 4242 4242`,
          password: "secret",
        },
        { archiveText: { maxStringLength: 10_000 } }
      ) as Record<string, unknown>;

      expect(sanitized.apiKey).toBe("[REDACTED]");
      expect(sanitized.card).toBe("[REDACTED]");
      expect(sanitized.password).toBe("[REDACTED]");
      expect(String(sanitized.note)).toContain("[REDACTED_CARD]");
    });

    it("still clips a value that runs past the archive length it was given", () => {
      const sanitized = sanitizeAuditMetadata(
        { bodyText: "x".repeat(12_000) },
        { archiveText: { maxStringLength: 10_000 } }
      ) as { bodyText: string };

      expect(sanitized.bodyText).toContain("[TRUNCATED]");
    });

    it("gives the JSON envelope matching headroom so it cannot collapse to a stub", () => {
      // A value that is mostly newlines doubles under JSON escaping. Without
      // the extra headroom the whole object becomes {_truncated: true, …},
      // which loses more than the clipping it was meant to avoid.
      const wording = "a\n".repeat(5_000);
      const sanitized = sanitizeAuditMetadata(
        { bodyText: wording },
        { archiveText: { maxStringLength: 10_000 } }
      ) as { bodyText?: string; _truncated?: boolean };

      expect(sanitized._truncated).toBeUndefined();
      expect(sanitized.bodyText).toBe(wording);
    });
  });

  it("classifies retention and calculates expiry dates", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");

    expect(
      classifyAuditRetention({
        action: "admin.member.view",
        category: "admin",
      })
    ).toBe("sensitive_access");
    expect(
      classifyAuditRetention({
        action: "booking.confirmed",
        category: "booking",
      })
    ).toBe("critical");
    expect(
      classifyAuditRetention({
        action: "request.debug",
        category: "system",
        retentionClass: "diagnostic_high_volume",
      })
    ).toBe("diagnostic_high_volume");

    expect(getAuditRetentionExpiresAt("critical", from)).toEqual(
      new Date("2033-01-01T00:00:00.000Z")
    );
    expect(getAuditRetentionExpiresAt("sensitive_access", from)).toEqual(
      new Date("2028-01-01T00:00:00.000Z")
    );
    expect(getAuditRetentionExpiresAt("diagnostic_high_volume", from)).toEqual(
      new Date("2026-04-01T00:00:00.000Z")
    );
  });

  it("builds a member history where condition for structured and legacy rows", () => {
    expect(buildMemberAuditLogWhere("member-1")).toEqual({
      OR: [
        { subjectMemberId: "member-1" },
        { AND: [{ subjectMemberId: null }, { actorMemberId: "member-1" }] },
        { AND: [{ subjectMemberId: null }, { memberId: "member-1" }] },
        { AND: [{ subjectMemberId: null }, { targetId: "member-1" }] },
      ],
    });
  });

  // INV-PRIV-011 (#2683). The two key lists deliberately differ, and this pins
  // the difference in both directions at once: the log/Sentry redactor strips
  // first name, last name AND street address, while the admin-action audit
  // writer keeps all three, because an evidence record that cannot say who stops
  // being evidence (owner decision, 10 Aug 2026). It fails if a later change
  // makes the two lists "consistent" in either direction — adding person fields
  // to audit.ts's sensitive keys, or dropping them from the log redactor's
  // denylist so they become visible everywhere.
  it("keeps name and street address in an audit row while the log redactor strips them", () => {
    const person = {
      firstName: "Jane",
      lastName: "Doe",
      streetAddressLine1: "12 Example Street",
    };

    expect(sanitizeAuditMetadata(person)).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      streetAddressLine1: "12 Example Street",
    });

    expect(redactSensitiveJson(person)).toEqual({
      firstName: "[REDACTED]",
      lastName: "[REDACTED]",
      streetAddressLine1: "[REDACTED]",
    });
  });
});
