import { getSafeInternalReturnPath } from "@/lib/internal-return-path";

/**
 * The server-side post-login return address for a family-group invitation
 * (#2827).
 *
 * ## What problem this exists to solve, stated accurately
 *
 * `/family-invite/[token]` used to offer the recipient a sign-in link built as
 * `buildLoginPath('/family-invite/<token>')`, so the invite token was rendered
 * into an `href` and then travelled in the visitor's address bar, their browser
 * history, and any `Referer` the next hop was shown. The sign-in link is now a
 * plain `/login` and the address travels here instead, so none of those three
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
 * ## Its whole life, in two conditions
 *
 * Both live in `syncFamilyInviteReturnAddress()` (`src/proxy.ts`), and both came
 * out of the same review:
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
 *
 * **Stated limit, and it is a property of cookies rather than of this code.** A
 * cookie is per-BROWSER where the `callbackUrl` it replaces was per-tab, so on a
 * shared browser somebody who opens an invitation and leaves without signing in
 * hands the next ten minutes' sign-in that landing. What is disclosed is the
 * invited email address and the group name; the page's email re-check still refuses
 * the join. The retire above closes the version of this that mattered — where the
 * first visitor signed in, and their live token ended up in the second person's
 * address bar. Closing the remainder means binding the address to the tab that
 * asked for it, with a tokenless flag on the sign-in link threaded through all four
 * resolution sites and both 2FA detour hops; `docs/SECURITY-ATTACK-SURFACE.md`
 * records why that is a deliberate follow-up rather than part of this fix.
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
 *    the group. The email check remains load-bearing against a FORWARDED link,
 *    which is the case it was written for.
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
 * Accuracy does not depend on it being generous. The address is written on a
 * signed-out navigation to the invite page and retired by the signed-in GET of it
 * (both in `syncFamilyInviteReturnAddress()`, `src/proxy.ts`);
 * `src/app/api/auth/post-login-landing/route.ts` clears it as well, for the one
 * case that never reaches the page at all. An absent or expired cookie degrades
 * to the member's ordinary post-login landing rather than to an error — the
 * emailed invite link still works.
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
