import { NextResponse, type NextRequest } from "next/server";
import {
  getDisabledFeatureForPath,
  getRequiredFeaturesForPath,
} from "./config/feature-routes";
import type { FeatureFlags } from "./config/schema";
import { loadEffectiveModuleFlags } from "./lib/module-settings";
import {
  buildContentSecurityPolicy,
  createCspNonce,
  CSP_HEADER,
  CSP_NONCE_HEADER,
  setSecurityHeaders,
} from "./lib/csp";
import {
  REQUEST_METHOD_HEADER,
  REQUEST_PATH_HEADER,
} from "./lib/internal-return-path";
import { getPublicWebsiteNonce } from "./lib/release-nonce";
import { getSetupInProgressResponse, isPublicWebsitePath } from "./lib/setup-gate";
import {
  hasSignedInHint,
  SIGNED_IN_HINT_COOKIE,
  SIGNED_IN_HINT_MAX_AGE_SECONDS,
  SIGNED_IN_HINT_VALUE,
} from "./lib/signed-in-hint";

/**
 * Public pages a shared cache may store for anonymous visitors (#2322).
 *
 * Deliberately an ALLOW list, never a deny list: a route added later must opt
 * in on purpose rather than become cacheable the moment it lands. Excluded on
 * purpose:
 *  - every `(public)` route — all of them are token-, form-, or session-bearing
 *    (login, register, password reset, `pay/[token]`, `family-invite/[token]`…);
 *  - `/join/*` and `/contact` — public but form-bearing;
 *  - `/hut-leader-instructions` — reachable without a login, but per-assignment
 *    and PIN-gated (`?a=` from an assignment email), so it is not shared
 *    content;
 *  - the `(website)` `[...slug]` CMS catch-all — middleware cannot tell a CMS
 *    path from an application path without a database read, so it stays
 *    uncached even though it renders the same heavy layout.
 *
 * This list is about the BROWSER cache only, and #2352 did not change it. The
 * catch-all is now served from Next's own full-route ISR cache — a server-side
 * store the proxy neither reads nor advertises — so it still sends no
 * `Cache-Control` of ours while no longer paying a full render per visit. Adding
 * it here would be a separate decision about the browser, not a consequence of
 * that one.
 */
const CACHEABLE_ANONYMOUS_PATHS = new Set(["/"]);

/**
 * `private`, NOT `public`, and no `s-maxage` — a browser cache only (#2404
 * re-review).
 *
 * The directive used to be `public, max-age=60, s-maxage=60, …`, with a check
 * below meant to keep a flight (React Server Components) response out of it: a
 * flight body is different bytes under the SAME URL, so a shared cache that
 * ignores `Vary` could serve it to a browser asking for a page. **That check
 * cannot work in middleware, so the `public` half had nothing holding it.**
 * Next's middleware adapter DELETES every flight header before userland runs
 * (`next/dist/server/web/adapter.js`, `FLIGHT_HEADERS` from
 * `client/components/app-router-headers.js`: `rsc`, `next-router-state-tree`,
 * `next-router-prefetch`, `next-router-segment-prefetch`, `next-hmr-refresh`) —
 * measured through the real adapter, on both the node and edge middleware
 * runtimes, and `?_rsc=` is stripped off `nextUrl` as well. `Purpose` and
 * `Sec-Purpose` do survive, but they mark a PREFETCH, and a plain RSC
 * navigation carries neither, so no surviving signal identifies a flight
 * request. Middleware simply cannot tell the two apart.
 *
 * So the property is held by the directive itself instead: a shared cache is
 * never invited to store the response, whatever body Next goes on to produce
 * for it. `max-age` still earns the repeat-visit win from the browser, which is
 * the only benefit that was ever measured — no shared cache exists in the
 * deployment path today (Caddy runs without a cache module), so `s-maxage` was
 * storing nothing anywhere.
 *
 * **Do not restore `public`/`s-maxage` without a mechanism that can distinguish
 * a flight response, and middleware cannot be that mechanism.** #2352
 * (static/ISR public pages) is where such a mechanism would come from; the
 * pinning test is in `csp-proxy.test.ts`, which drives the real adapter.
 *
 * Survives the framework default: Next only writes its own `Cache-Control`
 * when the response does not already carry one
 * (`node_modules/next/dist/server/send-payload.js`,
 * `if (cacheControl && !res.getHeader('Cache-Control'))`). Note this holds in
 * production only — in dev, base-server overwrites it unconditionally.
 *
 * The `Vary: Cookie` set alongside it also survives: Next APPENDS its RSC vary
 * rather than replacing the header (`base-server.js:1169` and `:1174` in the
 * vendored next@16.2.11 both use `res.appendHeader('vary', ...)`), so the
 * middleware value reaches the wire next to the framework's. It still matters
 * with `private`: one browser profile can hold sessions in sequence, and the
 * anonymous render paints the header logged-out.
 *
 * The CSP nonce is no longer a reason to care either way, and the reason changed
 * with #2352. It used to be that `private` kept a per-request nonce from being
 * replayed to anyone else. On `/` — a `(website)` address — the nonce is now the
 * FIXED per-release value every visitor is served, so there is nothing left to
 * replay. `private` still earns its place for the other reason above: the
 * anonymous render paints the header signed-out.
 */
