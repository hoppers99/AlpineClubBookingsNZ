/**
 * Club-internal placeholder email for walk-in booking owners (issue #1935, E9).
 *
 * `Member.email` is non-nullable, but a phone/walk-in non-member booking owner
 * often has no email address. Instead of a schema change we store a recognisable
 * placeholder on the `.invalid` reserved TLD (RFC 2606 — never deliverable) so
 * that:
 *   - no outbound email is ever sent to that owner (see the guard in
 *     `sendEmail`, src/lib/email/core.ts),
 *   - the placeholder is never used for Xero contact email-matching and is never
 *     pushed to Xero as a real address (see the guards in xero-contacts.ts /
 *     xero-contact-sync.ts).
 *
 * This module is a dependency-free leaf (crypto only) so it can be imported from
 * the email core, the Xero contact layer, and the non-member-contact service
 * without introducing an import cycle.
 */
import { randomUUID } from "crypto";

/**
 * Reserved club-internal domain for walk-in placeholder addresses. `.invalid`
 * is guaranteed non-resolvable (RFC 2606), so a placeholder can never collide
 * with a real deliverable address.
 */
export const PLACEHOLDER_CONTACT_EMAIL_DOMAIN = "no-email.invalid";

/**
 * The other club-internal `.invalid` address this codebase mints: the
 * anonymised address written over a member's real one when a self-service
 * deletion request is approved (`deleted-xxxxxxxx@deleted.invalid`, see
 * `POST /api/admin/deletion-requests/[id]`).
 *
 * It was never recognised as undeliverable, which mattered once email
 * inheritance could resolve to an ancestor several generations up (#2255): a
 * grandchild could keep resolving to an anonymised grandparent and hard-bounce
 * on every send. It is deliverability-equivalent to a walk-in placeholder — a
 * reserved-TLD address nobody reads — so it is treated as one.
 */
export const DELETED_CONTACT_EMAIL_DOMAIN = "deleted.invalid";

/**
 * Every domain {@link isPlaceholderContactEmail} rejects. Exported so a SQL
 * filter that has to mirror that predicate (the admin "inherit email from"
 * candidate search) cannot list a subset and drift out of step with it.
 */
export const PLACEHOLDER_CONTACT_EMAIL_DOMAINS = [
  PLACEHOLDER_CONTACT_EMAIL_DOMAIN,
  DELETED_CONTACT_EMAIL_DOMAIN,
] as const;

/**
 * Mint a fresh, unique placeholder address for a walk-in contact. Uniqueness
 * keeps distinct walk-ins on distinct stored strings even though the partial
 * `Member_email_login_unique` index (canLogin = true only) never applies to
 * these non-login contacts.
 */
export function buildPlaceholderContactEmail(): string {
  return `walk-in-${randomUUID()}@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}`;
}

/**
 * True when the address is a club-internal placeholder rather than a real one —
 * a walk-in contact who gave no address, or a member anonymised by an approved
 * deletion request. Case/whitespace-insensitive; matches on the reserved
 * domains.
 *
 * Callers use this to decide whether an address can RECEIVE mail, and both
 * domains answer "no", so both belong here rather than only the walk-in one.
 */
export function isPlaceholderContactEmail(
  email: string | null | undefined
): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return PLACEHOLDER_CONTACT_EMAIL_DOMAINS.some((domain) =>
    normalized.endsWith(`@${domain}`)
  );
}
