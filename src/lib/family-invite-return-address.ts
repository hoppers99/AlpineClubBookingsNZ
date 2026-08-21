import { getSafeInternalReturnPath } from "@/lib/internal-return-path";

/**
 * The server-side post-login return address for a family-group invitation
 * (#2827), bound to the tab that opened the invitation (#2974).
 *
 * ## What problem this exists to solve, stated accurately
 *
 * `/family-invite/[token]` used to offer the recipient a sign-in link built as
 * `buildLoginPath('/family-invite/<token>')`, so the invite token was rendered
 * into an `href` and then travelled in the visitor's address bar, their browser
 * history, and any `Referer` the next hop was shown. The sign-in link carries no
 * token now and the address travels here instead, so none of those three
 * carries it.
 *
 * **It is worth being exact about what this page did NOT expose, because the
 * first cut of this fix recorded the opposite as security history and a review
 * caught it (20 Aug 2026).** This is a `(public)` route, and
 * `src/app/(public)/layout.tsx` injects `theme.appCss` —
 * `buildClubThemeAppCss()`, which by design **excludes** admin-authored Raw CSS.
 * Only `buildClubThemeCss()` appends `rawCss`, and its output reaches a page
 * document in exactly three places: `src/components/website/website-chrome.tsx`
 * (the `(website)` and `(website-dynamic)` groups), the lodge display screen and
 * the setup-in-progress screen. So no admin CSS selector could read this page's
 * `href` at all; the `a[href^="/family-invite/9f"]` oracle that IS live next door
 * on `(website-dynamic)` — where #2827 closed the group-join payment link — was
 * never live here. What this rework removed is the URL/history/`Referer`
 * exposure, plus the standing hazard that moving this group under the shared
 * chrome (as #2818 did to `(website-dynamic)`) would have made the CSS oracle
 * real without anyone revisiting the link. See
 * `docs/SECURITY-ATTACK-SURFACE.md` → "Admin Raw CSS on the public site".
 *
 * The address is **`HttpOnly`**, so no CSS selector, no script and no
 * `document.cookie` read can see it, and it is never rendered into the page.
 *
 * ## Why the cookie value is allowed to contain the token
 *
 * It has to — the return address *is* the invite address. That is acceptable
 * precisely because an `HttpOnly` cookie is invisible to the page's readers and
 * is never part of the document, the address bar or a `Referer`. It is also not a
 * new bearer store in the `docs/TOKEN_HASHING.md` sense: nothing is persisted
 * server-side, the value lives only in the recipient's own browser for
 * {@link FAMILY_INVITE_RETURN_MAX_AGE_SECONDS}, and the token it carries is
 * already held hashed-at-rest (`PartnerInviteToken.tokenHash`) exactly as before.
 *
 * ## Its whole life, in three conditions
 *
 * The first two live in `syncFamilyInviteReturnAddress()` (`src/proxy.ts`) and
 * both came out of the #2827 review; the third is #2974:
 *
 *  - **Written only on a signed-out, top-level document navigation to the invite
 *    page** (`Sec-Fetch-Dest: document`). Without that condition a cross-site
 *    `<img src>` could plant a victim's post-login landing with no interaction —
 *    `SameSite=Lax` governs whether a cookie is SENT cross-site, never whether a
 *    cross-site response may STORE one.
 *  - **Retired by the signed-in GET of that same page.** All four sign-in flows
 *    terminate there, which is what makes "cleared on use" true for the Google
 *    and 2FA-detour flows as well; their server components cannot write a cookie,
 *    so the first cut left the address alive for its full ten minutes after use.
 *  - **Honoured only for the TAB that opened the invitation** — the subject of
 *    the next section, and what closes the last residual #2827 left open.
 *
 * ## Tab scoping: what it closes, and how (#2974)
 *
 * A cookie is per-BROWSER where the `callbackUrl` it replaced was per-tab. #2827
 * shipped with that as an accepted, bounded residual: on a shared lodge or kiosk
 * browser, somebody who opened an invitation and walked away *without signing in*
 * handed the next person to sign in that landing — disclosing the invited email
 * address and the family-group name. (Not an account takeover: the invite page
 * re-checks that the signed-in member's email matches the invited address, and
 * still refuses the join. That check is unchanged and stays as defence in depth.)
 *
 * The fix is a **tokenless nonce**, minted per navigation:
 *
 *  1. `src/proxy.ts` mints {@link createFamilyInviteReturnNonce} on the same
 *     signed-out document GET that writes the cookie, stores it IN the cookie
 *     ({@link buildFamilyInviteReturnCookieValue}) and hands the render the same
 *     value in the {@link FAMILY_INVITE_RETURN_NONCE_HEADER} request header —
 *     the mechanism `REQUEST_PATH_HEADER` and the CSP nonce already use. A
 *     server component may not set a cookie during render, so the proxy is the
 *     only place both halves can be minted together.
 *  2. The invite page renders its sign-in affordance as
 *     {@link buildFamilyInviteLoginPath}, an ordinary anchor to
 *     `/login?inviteReturn=<nonce>`.
 *  3. Every post-login landing site passes the nonce it was given, alongside the
 *     raw cookie value, to `resolvePostLoginLandingPath()`, which honours the
 *     address only when {@link matchFamilyInviteReturnCookie} says the two agree.
 *
 * A sign-in started in any other tab — a fresh `/login`, a bookmark, the next
 * person sitting down at the kiosk — presents no nonce, so the address is not
 * honoured and they land where they normally would. **That is the security
 * property, and it is what `post-login-landing.test.ts` and the login/2FA suites
 * assert.**
 *
 * ### Three things about the nonce that are deliberate
 *
 *  - **It is not derived from the token, and it is not a credential.** It is 128
 *    bits from `crypto.randomUUID()` and means nothing on its own: presenting it
 *    without the `HttpOnly` cookie from the same browser yields nothing at all.
 *    That is why rendering it into an `href` does not reintroduce the class #2827
 *    closed — there is no value in it for a CSS attribute oracle to read out, and
 *    no value in it for a `Referer` to leak. `family-invite-login-link.test.tsx`
 *    pins that the *token* still appears in no attribute.
 *  - **`docs/SECURITY-ATTACK-SURFACE.md` sketched a CONSTANT flag** ("that is a
 *    constant, not a secret, so it is safe to render"). A constant is guessable,
 *    and the acceptance criterion is that a sign-in in a *different tab* does not
 *    land on the invitation — which a constant anybody can type into `/login?…`
 *    does not give you. A per-navigation nonce costs one header and one cookie
 *    field more and gives the property outright, so this took the stronger option.
 *  - **It rotates on every signed-out document GET of the invite page**, so a
 *    second tab on the same invitation invalidates the first tab's link. That
 *    fails CLOSED — the stale tab degrades to the member's ordinary landing — and
 *    the invite page's own copy already tells the recipient to return to the link
 *    once their login is active.
 *
 * ### What tab scoping costs, stated plainly
 *
 * A **magic-link** sign-in started from the invitation no longer returns to it.
 * The emailed link opens in whatever tab the mail client gives it, carrying no
 * nonce, so the address is not honoured — by design, since a nonce mailed to an
 * inbox is not a tab binding. The recipient lands on their normal home and
 * follows the invite link again, which is exactly what the page's copy tells them
 * to do. The password and Google flows, and both 2FA detours, all return to the
 * invitation as before.
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
 *  - **Cookie planting, and what actually bounds it.** The shape check means a
 *    planted value can only ever land somebody on an invite page. The obvious
 *    next sentence — "and the page refuses to let them join unless the signed-in
 *    member's email matches the invited address" — is TRUE but does **not**
 *    discharge the case that matters, and the first cut wrongly leaned on it: any
 *    member may invite an arbitrary address to their own family group, so an
 *    attacker can invite the victim's OWN email and the match then succeeds.
 *    What bounds it is the write condition above (a planted value now needs a
 *    visible top-level navigation to the club's own invite page, which achieves
 *    no more than emailing the victim the link) together with the fact that
 *    joining still takes a deliberate click on a page that names the inviter and
 *    the group. Since #2974 a planted cookie also needs its nonce to reach the
 *    tab that signs in, which a plant cannot arrange without the victim visibly
 *    loading the invite page and clicking its own sign-in link. The email check
 *    remains load-bearing against a FORWARDED link, which is the case it was
 *    written for.
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
 * The query parameter that carries the tab-binding nonce along the sign-in
 * journey (#2974): `/login?inviteReturn=<nonce>`, and from there into the 2FA
 * detour hops, the Google `callbackUrl` and the landing route's query.
 *
 * Deliberately NOT `callbackUrl`. That name is the explicit-deep-link channel,
 * it outranks this address in `resolvePostLoginLandingPath()`, and putting the
 * invite path in it is precisely what #2827 removed. This parameter never carries
 * a path — only the nonce — so the token cannot travel in it even by mistake.
 */
