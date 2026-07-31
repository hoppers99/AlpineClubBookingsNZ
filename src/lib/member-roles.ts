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
//
// NOTE (#2383): this set is about ACCESS, not about who holds a membership.
// `SCHOOL` accounts are in here yet do hold real, fee-paying memberships, so it
// must never be reused to answer "is there a membership here to cancel?" — use
// `accountCanHoldMembership` below.
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
 * Whether this record is an account holder at all — a real person, or an
 * organisation the club can hold a membership for — and so has a membership
 * that could be cancelled (#2383).
 *
 * Named for exactly what it tests, because the rule it replaced was not. The
 * old gate was `isMemberLevelRole` — legacy `role === "USER"` — whose name
 * suggested "this is a member" but whose behaviour was "this account holds no
 * Full Admin bundle". That caught one of the five admin classes (a Membership
 * Officer, Booking Officer, Treasurer, Content Manager or custom-role holder
 * all store `role = "USER"` and were always cancellable), and it also swept up
 * organisation accounts, which hold real fee-paying memberships.
 *
 * This asks an identity question, never a permissions or seniority one: what
 * admin access somebody holds says nothing about whether they pay for and hold
 * a membership. Who may APPROVE a cancellation against a privileged account,
 * and the rule that the club is never left without a Full Admin, are separate
 * questions enforced at approval time by the #1604/#1622 admin-account guards
 * (`@/lib/admin-account-guards`).
 *
 * Only two kinds of record are refused:
 *
 * 1. **The lodge kiosk device login** — a shared device, not a person. Matched
 *    on the legacy `LODGE` role or a `LODGE` access-role row, so a kiosk
 *    identified by either is caught.
 * 2. **Booking-request contact records** — the guest and school contacts minted
 *    by the public booking-request flows (`src/lib/booking-request.ts`,
 *    `src/lib/school-booking-request.ts`). They hold no membership: they exist
 *    only to own a converted booking.
 *
 * The `canLogin` test applies to `SCHOOL` alone, and is not a login gate in
 * disguise. `SCHOOL` is genuinely two different things in this schema: the
 * legacy role of a real **organisation account** (User Type "Organisation",
 * which stores an `ORG` access-role row and can only be set on a login-capable
 * account), and the role stamped on every **school booking-request contact** —
 * the school's owner contact and each named teacher — which is always created
 * `canLogin: false`. Non-login is precisely the line the rest of the codebase
 * already draws between the two (`MAPPABLE_CONTACT_SCOPE` in
 * `@/lib/non-member-contact`; a public booking request is never mapped onto a
 * login-capable member). `NON_MEMBER` needs no such test — it is only ever a
 * booking-request guest record — so it is refused outright.
 *
 * This must NOT be generalised into "no login means not cancellable": family
 * dependants and non-login adults are ordinary `USER` members whose
 * memberships are cancellable, which was the whole point of #2354.
 *
 * `accessRoles` is used only to BLOCK (the kiosk), never to allow, because
 * access roles are cleared for anyone who cannot log in.
 */
export function accountCanHoldMembership(member: {
  role: string | null | undefined;
  canLogin: boolean;
  accessRoles?: readonly string[] | null;
}): boolean {
  if (isLodgeKioskAccount(member.role, member.accessRoles)) return false;
  if (member.role === "NON_MEMBER") return false;
  if (member.role === "SCHOOL") return member.canLogin;
  return true;
}

/**
 * Whether an admin may open a membership-cancellation request for this
 * member: an account that can hold a membership, active, not already
 * cancelled, not archived.
 *
 * Mirrors the member-state half of `createAdminMembershipCancellationRequest`
 * (see the pointer beside its checks). The server additionally rejects a
 * missing member and an existing open participant; a caller that can already
 * see an open request must keep its own `!openCancellationRequest` conjunct,
 * or the action it offers will 409.
 *
 * Deliberately NOT a permissions check (#2354, #2383). Access roles are cleared
 * for anyone who cannot log in, so dependants and non-login adults resolve to
 * zero roles while their memberships remain cancellable; and holding admin
 * access is not a reason to refuse — an admin is a fee-paying member like
 * anyone else. The admin path confirms every participant on their behalf,
 * whatever their login state.
 */
export function canAdminRequestMembershipCancellation(member: {
  role: string | null | undefined;
  canLogin: boolean;
  accessRoles?: readonly string[] | null;
  active: boolean;
  cancelledAt: string | Date | null | undefined;
  archivedAt: string | Date | null | undefined;
}): boolean {
  return (
    accountCanHoldMembership(member) &&
    member.active &&
    !member.cancelledAt &&
    !member.archivedAt
  );
}