const ANONYMOUS_PAGE_CACHE_CONTROL =
  "private, max-age=60, stale-while-revalidate=300";

/**
 * next-auth v5 session cookie — plain, `__Secure-` prefixed, and the chunked
 * `.0`/`.1` variants. The authoritative pattern lives in
 * `src/lib/auth-diagnostics.ts` (`SESSION_COOKIE_NAME_PATTERN`).
 *
 * One deliberate divergence: that module excludes the legacy v4
 * `next-auth.session-token` so a years-stale cookie is not misread as an auth
 * anomaly. Here it must still suppress caching — misjudging a stale cookie as
 * "maybe authenticated" only costs a cache miss, whereas the opposite error
 * would let a shared cache store a page for someone who has a session.
 */
const SESSION_COOKIE_PATTERN =
  /^(?:__Secure-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?$/;

function normalisePathname(pathname: string) {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/** Does this request carry a next-auth session cookie of any supported shape? */
function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((cookie) => SESSION_COOKIE_PATTERN.test(cookie.name));
}

/**
 * Keeps the non-secret sign-in marker cookie (#2352 D2) in step with the observed
 * session cookie, and writes NOTHING when the two already agree.
 *
 * Scoped to GET on a non-`/api` path on purpose. A JSON client has no header to
 * correct, and answering an API call with a `Set-Cookie` it did not ask for is
 * noise a caller might reasonably treat as a session change. Restricting it also
 * keeps the header off responses whose whole contract is "indistinguishable from
 * the module being switched on" (#2405).
 *
 * `SIGNED_IN_HINT_COOKIE` never appears in the request headers passed THROUGH to
 * the app, so no server render can come to depend on it — the hint exists for the
 * browser only, which is what keeps it a display hint rather than a second,
 * weaker session.
 */
function syncSignedInHint(
  request: NextRequest,
  response: NextResponse,
  signedIn: boolean,
): void {
  if (request.method !== "GET") return;
  if (request.nextUrl.pathname.startsWith("/api/")) return;

  const hintPresent = hasSignedInHint(request.headers.get("cookie"));

  if (hintPresent === signedIn) return;

  if (signedIn) {
    response.cookies.set({
      name: SIGNED_IN_HINT_COOKIE,
      value: SIGNED_IN_HINT_VALUE,
      path: "/",
      sameSite: "lax",
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      maxAge: SIGNED_IN_HINT_MAX_AGE_SECONDS,
    });
    return;
  }

  // Expire rather than delete(): an explicit past-dated overwrite carries the
  // same attributes the value was written with, so a browser that scoped the
  // original to `/` cannot be left holding it.
  response.cookies.set({
    name: SIGNED_IN_HINT_COOKIE,
    value: "",
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  });
}

/**
 * Cache-Control for an anonymous public page GET, or null to leave the
 * framework default (`private, no-cache, no-store`) untouched.
 */
// test seam
export function getAnonymousPageCacheControl(
  request: NextRequest,
): string | null {
  if (request.method !== "GET") {
    return null;
  }

  const pathname = normalisePathname(request.nextUrl.pathname);

  if (!CACHEABLE_ANONYMOUS_PATHS.has(pathname)) {
    return null;
  }

  // There is deliberately no flight-request check here: Next's adapter strips
  // every flight header before this function can see it, so any such check
  // would be dead code that reads like a guarantee. The `private` directive
  // above is what makes a flight body harmless — see its docblock.

  return hasSessionCookie(request) ? null : ANONYMOUS_PAGE_CACHE_CONTROL;
}

/**
 * The seven verbs Next's app-route module will resolve a handler for
 * (`next/dist/server/web/http.js`'s `HTTP_METHODS`). Anything else — `PROPFIND`
 * and the rest of the WebDAV/scanner vocabulary — is rejected by
 * `AppRouteRouteModule.resolve()` with a bare `400` and no body, before any
 * userland code runs. Kept in step with the vendored next@16.2.11.
 */
const STANDARD_HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
]);

