/**
 * The ONLY messages the Xero OAuth callback may put in front of an admin, and
 * the allow-list both ends of that channel share (#2394 review, F9).
 *
 * The callback redirects failures back to an admin page as `?error=<message>`,
 * and two admin pages now render that value in a danger-styled box. The write
 * side has always collapsed anything unrecognised to {@link
 * XERO_OAUTH_CALLBACK_GENERIC_MESSAGE}, but the READ side trusted the query
 * string, so a crafted link could put attacker-chosen prose of any length into
 * an authoritative-looking red banner on a trusted admin page. React escapes it,
 * so this is not XSS — it is a phishing surface ("your Xero session expired,
 * call this number"), and it is fixed by allow-listing on read as well as on
 * write.
 *
 * Deliberately its own module with NO Node imports: `use-xero-connection.ts` is
 * a client hook, and `xero-oauth-state.ts` (the obvious neighbour) pulls in
 * `crypto` and `net`.
 */

/** OAuth state cookie missing or mismatched — a stale tab, or a forged callback. */
export const XERO_OAUTH_CALLBACK_INVALID_STATE_MESSAGE =
  "Invalid Xero OAuth state. Please reconnect from the admin page.";

/** Xero completed the round-trip but authorised no tenant we can use. */
export const XERO_OAUTH_CALLBACK_NO_TENANT_MESSAGE =
  "Xero did not return an organisation to connect. Please reconnect and choose the club organisation in Xero.";

/**
 * Everything else, including a refusal from Xero itself. Xero's own wording is
 * deliberately NOT passed through: it is attacker-influenceable (the callback is
 * a browser redirect) and often names internal detail an admin cannot act on.
 */
export const XERO_OAUTH_CALLBACK_GENERIC_MESSAGE =
  "Xero connection failed. Please reconnect from the admin page.";

const ALLOWED_MESSAGES: ReadonlySet<string> = new Set([
  XERO_OAUTH_CALLBACK_INVALID_STATE_MESSAGE,
  XERO_OAUTH_CALLBACK_NO_TENANT_MESSAGE,
  XERO_OAUTH_CALLBACK_GENERIC_MESSAGE,
]);

/**
 * Narrow a raw `?error=` query value to one of our own three messages.
 *
 * Returns null when there was no error at all, so a caller can tell "nothing to
 * say" from "something failed, generically". Anything present but unrecognised —
 * an injected sentence, a truncated one, a Xero string — becomes the generic
 * message rather than being dropped: the operator's connect attempt really did
 * fail, and silence would be worse than a vague explanation.
 *
 * Note the caller must pass `URLSearchParams.get()`'s output directly. That is
 * already percent-decoded once; decoding again would corrupt a literal `%` and
 * can throw `URIError` on a malformed escape.
 */
export function toSafeXeroOAuthCallbackMessage(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  return ALLOWED_MESSAGES.has(raw) ? raw : XERO_OAUTH_CALLBACK_GENERIC_MESSAGE;
}