export const FAMILY_INVITE_RETURN_PARAM = "inviteReturn";

/**
 * Request header the proxy uses to hand the freshly-minted nonce to the invite
 * page's render (#2974).
 *
 * It exists because the two halves of the binding are minted in different
 * runtimes: only middleware can write the cookie, only the render can put the
 * nonce in an anchor, and the render cannot read a `Set-Cookie` the same response
 * is still carrying. Same mechanism as `REQUEST_PATH_HEADER` and the CSP nonce —
 * `NextResponse.next({ request: { headers } })`.
 *
 * **The proxy deletes any inbound copy before setting its own**, so a client that
 * sends this header cannot reach the render with it. That is belt-and-braces
 * rather than a hole being closed: a forged nonce simply would not match the
 * cookie.
 */
export const FAMILY_INVITE_RETURN_NONCE_HEADER = "x-family-invite-return-nonce";

/**
 * Two minutes, and **#2974 re-examined this and kept it.**
 *
 * #2827 shortened the life from ten minutes to two, as a mitigation for the
 * shared-browser disclosure that tab scoping has now closed outright. The
 * question that left behind was whether to give the ten minutes back. Measured
 * against the journey that actually consumes the cookie, two is comfortable and
 * ten buys nothing:
 *
 *  - The address is consumed at the **first** authenticated page load after
 *    sign-in — `/api/auth/post-login-landing` for the password flow, the `/login`
 *    self-heal for Google, and the GET of `/login/verify` or `/login/enroll` for
 *    the 2FA detour. Entering a 2FA code does **not** extend the window: those
 *    pages resolve the landing during render and hand it to the panel as a prop,
 *    so the cookie has already been read before the recipient goes looking for
 *    their emailed code. The window covers "load `/login`, type an email and a
 *    password, submit" and nothing longer.
 *  - What is left for the window to bound is the one same-browser case tab
 *    scoping does not reach: a second person using the FIRST person's own tab.
 *    That discloses nothing new — the invitation is on the screen in front of
 *    them — but a short life is still the cheaper side of the trade.
 *
 * **On the provenance of the two-minute figure.** Earlier revisions of this file
 * and of `docs/SECURITY-ATTACK-SURFACE.md` credited it to "an owner decision, 19
 * Aug 2026". There is no such comment on #2827 or on PR #2970 — every comment on
 * both was posted by the automation account — so that citation pointed at
 * nothing. The owner did make the call; it was made in session and never written
 * down as a dated comment, so this says so rather than dating it to a record that
 * does not exist.
 *
 * Accuracy does not depend on the window being generous. An absent or expired
 * cookie degrades to the member's ordinary post-login landing rather than to an
 * error — the emailed invite link still works.
 */