/**
 * The reply for a path a disabled module hides, or null when nothing is hidden.
 *
 * `method` matters because this response has to be INDISTINGUISHABLE from what
 * the same `/api` path answers when the module is switched ON (#2405 security
 * review). With the module on, the request reaches a real route handler — or
 * `src/app/api/[[...unmatched]]/route.ts` if no handler claims it — and Next
 * answers a non-standard verb with a bare `400` rather than running anything.
 * Answering those verbs with the JSON 404 here would have made the module state
 * readable from a single anonymous `PROPFIND /api/<gated-prefix>/zzz`: `400`
 * means on, `404` means off. Mirroring the bare 400 closes that.
 *
 * Scoped to `/api` paths on purpose. The 400 mirrors the ROUTE-HANDLER
 * contract; a page path is served by a different Next module with different
 * verb handling, so borrowing the same answer there would assert a parity that
 * has not been measured.
 *
 * Defaults to `GET` so a caller that only cares about the ordinary case (the
 * existing gate tests) reads plainly; `proxy()` always passes the real method.
 */
export function getFeatureFlagBlockResponse(
  pathname: string,
  flags: FeatureFlags,
  method: string = "GET",
): NextResponse | null {
  const disabledFeature = getDisabledFeatureForPath(pathname, flags);

  if (!disabledFeature) {
    return null;
  }

  if (!pathname.startsWith("/api/")) {
    return new NextResponse(null, { status: 404 });
  }

  return STANDARD_HTTP_METHODS.has(method)
    ? NextResponse.json({ error: "Not found" }, { status: 404 })
    : new NextResponse(null, { status: 400 });
}

