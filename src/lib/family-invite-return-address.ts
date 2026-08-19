import { getSafeInternalReturnPath } from "@/lib/internal-return-path";

/**
 * The server-side post-login return address for a family-group invitation
 * (#2827).
 *
 * ## What problem this exists to solve
 *
 * `/family-invite/[token]` used to offer the signed-out recipient a sign-in link
 * built as `buildLoginPath('/family-invite/<token>')`, so the invite token was
 * rendered into an `href` on a page that carries the club's normal chrome —
 * including admin-authored **Raw CSS**. A CSS attribute selector reads a value
 * one character at a time (`a[href^="/family-invite/9f"]`), which made that link
 * a token oracle for anyone who can edit the site's styling. That is the same
 * class as the group-join payment link and the `data-page-slug` finding closed
 * earlier on this branch, and it is described in
 * `docs/SECURITY-ATTACK-SURFACE.md` → "Admin Raw CSS on the public site".
 *
 * The sign-in link is now a plain `/login`, and the return address travels in
 * this cookie instead: **`HttpOnly`, so no CSS selector, no script and no
 * `document.cookie` read can see it**, and never rendered into the page at all.
 *
 * ## Why the cookie value is allowed to contain the token
 *
 * It has to — the return address *is* the invite address. That is acceptable
 * precisely because an `HttpOnly` cookie is invisible to the two readers this
 * fix is about (CSS selectors and page scripts) and is never part of the
 * document, the address bar or a `Referer`. It is also not a new bearer store in
 * the `docs/TOKEN_HASHING.md` sense: nothing is persisted server-side, the value
 * lives only in the recipient's own browser for
 * {@link FAMILY_INVITE_RETURN_MAX_AGE_SECONDS}, and the token it carries is
 * already held hashed-at-rest (`PartnerInviteToken.tokenHash`) exactly as before.
 *
 * ## Why the shape check is this narrow
 *
 * {@link getFamilyInviteReturnPath} refuses anything that is not literally
 * `/family-invite/<64 lowercase hex characters>`. Two properties follow, and both
 * are stronger than a general "is this a relative path" test:
 *
 *  - **Open redirect.** The value is sanitised by
 *    {@link getSafeInternalReturnPath} — the repository's existing guard, shared
 *    with `callbackUrl` — so an absolute URL, a scheme-relative `//evil.example`,
 *    a backslash or a control character can never survive. Layered on top, the
 *    pattern means even a *safe internal* path is refused unless it is an invite
 *    page, so a planted cookie cannot be used to steer a member's post-login
 *    landing anywhere else in the application.
 *  - **Cookie planting.** A cookie is attacker-writable in ways a URL parameter is
 *    not (a sibling subdomain, a stale value in a shared browser). The worst a
 *    planted value can do here is land somebody on an invite page — and the page
 *    itself still refuses to let them join, because it re-checks that the
 *    signed-in member's email matches the invited address. That check is defence
 *    in depth and is **not** made redundant by this mechanism.
 *
 * The 64-hex shape is the action-token format
 * (`ACTION_TOKEN_PATTERN` in `src/lib/action-tokens.ts`). It is duplicated here
 * rather than imported because this module is imported by `src/proxy.ts`, which
 * runs in the middleware runtime and must not pull in `node:crypto`.
 * `family-invite-return-address.test.ts` pins the two definitions together, so
 * changing the token format fails a test instead of silently disabling the
 * return address.
 */
export const FAMILY_INVITE_RETURN_COOKIE = "family-invite-return";

/**
 * Ten minutes: long enough to read the page, click "I already have an account",
 * type an email and password and clear a 2FA challenge; short enough that a
 * value nobody consumed is gone well before the browser session is.
 *
 * Accuracy does not depend on it being generous. The address is re-stamped on
 * every GET of the invite page (`src/proxy.ts`), the terminal consumer clears it
 * (`src/app/api/auth/post-login-landing/route.ts`), and an absent or expired
 * cookie degrades to the member's ordinary post-login landing rather than to an
 * error — the emailed invite link still works.
 */
export const FAMILY_INVITE_RETURN_MAX_AGE_SECONDS = 10 * 60;

/**
 * The one address shape this cookie may ever carry. Kept in step with
 * `ACTION_TOKEN_PATTERN` by `family-invite-return-address.test.ts` — see the
 * cookie constant's docblock for why it is not imported.
 */
const FAMILY_INVITE_RETURN_PATH_PATTERN = /^\/family-invite\/[a-f0-9]{64}$/;

/**
 * The safe family-invite return path in `candidate`, or null.
 *
 * Both halves matter and neither is redundant: `getSafeInternalReturnPath()`
 * rejects everything that is not a same-origin relative path (it is the guard
 * `callbackUrl` already uses), and the pattern then rejects every same-origin
 * path that is not an invite page — including one carrying a query string or a
 * fragment, which the sanitiser preserves and this cookie has no use for.
 */
export function getFamilyInviteReturnPath(
  candidate: string | null | undefined,
): string | null {
  const safePath = getSafeInternalReturnPath(candidate);

  if (!safePath) {
    return null;
  }

  return FAMILY_INVITE_RETURN_PATH_PATTERN.test(safePath) ? safePath : null;
}

/**
 * The `Set-Cookie` value, with `maxAgeSeconds: 0` expiring it.
 *
 * `HttpOnly` is the whole mechanism — the browser must send it and nothing on
 * the page may read it — which is the exact opposite of the `signed-in-hint`
 * marker in `src/lib/signed-in-hint.ts`, whose value the browser has to read.
 * `SameSite=Lax` still sends it on the top-level navigation to `/login` and on
 * the redirect back, while keeping it off cross-site subrequests. Not `Secure`
 * in development, where the app is served over plain http and a `Secure` cookie
 * would never be stored at all — the same rule, for the same reason, as the
 * marker cookie's serialiser.
 *
 * Expiry is written as an explicit past-dated overwrite carrying the same
 * attributes rather than as a delete, so a browser that stored the original
 * under `Path=/` cannot be left holding it.
 */
export function serialiseFamilyInviteReturnCookie(
  value: string,
  maxAgeSeconds: number,
): string {
  const attributes = [
    `${FAMILY_INVITE_RETURN_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (process.env.NODE_ENV === "production") {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}
