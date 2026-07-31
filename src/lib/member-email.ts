import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

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
 * login. Shared so the member edit and the family-group login-holder transfer
 * refuse in the same words (#2385).
 */
export const MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE =
  "A member with this email already exists";

/**
 * Names the unique constraint a P2002 failed on, lowercased, or null when the
 * error carries nothing identifiable.
 *
 * Two shapes are read, because it is NOT settled which one this stack produces
 * for a raw partial index such as `Member_email_login_unique`:
 *
 * - `meta.target` — a field-name array or a constraint-name string. This is
 *   what the old query engine populated, and what `isJoinCodeCollision`
 *   (`src/lib/group-booking.ts`) still reads for the `joinCode` collision
 *   retry, which is load-bearing in production.
 * - the formatted message — Prisma 7 reaches Postgres through the `pg` driver
 *   adapter, which parses the `Key (col, …)` detail of SQLSTATE 23505 into a
 *   `constraint` field and renders it as ``fields: (`email`)`` (or
 *   ``constraint: `…` ``). Read from the adapter source, a raw partial index is
 *   expected to report its COLUMN rather than its index name.
 *
 * Whether `meta.target` is ALSO populated under the driver adapter has not been
 * verified against a live database. `joinCode` is a schema-level `@unique`
 * while this is a hand-written partial index, and the two may well surface
 * differently — #2412 tracks that empirical check. Until it is answered, read
 * both shapes rather than betting on either: `meta.target` first, so behaviour
 * is preserved if the driver adapter is ever dropped, then the message.
 */
function describeUniqueConstraintTarget(error: unknown): string | null {
  const target = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  const targets = (Array.isArray(target) ? target : [target]).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  if (targets.length > 0) {
    return targets.join(" ").toLowerCase();
  }

  // The real message wraps the sentence below in an "Invalid
  // `prisma.member.update()` invocation in …" preamble plus a source excerpt,
  // so match anywhere rather than anchoring.
  const message = error instanceof Error ? error.message : "";
  const fields = message.match(/fields: \(([^)]*)\)/i)?.[1];
  if (fields) {
    return fields.toLowerCase();
  }
  const index = message.match(/constraint: `([^`]*)`/i)?.[1];
  if (index) {
    return index.toLowerCase();
  }
  return null;
}

/**
 * Does this failure mean "that address is already somebody's login"? (#2385)
 *
 * The backstop for the two admin writes that can claim an address as a login
 * identity: the member edit (`updateAdminMember`) and the family-group
 * login-holder transfer. Both check for a clash before writing, so this only
 * has to catch the race that pre-check cannot close — a concurrent write that
 * claims the address in between. The partial unique index
 * `Member_email_login_unique` (`WHERE "canLogin" = true`) is what actually
 * makes two login-capable members on one address impossible; this only
 * translates its rejection into the same 409 the pre-check returns, so the
 * loser of the race gets the same explanation rather than a 500.
 *
 * Neither write can raise any OTHER unique-constraint failure: the member row's
 * remaining unique columns (`googleSub`, `xeroContactId`) are written on
 * neither path, the member edit's access-role rows are deleted and re-created
 * with `skipDuplicates`, the partner-share sweep reads, deletes bed allocations
 * and writes `AuditLog` rows, and `AuditLog` carries no unique constraint at
 * all. So a P2002 that names nothing identifiable is still reported as the
 * email clash — that is the only collision these writes can produce, and
 * staying silent would leave an unexplained failure. But when the database DOES
 * name a different constraint (a unique column added to one of these writes
 * later, say), do not claim the email is taken: fall through to the generic
 * failure rather than sending the admin off to fix an address that is fine.
 */
export function isLoginEmailUniqueConflict(error: unknown): boolean {
  if (!isPrismaUniqueConstraintError(error)) {
    return false;
  }
  const target = describeUniqueConstraintTarget(error);
  return target === null || target.includes("email");
}