async function getEffectiveModuleBlockResponse(
  pathname: string,
  method: string,
) {
  if (getRequiredFeaturesForPath(pathname).length === 0) {
    return null;
  }

  const effectiveFlags = await loadEffectiveModuleFlags();
  return getFeatureFlagBlockResponse(pathname, effectiveFlags, method);
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // #2352 D1. Every `(website)` address gets the ONE fixed nonce of this release;
  // everything else keeps a freshly minted per-request value. The predicate is
  // `isPublicWebsitePath()` — the same one the #2420 setup gate uses to decide
  // "is this the public website?" — rather than a second list, because a second
  // list is a second thing to keep in step, and its filesystem-backed
  // exhaustiveness test (`setup-gate.test.ts`) then covers this split too.
  //
  // The whole GROUP, not D1's five named pages, and the reason is structural:
  // `(website)/layout.tsx` is one shared layout, it renders the analytics
  // `<Script nonce>` for every route under it, and it can no longer read the
  // request (that read is exactly what forced a full render on every visit). So
  // the nonce it stamps has to be the same one the proxy publishes for every
  // address the layout serves — including `/hut-leader-instructions`,
  // `/join/[code]` and `/join/verify/[token]`, which stay per-request RENDERS
  // (`force-dynamic`) but share the group's policy. Splitting the layout in two
  // was the alternative and was rejected: it duplicates the shared chrome
  // permanently to buy a difference that slices 2 and 3 remove anyway.
  const publicWebsite = isPublicWebsitePath(pathname);
  const nonce = publicWebsite
    ? await getPublicWebsiteNonce()
    : createCspNonce();
  const csp = buildContentSecurityPolicy(nonce, {
    pathname,
    selfOrigin: request.nextUrl.origin,
    publicWebsite,
  });
  // NOTE: no `x-page-slug` request header any more (#2352). It existed so the two
  // public layouts could stamp `data-page-slug` on the footer, and reading it
  // meant a `headers()` call in the layout — the second of the two lines that
  // forced a full render on every public page view. The footer derives the slug
  // from `usePathname()` instead, which needs no request. Do not reintroduce a
  // request header for a value the URL already carries.

  // Ahead of the module gate on purpose (#2420). Until site setup is complete
  // the whole public website answers "not ready yet", and that outranks "this
  // module is switched off" — a 404 for a module-gated website path would
  // otherwise tell an anonymous prober which modules an unconfigured install has
  // on. For a gated PUBLIC-WEBSITE path it also means the module read never
  // happens; every other path (the admin area, the member areas, the `/api`
  // matcher entries) falls straight through to the module gate below exactly as
  // before, in both setup states. `/api/*` is never gated here — the matcher
  // drops it and `isPublicWebsitePath()` refuses it again — so
  // `api/[[...unmatched]]` keeps answering JSON 404, and the bare 400 for a
  // non-standard verb keeps matching it, whether or not setup is complete
  // (#2405).
  const setupInProgressResponse = await getSetupInProgressResponse(request);

  if (setupInProgressResponse) {
    setupInProgressResponse.headers.set(CSP_HEADER, csp);
    setSecurityHeaders(setupInProgressResponse.headers, pathname);
    return setupInProgressResponse;
  }

  const featureFlagBlockResponse = await getEffectiveModuleBlockResponse(
    request.nextUrl.pathname,
    request.method,
  );

  if (featureFlagBlockResponse) {
    featureFlagBlockResponse.headers.set(CSP_HEADER, csp);
    setSecurityHeaders(featureFlagBlockResponse.headers, pathname);
    return featureFlagBlockResponse;
  }

  const requestHeaders = new Headers(request.headers);

  requestHeaders.set(CSP_NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, csp);
  requestHeaders.set(
    REQUEST_PATH_HEADER,
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );
  requestHeaders.set(REQUEST_METHOD_HEADER, request.method);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set(CSP_HEADER, csp);
  setSecurityHeaders(response.headers, pathname);
  syncSignedInHint(request, response, hasSessionCookie(request));

  const anonymousCacheControl = getAnonymousPageCacheControl(request);

  if (anonymousCacheControl) {
    response.headers.set("Cache-Control", anonymousCacheControl);
    // Appended, not set: a shared cache must key on the cookie so a member with
    // a session is never served the stored anonymous render (which paints the
    // header logged-out). Appending leaves any Vary the framework adds for RSC
    // navigation intact.
    response.headers.append("Vary", "Cookie");
  }

  return response;
}

export default proxy;

