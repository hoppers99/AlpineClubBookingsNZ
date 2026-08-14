/**
 * HTML escaping for email bodies.
 *
 * A LEAF on purpose (#2689), and it imports NOTHING. Keep it that way.
 *
 * Two modules need `escapeHtml` and are needed BY the templates in turn, so
 * while it lived in the 5,000-line monolith each pairing closed a loop:
 *
 *   email-message-settings.ts — a real runtime cycle. It imported `escapeHtml`
 *   from the monolith, and the monolith imported `EMAIL_DEFAULT_FROM_NAME` back
 *   from it for the `<title>` every email carries.
 *
 *   member-guest-email-notes.ts — a cycle the old file could only dodge. It
 *   imported `escapeHtml`, so the monolith's own import of `MemberGuestPartyList`
 *   had to be type-only, under a comment saying a value import "would close a
 *   runtime cycle". The dodge is no longer needed.
 *
 * Both now import this leaf instead, so neither loop exists to close.
 */
/** Escape HTML special characters to prevent injection in email templates. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