export const FAMILY_INVITE_RETURN_MAX_AGE_SECONDS = 2 * 60;

/**
 * The one address shape this cookie may ever carry. Kept in step with
 * `ACTION_TOKEN_PATTERN` by `family-invite-return-address.test.ts` — see the
 * cookie constant's docblock for why it is not imported.
 */
const FAMILY_INVITE_RETURN_PATH_PATTERN = /^\/family-invite\/[a-f0-9]{64}$/;

/**
 * The tab-binding nonce's shape: 32 lowercase hex characters, which is
 * `crypto.randomUUID()` with its dashes removed — 122 bits of randomness.
 *
 * Anchored, and applied to BOTH the value read out of the cookie and the value
 * presented in the query string, so neither side can smuggle a separator, a path
 * or a control character into the comparison.
 */
const FAMILY_INVITE_RETURN_NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Separates the nonce from the path inside the cookie value. */
const FAMILY_INVITE_RETURN_COOKIE_SEPARATOR = ".";

/**
 * A fresh tab-binding nonce (#2974).
 *
 * `crypto.randomUUID()` is the Web Crypto global, available in the middleware
 * runtime — the same reason `createCspNonce()` in `src/lib/csp.ts` uses it, and
 * the reason this module still may not reach for `node:crypto`.
 */
export function createFamilyInviteReturnNonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * The well-formed nonce in `candidate`, or null.
 *
 * Applied to every presented value before it is compared, so a caller cannot
 * hand `matchFamilyInviteReturnCookie()` an empty string, an array element or a
 * regex-special value and have it agree with a malformed cookie.
 */
export function getFamilyInviteReturnNonce(
  candidate: string | string[] | null | undefined,
): string | null {
  const value = Array.isArray(candidate) ? candidate[0] : candidate;

  return typeof value === "string" &&
    FAMILY_INVITE_RETURN_NONCE_PATTERN.test(value)
    ? value
    : null;
}

/**
 * The safe family-invite return path in `candidate`, or null.
 *
 * Two layers, and it is worth being exact about which one is load-bearing today,
 * because a docblock that overstates a guard is how the guard stops being
 * checked. **The anchored pattern is the binding control**: nothing that is not
 * literally `/family-invite/<64 lowercase hex>` survives it, which already
 * excludes every absolute URL, scheme-relative `//evil.example`, backslash,
 * control character, query string and fragment. Mutation-measured, 20 Aug 2026:
 * removing `getSafeInternalReturnPath()` from this function fails **no** test,
 * while weakening the pattern to a substring test fails cases in the pure
 * module, the resolver and the proxy.
 *
 * `getSafeInternalReturnPath()` is kept anyway, and deliberately: it is the
 * guard `callbackUrl` already uses, so a future change that loosens this pattern
 * — to admit a second invite shape, say — cannot turn this function into an open
 * redirect on the way. It is defence in depth, not the thing standing between a
 * planted cookie and `https://evil.example`. Do not remove it, and do not
 * weaken the pattern on the strength of it being there.
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
 * The cookie value for a nonce/path pair, or null when either is malformed
 * (#2974).
 *
 * Returning null rather than a best-effort string is what keeps a defective
 * caller from writing a cookie no consumption site can ever match — the proxy
 * skips the write instead, and the visitor degrades to their ordinary landing.
 */
export function buildFamilyInviteReturnCookieValue(
  nonce: string,
  returnPath: string,
): string | null {
  const safeNonce = getFamilyInviteReturnNonce(nonce);
  const safePath = getFamilyInviteReturnPath(returnPath);

  if (!safeNonce || !safePath) {
    return null;
  }

  return `${safeNonce}${FAMILY_INVITE_RETURN_COOKIE_SEPARATOR}${safePath}`;
}

