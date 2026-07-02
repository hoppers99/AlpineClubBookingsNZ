import { beforeEach, describe, expect, it, vi } from "vitest";
import * as OTPAuth from "otpauth";

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
    Promise.all(operations),
  ),
  twoFactorEmailCode: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: "email-code-1" }),
    findUnique: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  twoFactorRecoveryCode: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 10 }),
    findUnique: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  member: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({ id: "member-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  consumeRecoveryCode,
  createTwoFactorEmailCode,
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
  enrollTwoFactor,
  generateTotpEnrollment,
  hashEmailOtpCode,
  hashRecoveryCode,
  recordTwoFactorFailure,
  verifyTotpCode,
  verifyTwoFactorEmailCode,
  TWO_FACTOR_MAX_FAILED_ATTEMPTS,
} from "@/lib/two-factor";

describe("two-factor helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-for-two-factor");
  });

  it("encrypts TOTP secrets at rest", () => {
    const encrypted = encryptTwoFactorSecret("BASE32SECRET");

    expect(encrypted).not.toContain("BASE32SECRET");
    expect(decryptTwoFactorSecret(encrypted)).toBe("BASE32SECRET");
  });

  it("verifies TOTP codes with a small skew window", () => {
    const setup = generateTotpEnrollment("member@example.test");
    const totp = new OTPAuth.TOTP({
      issuer: setup.issuer,
      label: setup.label,
      secret: OTPAuth.Secret.fromBase32(setup.secret),
    });

    expect(verifyTotpCode(setup.secret, totp.generate())).toBe(true);
    expect(verifyTotpCode(setup.secret, "123")).toBe(false);
  });

  it("stores and verifies email OTP codes by HMAC hash", async () => {
    const issued = await createTwoFactorEmailCode("member-1");
    const createCall = mockPrisma.twoFactorEmailCode.create.mock.calls[0]?.[0];
    expect(createCall.data.codeHash).toBe(hashEmailOtpCode(issued.code));
    expect(createCall.data.codeHash).not.toBe(issued.code);

    mockPrisma.twoFactorEmailCode.findUnique.mockResolvedValue({
      id: "email-code-1",
      memberId: "member-1",
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      verifyTwoFactorEmailCode("member-1", issued.code),
    ).resolves.toBe(true);
    expect(mockPrisma.twoFactorEmailCode.updateMany).toHaveBeenCalledWith({
      where: { id: "email-code-1", used: false },
      data: { used: true },
    });
  });

  it("rejects expired email OTP codes", async () => {
    mockPrisma.twoFactorEmailCode.findUnique.mockResolvedValue({
      id: "email-code-1",
      memberId: "member-1",
      used: false,
      expiresAt: new Date(Date.now() - 1),
    });

    await expect(
      verifyTwoFactorEmailCode("member-1", "123456"),
    ).resolves.toBe(false);
  });

  it("consumes recovery codes once", async () => {
    const code = "ABCD-EFGH-IJKL";
    mockPrisma.twoFactorRecoveryCode.findUnique.mockResolvedValue({
      id: "recovery-1",
      memberId: "member-1",
      codeHash: hashRecoveryCode(code),
      usedAt: null,
    });

    await expect(consumeRecoveryCode("member-1", code)).resolves.toBe(true);
    expect(mockPrisma.twoFactorRecoveryCode.updateMany).toHaveBeenCalledWith({
      where: { id: "recovery-1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });

    mockPrisma.twoFactorRecoveryCode.findUnique.mockResolvedValue({
      id: "recovery-1",
      memberId: "member-1",
      usedAt: new Date(),
    });
    await expect(consumeRecoveryCode("member-1", code)).resolves.toBe(false);
  });

  it("enrolls TOTP with encrypted secret and replacement recovery codes", async () => {
    const recoveryCodes = await enrollTwoFactor({
      memberId: "member-1",
      method: "TOTP",
      totpSecret: "BASE32SECRET",
    });

    expect(recoveryCodes).toHaveLength(10);
    const updateCall = mockPrisma.member.update.mock.calls[0]?.[0];
    expect(updateCall.data.twoFactorEnabled).toBe(true);
    expect(updateCall.data.twoFactorMethod).toBe("TOTP");
    expect(updateCall.data.totpSecret).not.toBe("BASE32SECRET");
    expect(decryptTwoFactorSecret(updateCall.data.totpSecret)).toBe(
      "BASE32SECRET",
    );
    expect(mockPrisma.twoFactorRecoveryCode.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          memberId: "member-1",
          codeHash: expect.any(String),
        }),
      ]),
    });
  });

  it("locks the member after repeated invalid two-factor attempts", async () => {
    mockPrisma.member.findUnique.mockResolvedValue({
      twoFactorFailedAttempts: TWO_FACTOR_MAX_FAILED_ATTEMPTS - 1,
    });

    const lockedUntil = await recordTwoFactorFailure("member-1");

    expect(lockedUntil).toBeInstanceOf(Date);
    expect(mockPrisma.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: {
        twoFactorFailedAttempts: 0,
        twoFactorLockedUntil: lockedUntil,
      },
    });
  });
});