/**
 * The root matcher entry's negative lookahead decides which requests the proxy
 * runs on at all — and therefore which requests the #2420 setup gate can answer.
 * A URL excluded here is a URL the gate never sees.
 *
 * Three of the alternatives were bare PREFIXES, and that was a bug rather than a
 * choice (#2420 review finding F3). Measured on the pre-fix matcher: `/apiary`
 * and `/api-docs` were excluded by `api`, `/logo.pngs` by `logo.png`, and
 * `/favicon.icons` by `favicon.ico` — whose unescaped dot also excluded
 * `/faviconXico`. All are ordinary website addresses. They skipped the proxy
 * entirely, so pre-setup they answered 200 instead of 503, and at all times they
 * were served with no CSP header. `api` was anchored then — it must be followed
 * by `/` or end the path — and #2404 finished the other two by deleting them
 * outright (see below): a carve-out for a file that does not exist can only cost.
 *
 * The two REMAINING bare prefixes were anchored in #2404 for the same reason F3
 * gives, one namespace over: `_next/static` also excluded `/_next/staticfoo` and
 * `_next/image` also excluded `/_next/imagemap` and `/_next/image/x`. No
 * framework handler claims any of those, so they were ordinary website addresses
 * being served with no CSP header — measured answering 404 with unnonced inline
 * `<script>` tags.
 *
 * The two anchors differ in shape, and that is the point rather than an
 * inconsistency: `_next/static` is a DIRECTORY, so only `/_next/static/…` is ever
 * served and a trailing slash is the whole exclusion; `_next/image` is a single
 * ENDPOINT taking a `?url=` query, so only the exact path is served and `$` is.
 * Each now excludes precisely what the framework serves and nothing else, and
 * `csp-proxy.test.ts` still asserts `/_next/static/chunks/main.js` stays outside.
 *
 * **The image-extension alternative was REMOVED in #2404 (owner decision,
 * 1 Aug 2026), and the two named filenames with it.** It used to read
 * `favicon\.ico$|logo\.png$|.*\.(?:png|jpg|…)$`, on the reasoning that a real
 * asset must not pay a nonce mint. Three measured facts overturned that:
 *
 *  1. **It was the reason the class existed at all.** A URL the proxy skips is a
 *     URL nothing of ours can attach a header to, and a URL the #2420 setup gate
 *     never sees. The `afterFiles` rewrites in `next.config.ts` (rules in
 *     `src/lib/asset-url-404.ts`) remove the DOCUMENT from an asset-shaped miss,
 *     which is what makes the missing nonce harmless — but
 *     only the proxy can put a `Content-Security-Policy` on the response, and
 *     only the proxy can answer 503 pre-setup. Layer, not replacement.
 *  2. **The exclusion was not buying anything.** Benchmarked on the compiled
 *     matcher, the shorter lookahead is marginally CHEAPER per request (~1.4ns),
 *     and the genuinely hot shape — the dozens of `/_next/static/…` chunk
 *     requests one page load issues — is still excluded by its own alternative.
 *     `public/` holds `branding/*` and `robots.txt` and nothing else, so the real
 *     asset requests newly running the proxy are few, and they gain `nosniff`,
 *     `X-Frame-Options` and the rest of `SECURITY_HEADERS` they did not have.
 *  3. **`favicon.ico` and `logo.png` excluded nothing whatsoever.** Neither file
 *     exists — `src/app/layout.tsx` points at `/branding/favicon.ico` — so both
 *     were dead alternatives leaving two exposed URL shapes. If either file is
 *     ever added, the filesystem serves it ahead of any rewrite and the whole
 *     cost of the proxy running on it is one nonce mint.
 *
 * So an asset-shaped miss now meets BOTH layers, and they compose rather than
 * fight: the proxy attaches the policy and the security headers, and the rewrite
 * still terminates the request at `src/app/asset-not-found/route.ts` so no
 * document is rendered. Which layer's `Content-Security-Policy` reaches the wire
 * is decided by Next and is worth knowing: `sendResponse()`
 * (`next/dist/server/send-response.js`) appends a route handler's header only
 * when the name is not already set on the outgoing response, and the router
 * server writes the middleware's headers first
 * (`server/lib/router-server.js`, "apply any response headers from routing"). The
 * proxy's per-request page policy therefore wins wherever the proxy runs, and the
 * route's tighter `default-src 'none'` remains in force for the shapes it still
 * skips — `/_next/static/chunks/deleted.js` — and as the floor if the matcher
 * ever stops covering a shape. Either way a policy ships, which is the property.
 *
 * `isPublicWebsitePath()` in `src/lib/setup-gate.ts` still refuses asset-shaped
 * paths, and no longer because it mirrors this string — it is now an independent
 * rule with its own reason, recorded there. Keep the extension list there in step
 * with `ASSET_URL_EXTENSIONS`; `src/lib/__tests__/asset-url-404.test.ts` fails if
 * they diverge.
 *
 * **There is NO prefetch exemption, and its absence is load-bearing (#2404,
 * owner decision 1 Aug 2026).** The entry used to carry a `missing:` clause that
 * skipped any request bearing `Next-Router-Prefetch` or `Purpose: prefetch`,
 * because Next's router prefetches whole route trees on hover and minting a
 * nonce for a response the user may never see is waste. Those are ordinary
 * request headers, so a bare `GET /anything` carrying `Purpose: prefetch`
 * skipped the proxy on EVERY URL and was served with no nonce, no
 * `Content-Security-Policy` and no #2420 setup gate — the same end state as the
 * asset-URL class, on any address rather than only the asset-shaped ones.
 *
 * Narrowing the exemption to a REAL flight prefetch — the pair of entries that
 * skipped only when a prefetch header and `RSC` arrived together — was tried and
 * rejected, because the matcher cannot express Next's own definition of a flight
 * request. Next flags one on `RSC: 1` EXACTLY
 * (`next/dist/server/lib/is-rsc-request.js`), while a `missing:` item with no
 * `value` treats any non-empty header as present
 * (`prepare-destination.js`'s `matchHas`). So `RSC: 2`, `RSC: 0`, or two `RSC`
 * headers that Node joins into `1, 1`, all skipped the proxy while Next went on
 * to render the full HTML document — strictly more useful to a prober than the
 * exemption itself. Pinning `value: "1"` would close that instance; deleting the
 * clause closes the class.
 *
 * The exemption also has no measured cost to defend: benchmarked on the compiled
 * matcher it was worth ~1.4ns per request, the same measurement that removed the
 * extension alternative above. And #2352 (static/ISR public pages) needs it gone
 * outright — a prefetch that skipped the proxy would put a nonce-less copy of a
 * page into the page cache, which every later visitor would then be served.
 *
 * So the proxy now runs on every request the lookahead admits, prefetch or not,
 * and no combination of request headers takes a URL outside it.
 * `csp-proxy.test.ts` pins that across the whole prefetch/`RSC` matrix.
 *
 * Because that lookahead drops the whole of `/api`, the explicit entries below
 * are the ONLY way an API path reaches the proxy — so every `/api` prefix and
 * every `/api` regex in `FEATURE_ROUTE_RULES` must be covered by an entry here,
 * or its module gate is dead code (#2435: the member-guest consent pattern had
 * none, so the `memberGuests` gate never ran in front of that endpoint). A
 * PREFIX rule gates a whole subtree, so its entry has to end in `:path*` — a
 * bare literal leaves every child gated-but-unmatched. Entries must be static
 * literals; Next parses this list at build time. `csp-proxy.test.ts` asserts
 * the two lists cannot drift apart again, probing each prefix at its bare path
 * and at a child, and each pattern once per alternation branch.
 */
