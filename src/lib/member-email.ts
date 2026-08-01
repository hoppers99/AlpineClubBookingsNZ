import {
  describeUniqueConstraintTarget,
  isPrismaUniqueConstraintError,
} from "@/lib/prisma-errors";

/**
 * Minimum member data needed to resolve the effective email address.
 * Include `inheritEmailFrom` in your Prisma select to avoid an extra DB lookup.
 */
export type EmailResolvableMember = {
  email: string;
  inheritEmailFromId?: string | null;
  inheritEmailFrom?: { email: string } | null;
};

export function resolveEffectiveEmail(member: EmailResolvableMember): string {
  if (member.inheritEmailFromId && member.inheritEmailFrom) {
    return member.inheritEmailFrom.email;
  }

  return member.email;
}

/**
 * The single wording an admin sees when an address is already somebody's
 * login. Shared so the member edit (#2385), the family-group login-holder
 * transfer (#2385) and the member create (#2412) refuse in the same words.
 */
export const MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE =
  "A member with this email already exists";

/**
 * The names a login-email clash can arrive under. `@prisma/adapter-pg` reports
 * the colliding COLUMN, which for the partial index below is plain `email`; the
 * INDEX NAME is what survives when Postgres withholds the `Key (…)` detail, and
 * the index the login invariant rests on is `Member_email_login_unique`
 * (`prisma/migrations/20260408010000_add_can_login_field/migration.sql`),
 * lowercased by `describeUniqueConstraintTarget`.
 */
const LOGIN_EMAIL_CONSTRAINT_NAMES = new Set([
  "email",
  "member_email_login_unique",
]);

/**
 * Does this failure mean "that address is already somebody's login"? (#2385)
 *
 * The backstop for the three admin writes that can claim an address as a login
 * identity: the member edit (`updateAdminMember`), the family-group login-holder
 * transfer, and the member create (`createAdminMember`, #2412). All three check
 * for a clash before writing, so this only has to catch the race that pre-check
 * cannot close — a concurrent write that claims the address in between. The
 * partial unique index
 * `Member_email_login_unique` (`WHERE "canLogin" = true`) is what actually
 * makes two login-capable members on one address impossible; this only
 * translates its rejection into the same 409 the pre-check returns, so the
 * loser of the race gets the same explanation rather than a 500.
 *
 * None of the three can raise any OTHER unique-constraint failure: the member
 * row's remaining unique columns (`googleSub`, `xeroContactId`) are written on
 * none of these paths, the member edit's access-role rows are deleted and
 * re-created with `skipDuplicates`, the partner-share sweep reads, deletes bed
 * allocations and writes `AuditLog` rows, and `AuditLog` carries no unique
 * constraint at all. The create's other writes are all for a member id that did
 * not exist a moment ago — its access roles, its default season subscription
 * (`@@unique([memberId, seasonYear])`), and family-group joins written with
 * `skipDuplicates`. So a P2002 that names nothing identifiable is still reported
 * as the email clash — that is the only collision these writes can produce, and
 * staying silent would leave an unexplained failure. But when the database DOES
 * name a different constraint (a unique column added to one of these writes
 * later, say), do not claim the email is taken: fall through to the generic
 * failure rather than sending the admin off to fix an address that is fine.
 *
 * `canClaimLoginEmail: false` withdraws that benefit of the doubt for the
 * unnamed case, and a caller writing a member who cannot log in must pass it
 * (#2412): `Member_email_login_unique` is `WHERE "canLogin" = true` and no
 * unconditional email unique survives, so NO email constraint can fire on such
 * a write and "that address is taken" would be provably wrong advice. A named
 * email clash is still honoured either way — the flag only decides who owns the
 * P2002 that names nothing.
 *
 * A NAMED target is matched WORD by word against the space-separated name
 * `describeUniqueConstraintTarget` returns, never as a substring (#2455).
 * That helper can hand back an INDEX NAME rather than a column list — from the
 * adapter's `cause.constraint.index`, or from a message that only says
 * ``on the constraint: `…` `` — and a Prisma index name carries its model
 * prefix, so `EmailChangeToken_tokenHash_key` normalises to
 * `emailchangetoken_tokenhash_key`. That CONTAINS "email", and a substring test
 * would have told a member confirming an email change that their new address
 * was taken because a token hash collided. A composite target still matches on
 * its `email` member, because the helper space-separates the list.
 */
export function isLoginEmailUniqueConflict(
  error: unknown,
  { canClaimLoginEmail = true }: { canClaimLoginEmail?: boolean } = {}
): boolean {
  if (!isPrismaUniqueConstraintError(error)) {
    return false;
  }
  const target = describeUniqueConstraintTarget(error);
  if (target === null) {
    return canClaimLoginEmail;
  }
  return target
    .split(" ")
    .some((name) => LOGIN_EMAIL_CONSTRAINT_NAMES.has(name));
}
