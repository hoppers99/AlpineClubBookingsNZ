import { hasMemberCompletedAccountSetup } from "@/lib/password-reset";

export interface SubscriptionMemberLoginRecord {
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  role: string;
  canLogin: boolean;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
  passwordResetTokens: Array<{ expiresAt: Date; used: boolean }>;
  xeroContactId: string | null;
  seasonalMembershipAssignments?: Array<{
    membershipType: { subscriptionBehavior: string };
  }>;
}

/** Reduce a subscription query member to the public login-stage inputs. */
export function serializeSubscriptionMemberLoginStage(
  member: SubscriptionMemberLoginRecord,
) {
  const hasCompletedAccountSetup = hasMemberCompletedAccountSetup(member);
  const latestToken = member.passwordResetTokens[0];
  const pendingInviteExpiresAt =
    !hasCompletedAccountSetup &&
    latestToken &&
    !latestToken.used &&
    latestToken.expiresAt > new Date()
      ? latestToken.expiresAt
      : null;

  return {
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    ageTier: member.ageTier,
    role: member.role,
    canLogin: member.canLogin,
    hasCompletedAccountSetup,
    pendingInviteExpiresAt,
    xeroContactId: member.xeroContactId,
    seasonalMembershipAssignments: member.seasonalMembershipAssignments,
  };
}
