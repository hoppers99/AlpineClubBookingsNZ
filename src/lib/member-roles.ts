import type { Role } from "@prisma/client";

export const ROLE_VALUES = [
  "USER",
  "ADMIN",
  "LODGE",
  "NON_MEMBER",
  "SCHOOL",
] as const satisfies readonly Role[];

export type AppRole = (typeof ROLE_VALUES)[number];

export const MEMBER_LEVEL_ROLE_VALUES = [
  "USER",
] as const satisfies readonly Role[];

export type MemberLevelRole = (typeof MEMBER_LEVEL_ROLE_VALUES)[number];

export const OPERATIONAL_ROLE_VALUES = [
  "ADMIN",
  "LODGE",
] as const satisfies readonly Role[];

// Non-member categories created by booking-request flows. These carry NO access:
// they are deliberately excluded from MEMBER_LEVEL and OPERATIONAL role sets, so
// every existing allowlist permission check treats them as "no access". They are
// also excluded from member rosters and exempt from subscription obligations.
export const NON_MEMBER_ROLE_VALUES = [
  "NON_MEMBER",
  "SCHOOL",
] as const satisfies readonly Role[];

export const MEMBER_IMPORT_ROLE_VALUES = [
  "USER",
  "ADMIN",
] as const satisfies readonly Role[];

export const ROLE_LABELS: Record<AppRole, string> = {
  USER: "User",
  ADMIN: "Admin",
  LODGE: "Lodge",
  NON_MEMBER: "Non-Member",
  SCHOOL: "School",
};

export function isRole(value: string | null | undefined): value is AppRole {
  return ROLE_VALUES.includes(value as AppRole);
}

export function isMemberLevelRole(
  role: string | null | undefined,
): role is MemberLevelRole {
  return MEMBER_LEVEL_ROLE_VALUES.includes(role as MemberLevelRole);
}

/**
 * True for the shared lodge kiosk device login (legacy role or normalized
 * access-role rows). Kiosk accounts never hold bookings; members holding
 * the admin role are real people and remain bookable-on-behalf.
 */
export function isLodgeKioskAccount(
  role: string | null | undefined,
  accessRoles?: readonly string[] | null,
): boolean {
  return role === "LODGE" || (accessRoles ?? []).includes("LODGE");
}

export function isOperationalRole(
  role: string | null | undefined,
): role is (typeof OPERATIONAL_ROLE_VALUES)[number] {
  return OPERATIONAL_ROLE_VALUES.includes(
    role as (typeof OPERATIONAL_ROLE_VALUES)[number],
  );
}

/**
 * Whether an admin may open a membership-cancellation request for this
 * member: member-level role, active, not already cancelled, not archived.
 *
 * Mirrors the member-state half of `createAdminMembershipCancellationRequest`
 * (see the pointer beside its checks). The server additionally rejects a
 * missing member and an existing open participant; a caller that can already
 * see an open request must keep its own `!openCancellationRequest` conjunct,
 * or the action it offers will 409.
 *
 * Deliberately NOT an access-role check (#2354): access roles are cleared for
 * anyone who cannot log in, so dependants and non-login adults resolve to
 * zero roles while their memberships remain cancellable. The admin path
 * confirms every participant on their behalf, whatever their login state.
 */
export function canAdminRequestMembershipCancellation(member: {
  role: string | null | undefined;
  active: boolean;
  cancelledAt: string | Date | null | undefined;
  archivedAt: string | Date | null | undefined;
}): boolean {
  return (
    isMemberLevelRole(member.role) &&
    member.active &&
    !member.cancelledAt &&
    !member.archivedAt
  );
}