export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next/static/|_next/image$).*)",
    "/api/admin/:path*",
    "/api/admin/bed-allocation/:path*",
    "/api/admin/chores/:path*",
    "/api/admin/communications/:path*",
    "/api/admin/hut-leaders/:path*",
    "/api/admin/induction-templates/:path*",
    "/api/admin/inductions/:path*",
    "/api/admin/internet-banking-settings",
    "/api/admin/lockers/:path*",
    "/api/admin/lodge/:path*",
    "/api/admin/lodges/:path*",
    "/api/admin/members/:id/xero-link",
    "/api/admin/members/:id/xero-push",
    "/api/admin/members/:id/xero-unlink",
    "/api/admin/mountain-conditions/:path*",
    "/api/admin/promo-codes/:path*",
    "/api/admin/roster/:path*",
    "/api/admin/setup/finance-report-mappings/:path*",
    "/api/admin/waitlist/:path*",
    "/api/admin/work-parties/:path*",
    "/api/admin/xero/:path*",
    "/api/address-autocomplete/:path*",
    "/api/bookings/:id/guests/:guestId/consent",
    "/api/bookings/:id/waitlist-confirm",
    "/api/admin/bookings/:id/force-confirm",
    // Events calendar (#2241): the eventsCalendar rule in
    // src/config/feature-routes.ts gates "/api/calendar", and the first matcher
    // entry above excludes every "/api/..." path, so without this entry the
    // proxy would never run on the calendar API and that half of the rule would
    // be dead.
    "/api/calendar/:path*",
    "/api/chores/:path*",
    "/api/cron/xero/:path*",
    "/api/display/:path*",
    "/api/finance/:path*",
    "/api/group-bookings/:path*",
    "/api/inductions/:path*",
    "/api/lodge/:path*",
    "/api/notices/:path*",
    "/api/promo-codes/:path*",
    "/api/skifield-conditions/:path*",
    "/api/skifield-whakapapa/:path*",
    "/api/webhooks/xero/:path*",
    "/api/work-parties/:path*",
  ],
};