/**
 * The `{ nonce, path }` a cookie value carries, or null.
 *
 * Both halves are re-validated by their own anchored guard, so this never
 * returns a pair that a consumption site would then have to sanitise again. A
 * value in the pre-#2974 format — a bare path with no nonce — has no separator
 * before a 32-hex prefix and is therefore refused, which is the correct
 * behaviour across a deploy: an in-flight visitor holding an old cookie degrades
 * to their ordinary landing for the two minutes it survives, and the emailed
 * invite link still works.
 */
export function parseFamilyInviteReturnCookie(
  value: string | null | undefined,
): { nonce: string; path: string } | null {
  if (typeof value !== "string") {
    return null;
  }

  const separator = value.indexOf(FAMILY_INVITE_RETURN_COOKIE_SEPARATOR);

  if (separator < 0) {
    return null;
  }

  const nonce = getFamilyInviteReturnNonce(value.slice(0, separator));
  const path = getFamilyInviteReturnPath(value.slice(separator + 1));

  if (!nonce || !path) {
    return null;
  }

  return { nonce, path };
}

/**
 * Compare two already-shape-validated nonces without an early exit.
 *
 * A remote timing oracle on a 128-bit value that lives for two minutes is not a
 * realistic attack, and the nonce is not a credential in any case — it is worth
 * nothing without the `HttpOnly` cookie from the same browser. This is five
 * lines that remove the argument entirely rather than a control anything rests
 * on.
 */
function noncesMatch(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }

  return difference === 0;
}

/**
 * The return path this cookie authorises for the tab presenting
 * `presentedNonce`, or null (#2974).
 *
 * **This is the whole tab binding**, and it is deliberately the only way to turn
 * a cookie value into a landing path: `resolvePostLoginLandingPath()` calls it
 * rather than accepting a pre-resolved path from its caller, so no consumption
 * site can honour the address without having been given a nonce. A site that
 * forgets to thread the nonce through fails closed — the member lands where they
 * normally would — instead of silently restoring the browser-scoped behaviour
 * #2974 removed.
 */
export function matchFamilyInviteReturnCookie(
  cookieValue: string | null | undefined,
  presentedNonce: string | string[] | null | undefined,
): string | null {
  const parsed = parseFamilyInviteReturnCookie(cookieValue);
  const nonce = getFamilyInviteReturnNonce(presentedNonce);

  if (!parsed || !nonce) {
    return null;
  }

  return noncesMatch(parsed.nonce, nonce) ? parsed.path : null;
}

/**
 * The invite page's sign-in address: `/login?inviteReturn=<nonce>`, or a plain
 * `/login` when there is no usable nonce (#2974).
 *
 * Shared by the invite page's anchor and the login form's Google button, which
 * has to send the same nonce back through the provider round trip because
 * `/login`'s authenticated self-heal is the only post-auth seam that flow has.
 * A plain `/login` is always a valid answer: the address is simply not honoured,
 * and the recipient lands where they normally would.
 */
export function buildFamilyInviteLoginPath(
  nonce: string | null | undefined,
): string {
  const safeNonce = getFamilyInviteReturnNonce(nonce);

  return safeNonce
    ? `/login?${FAMILY_INVITE_RETURN_PARAM}=${safeNonce}`
    : "/login";
}

/**
 * `?inviteReturn=<nonce>` for appending to a login-flow hop, or an empty string.
 *
 * Used by the 2FA detour hops, which already build a `URLSearchParams` for the
 * explicit `callbackUrl`; this keeps the nonce's parameter name in one place
 * rather than spelled out at each hop.
 */
export function appendFamilyInviteReturnParam(
  params: URLSearchParams,
  nonce: string | null | undefined,
): void {
  const safeNonce = getFamilyInviteReturnNonce(nonce);

  if (safeNonce) {
    params.set(FAMILY_INVITE_RETURN_PARAM, safeNonce);
  }
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
