/**
 * HTML escaping for email bodies.
 *
 * A LEAF on purpose (#2689). `email-message-settings.ts` and
 * `member-guest-email-notes.ts` both need it, and both used to reach into the
 * template monolith for it while the monolith imported from them — two runtime
 * cycles that the old file carried a comment about rather than a fix, because
 * `escapeHtml` could not be separated from the 5,000 lines around it. This
 * module imports nothing, so neither cycle can re-form.
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
