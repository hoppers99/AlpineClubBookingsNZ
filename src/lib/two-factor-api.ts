import { NextResponse } from "next/server";
import { auth, updateSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  clearTwoFactorLockout,
  getActiveTwoFactorLockout,
} from "@/lib/two-factor";

export const TWO_FACTOR_MEMBER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  active: true,
  forcePasswordChange: true,
  twoFactorEnabled: true,
  twoFactorMethod: true,
  totpSecret: true,
  twoFactorFailedAttempts: true,
  twoFactorLockedUntil: true,
} as const;

export type TwoFactorApiMember = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  active: boolean;
  forcePasswordChange: boolean;
  twoFactorEnabled: boolean;
  twoFactorMethod: "TOTP" | "EMAIL" | null;
  totpSecret: string | null;
  twoFactorFailedAttempts: number;
  twoFactorLockedUntil: Date | null;
};

export type TwoFactorApiSession = Awaited<ReturnType<typeof auth>>;

export type TwoFactorApiGuardResult =
  | {
      ok: true;
      session: NonNullable<TwoFactorApiSession>;
      member: TwoFactorApiMember;
    }
  | { ok: false; response: NextResponse };

export async function requireTwoFactorApiSession(): Promise<TwoFactorApiGuardResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    };
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: TWO_FACTOR_MEMBER_SELECT,
  });

  if (!member?.active) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Account is deactivated" },
        { status: 403 },
      ),
    };
  }

  return { ok: true, session, member };
}

export async function markTwoFactorSessionVerified() {
  const session = await auth();
  if (session?.user?.id) {
    await clearTwoFactorLockout(session.user.id);
  }

  await updateSession({
    user: {
      twoFactorVerified: true,
    },
  });
}

export function passwordChangeRequiredResponse() {
  return NextResponse.json(
    { error: "Password change required" },
    { status: 403 },
  );
}

export function twoFactorLockoutResponse(member: TwoFactorApiMember) {
  const lockedUntil = getActiveTwoFactorLockout(member);
  if (!lockedUntil) return null;

  return NextResponse.json(
    {
      error: "Too many invalid two-factor attempts",
      lockedUntil: lockedUntil.toISOString(),
    },
    { status: 429 },
  );
}

export function getTwoFactorStatusPayload(
  session: NonNullable<TwoFactorApiSession>,
  member: TwoFactorApiMember,
) {
  return {
    required: session.user.twoFactorRequired,
    verified: session.user.twoFactorVerified,
    enrolled: member.twoFactorEnabled,
    method: member.twoFactorMethod,
    email: member.email,
    forcePasswordChange: member.forcePasswordChange,
    lockedUntil: getActiveTwoFactorLockout(member)?.toISOString() ?? null,
  };
}
