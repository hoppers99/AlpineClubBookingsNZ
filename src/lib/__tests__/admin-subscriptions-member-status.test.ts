import { describe, expect, it } from "vitest";
import { serializeSubscriptionMemberLoginStage } from "@/lib/subscription-member-login-stage";
import { getMemberLoginStage } from "@/lib/member-login-stage";

function memberRecord(
  overrides: Partial<Parameters<typeof serializeSubscriptionMemberLoginStage>[0]> = {},
) {
  return {
    firstName: "Alice",
    lastName: "Summit",
    email: "alice@example.test",
    ageTier: "ADULT",
    role: "ADMIN",
    canLogin: true,
    passwordChangedAt: null,
    lastLoginAt: null,
    passwordResetTokens: [] as Array<{ expiresAt: Date; used: boolean }>,
    xeroContactId: "xero-1",
    seasonalMembershipAssignments: [],
    ...overrides,
  };
}

describe("Subscriptions member Access serialization", () => {
  it.each([
    [memberRecord({ canLogin: false }), "no-login"],
    [memberRecord(), "not-invited"],
    [
      memberRecord({
        passwordResetTokens: [
          { expiresAt: new Date("2999-01-01T00:00:00.000Z"), used: false },
        ],
      }),
      "invited",
    ],
    [memberRecord({ passwordChangedAt: new Date("2026-01-01T00:00:00.000Z") }), "can-login"],
  ] as const)("produces the shared %s login stage", (record, expectedStage) => {
    const serialized = serializeSubscriptionMemberLoginStage(record);
    expect(getMemberLoginStage(serialized)).toBe(expectedStage);
    expect(serialized).not.toHaveProperty("passwordChangedAt");
    expect(serialized).not.toHaveProperty("lastLoginAt");
    expect(serialized).not.toHaveProperty("passwordResetTokens");
  });

  it("ignores expired and used setup tokens", () => {
    const expired = serializeSubscriptionMemberLoginStage(
      memberRecord({
        passwordResetTokens: [
          { expiresAt: new Date("2020-01-01T00:00:00.000Z"), used: false },
        ],
      }),
    );
    const used = serializeSubscriptionMemberLoginStage(
      memberRecord({
        passwordResetTokens: [
          { expiresAt: new Date("2999-01-01T00:00:00.000Z"), used: true },
        ],
      }),
    );

    expect(expired.pendingInviteExpiresAt).toBeNull();
    expect(used.pendingInviteExpiresAt).toBeNull();
  });
});
