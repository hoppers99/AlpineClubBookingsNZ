import { describe, expect, it } from "vitest";
import {
  buildTwoFactorGatePath,
  isTwoFactorSessionBlocked,
} from "@/lib/two-factor-gate";

describe("two-factor route gate", () => {
  it("blocks sessions that require 2FA but have not verified", () => {
    expect(
      isTwoFactorSessionBlocked({
        sessionUser: {
          twoFactorRequired: true,
          twoFactorVerified: false,
        },
        member: { twoFactorEnabled: true },
      }),
    ).toBe(true);
  });

  it("allows sessions when 2FA is not required or already verified", () => {
    expect(
      isTwoFactorSessionBlocked({
        sessionUser: {
          twoFactorRequired: false,
          twoFactorVerified: false,
        },
        member: { twoFactorEnabled: false },
      }),
    ).toBe(false);

    expect(
      isTwoFactorSessionBlocked({
        sessionUser: {
          twoFactorRequired: true,
          twoFactorVerified: true,
        },
        member: { twoFactorEnabled: true },
      }),
    ).toBe(false);
  });

  it("lets forced-password-change sessions reach the password change path", () => {
    expect(
      isTwoFactorSessionBlocked({
        allowForcePasswordChange: true,
        sessionUser: {
          twoFactorRequired: true,
          twoFactorVerified: false,
        },
        member: {
          forcePasswordChange: true,
          twoFactorEnabled: false,
        },
      }),
    ).toBe(false);
  });

  it("routes unenrolled users to enroll and enrolled users to verify", () => {
    expect(
      buildTwoFactorGatePath({
        sessionUser: { twoFactorEnrolled: false },
        member: { twoFactorEnabled: false },
        callbackPath: "/admin/dashboard",
      }),
    ).toBe("/login/enroll?callbackUrl=%2Fadmin%2Fdashboard");

    expect(
      buildTwoFactorGatePath({
        sessionUser: { twoFactorEnrolled: true },
        member: { twoFactorEnabled: true },
        callbackPath: "/bookings",
      }),
    ).toBe("/login/verify?callbackUrl=%2Fbookings");
  });
});
