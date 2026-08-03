/**
 * The non-secret "someone is signed in" marker cookie (#2352, owner decision D2,
 * 31 Jul 2026).
 *
 * ## What it is for
 *
 * A full-route ISR page is ONE stored copy served to everyone, so the public
 * header cannot be rendered from the session any more. This cookie is the display
 * hint that lets the header correct itself in the browser instead.
 *
 * ## What it is NOT
 *
 * It is **not authentication** and nothing may ever treat it as such. It carries
 * one bit — the literal string `"1"` — and no name, no email, no role, no
 * identifier and no token. Forging it changes exactly three things, all of them
 * link text or link targets: the desktop CTA, the same CTA in the mobile drawer,
 * and the Book Now destination. Every page behind those links is still guarded
 * server-side by `requireAuth`/`requireAdmin`, so a forged hint buys a visitor a
 * link to a page that will refuse them.
 *
 * ## Why it is derived in the proxy rather than set on sign-in
 *
 * `src/proxy.ts` sets and clears it from the OBSERVED presence of a next-auth
 * session cookie on the request it is already inspecting. That makes it
 * self-healing: a session that expires, a sign-out through any route, a cleared
 * cookie jar, or a cookie the auth callbacks never knew about all converge on the
 * next request, because the hint is derived from a fact rather than published by
 * an event. An event-driven cookie would need a matching clear on every exit path
 * and would drift the first time one was missed.
 *
 * Deliberately NOT `HttpOnly` — the browser has to read it, which is the whole
 * point — and deliberately not `Secure` in development, where the app is served
 * over plain http and a `Secure` cookie would never be stored.
 */

export const SIGNED_IN_HINT_COOKIE = "signed-in-hint";

/** The only value this cookie is ever set to. */
export const SIGNED_IN_HINT_VALUE = "1";

/**
 * Long enough that a member returning in a new browser session sees the member
 * header on their first page rather than after the proxy has re-synced. Accuracy
 * does not depend on it: any request without a session cookie clears the hint, so
 * a stale value survives exactly one request.
 */
export const SIGNED_IN_HINT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Does this `Cookie` header / `document.cookie` string carry the hint?
 *
 * Written as a parser rather than a regex over the whole string so a cookie
 * merely NAMED `x-signed-in-hint`, or a value that happens to contain
 * `signed-in-hint=1`, cannot satisfy it. Exact name, exact value.
 */
export function hasSignedInHint(cookies: string | null | undefined): boolean {
  if (!cookies) return false;

  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;

    const name = pair.slice(0, separator).trim();
    if (name !== SIGNED_IN_HINT_COOKIE) continue;

    return pair.slice(separator + 1).trim() === SIGNED_IN_HINT_VALUE;
  }

  return false;
}
