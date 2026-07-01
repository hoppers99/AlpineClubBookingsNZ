import { NextResponse } from "next/server";
import { generateTotpEnrollment } from "@/lib/two-factor";
import {
  passwordChangeRequiredResponse,
  requireTwoFactorApiSession,
  twoFactorLockoutResponse,
} from "@/lib/two-factor-api";

export async function GET() {
  const guard = await requireTwoFactorApiSession();
  if (!guard.ok) return guard.response;

  if (guard.member.forcePasswordChange) {
    return passwordChangeRequiredResponse();
  }

  const locked = twoFactorLockoutResponse(guard.member);
  if (locked) return locked;

  if (!guard.session.user.twoFactorRequired) {
    return NextResponse.json(
      { error: "Two-factor authentication is not required" },
      { status: 400 },
    );
  }

  if (guard.session.user.twoFactorVerified) {
    return NextResponse.json(
      { error: "Two-factor authentication is already verified" },
      { status: 400 },
    );
  }

  if (guard.member.twoFactorEnabled) {
    return NextResponse.json(
      { error: "Two-factor authentication is already enrolled" },
      { status: 409 },
    );
  }

  return NextResponse.json(
    generateTotpEnrollment(`${guard.member.email} (${guard.member.firstName})`),
  );
}
