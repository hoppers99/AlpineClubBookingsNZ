/**
 * Canonical "this member row has been through an approved deletion" predicate
 * (#2620).
 *
 * An approved self-service deletion request anonymises the member in place
 * rather than deleting the row (`POST /api/admin/deletion-requests/[id]`,
 * the "Anonymise the member record" block) — bookings, payments and audit
 * history all reference it. The anonymisation leaves two recognisable markers
 * on the row:
 *
 *   - `passwordHash` set to the sentinel {@link DELETED_ACCOUNT_PASSWORD_HASH},
 *     which is not a bcrypt hash and can therefore never match a password, and
 *   - `email` rewritten to `deleted-xxxxxxxx@deleted.invalid`, on the reserved
 *     `.invalid` TLD (see `DELETED_CONTACT_EMAIL_DOMAIN`).
 *
 * Neither `cancelledAt` nor `archivedAt` is stamped, so the reactivation
 * refusals that key on those two fields never saw a deleted account: bulk
 * **Reactivate** would happily set `active: true` again and hand the erased
 * person their session — and their retained access roles — back. This module is
 * the single test those paths consult, so a deleted account is recognised
 * identically by the reactivation guards, the login providers and the members
 * list, and none of them can drift into its own copy of the marker test.
 *
 * The test is deliberately an OR over whichever markers the caller has: it is
 * only ever used to REFUSE, so a partial row must fail closed rather than fail
 * open. Both markers are written together in one `update`, and nothing else in
 * the application writes either of them, so the OR cannot produce a false
 * positive on a live member.
 *
 * Dependency-light on purpose (one leaf import) so it can be pulled into
 * `auth.ts`, the Google resolver and the member-lifecycle services without
 * introducing an import cycle.
 *
 * NOTE (#2618): PR #2618 introduces a second, Xero-only copy of this predicate
 * as `isDeletedAccountMarker` in `src/lib/xero-contact-create-recovery.ts`.
 * Once that PR has merged the two should be unified onto this module — it is
 * the auth/lifecycle-facing one, and a second marker test is exactly the drift
 * this module exists to prevent.
 */
import { DELETED_CONTACT_EMAIL_DOMAIN } from "./placeholder-contact-email";

/**
 * The sentinel written over `Member.passwordHash` when a deletion request is
 * approved. Not a bcrypt hash, so `bcrypt.compare` can never match it.
 */
export const DELETED_ACCOUNT_PASSWORD_HASH = "DELETED_ACCOUNT";

/**
 * Whatever subset of the anonymisation markers a caller happens to have
 * selected. Both fields are optional so a narrow `select` can still be tested
 * without widening it (the members list, for instance, never reads a password
 * hash).
 */
export type DeletedAccountMarkers = {
  email?: string | null;
  passwordHash?: string | null;
};

/** The 409 a bulk **Reactivate** answers with for a deleted account (#2620). */
export const DELETED_ACCOUNT_BULK_REACTIVATE_MESSAGE =
  "Deleted members cannot be reactivated from bulk update";

/** The 409 the member edit service answers with for a deleted account (#2620). */
export const DELETED_ACCOUNT_EDIT_REACTIVATE_MESSAGE =
  "Deleted members cannot be reactivated from member edit";

/**
 * True when the address is the anonymised one minted by an approved deletion.
 * Case/whitespace-insensitive. Narrower than `isPlaceholderContactEmail`, which
 * also answers true for a walk-in `@no-email.invalid` placeholder — a walk-in
 * contact is a perfectly ordinary member record and must never be mistaken for
 * an erased one.
 */
export function isDeletedAccountEmail(
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  return email
    .trim()
    .toLowerCase()
    .endsWith(`@${DELETED_CONTACT_EMAIL_DOMAIN}`);
}

/**
 * True when the row carries either anonymisation marker, i.e. this member has
 * been through an approved deletion request. Use this — never a hand-rolled
 * comparison — anywhere a deleted account must be refused.
 */
export function isDeletedAccountRecord(
  member: DeletedAccountMarkers | null | undefined,
): boolean {
  if (!member) return false;
  if (member.passwordHash === DELETED_ACCOUNT_PASSWORD_HASH) return true;
  return isDeletedAccountEmail(member.email);
}
