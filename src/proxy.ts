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
import { getSetupInProgressResponse } from "./lib/setup-gate";

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
 */
const CACHEABLE_ANONYMOUS_PATHS = new Set(["/"]);

/**
 * Both `max-age` and `s-maxage` on purpose: no shared cache was found in the
 * deployment path (Caddy runs without a cache module), so an `s-maxage`-only
 * value would be stored by nothing today. `max-age` earns the repeat-visit win
 * from the browser now, `s-maxage` is correct the moment a CDN is put in front.
 * `Vary: Cookie` keeps both honest.
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
 * middleware value reaches the wire next to the framework's.
 *
 * Known, bounded trade-off: the cached body carries the PER-REQUEST CSP nonce,
 * so under a future shared cache/CDN `s-maxage` replays one visitor's nonce to
 * every anonymous visitor for up to 60s. That grants a third party nothing (a
 * nonce is not a secret and cannot be used without injecting markup into our own
 * response), but it does mean the nonce is not unique-per-response while a shared
 * cache is serving — never treat it as a CSRF token or session secret. Revisit
 * this trade-off if a CDN is put in front.
 */
const ANONYMOUS_PAGE_CACHE_CONTROL =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

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

/**
 * Headers that mark a React Server Components navigation rather than a plain
 * document request (#2322). A flight response has a different body under the
 * SAME URL, so caching it beside the HTML risks a shared cache that ignores
 * `Vary` serving flight bytes to a browser asking for a page.
 *
 * All four can reach here. Since #2404 the matcher only skips a prefetch that
 * also carries `RSC` — a genuine flight prefetch — so a request carrying
 * `Next-Router-Prefetch` or `Purpose: prefetch` and nothing else now runs the
 * proxy, and this list is what keeps such a request out of the anonymous page
 * cache rather than merely documenting the matcher.
 */
const RSC_REQUEST_HEADERS = [
  "RSC",
  "Next-Router-State-Tree",
  "Next-Router-Prefetch",
  "Next-Router-Segment-Prefetch",
];

function normalisePathname(pathname: string) {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
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

  // Only plain document requests. On stable Next builds the RSC-header
  // validation is off, so a crafted `RSC: 1` GET would otherwise be handed a
  // cacheable flight body under the HTML's cache key.
  if (RSC_REQUEST_HEADERS.some((header) => request.headers.has(header))) {
    return null;
  }

  const hasSessionCookie = request.cookies
    .getAll()
    .some((cookie) => SESSION_COOKIE_PATTERN.test(cookie.name));

  return hasSessionCookie ? null : ANONYMOUS_PAGE_CACHE_CONTROL;
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
  const nonce = createCspNonce();
  const pathname = request.nextUrl.pathname;
  const csp = buildContentSecurityPolicy(nonce, {
    pathname,
    selfOrigin: request.nextUrl.origin,
  });
  const pageSlug = pathname === "/" ? "home" : pathname.replace(/^\//, "");

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
  requestHeaders.set("x-page-slug", pageSlug);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set(CSP_HEADER, csp);
  setSecurityHeaders(response.headers, pathname);

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
 * The first matcher entry's negative lookahead decides which requests the proxy
 * runs on at all — and therefore which requests the #2420 setup gate can answer.
 * A URL excluded here is a URL the gate never sees.
 *
 * Three of the alternatives were bare PREFIXES, and that was a bug rather than a
 * choice (#2420 review finding F3). Measured on the pre-fix matcher: `/apiary`
 * and `/api-docs` were excluded by `api`, `/logo.pngs` by `logo.png`, and
 * `/favicon.icons` by `favicon.ico` — whose unescaped dot also excluded
 * `/faviconXico`. All are ordinary website addresses. They skipped the proxy
 * entirely, so pre-setup they answered 200 instead of 503, and at all times they
 * were served with no CSP header. Anchored now: `api` must be followed by `/`
 * or end the path, and the two filenames must end it.
 *
 * The image-extension alternative is deliberately left as a whole-path suffix —
 * those are `public/` asset shapes and running the proxy on them would mint a
 * nonce per image. `isPublicWebsitePath()` is aligned to agree, and
 * `csp-proxy.test.ts` asserts the two definitions cannot drift apart again.
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
 * What no anchor here can fix is a MISS inside a namespace that stays excluded on
 * purpose: `/foo.png` and `/_next/static/chunks/deleted.js` skip the proxy
 * correctly — a real asset must not pay a nonce mint — and used to fall through
 * to the CMS catch-all and render the club's 404 document with no nonce and no
 * policy. That is closed one layer down, by the `afterFiles` rewrites in
 * `next.config.ts` (see `src/lib/asset-url-404.ts`), which answer those misses
 * with no document at all, so the absent nonce stops mattering rather than being
 * worked around. Keep the two in step: an extension added to the alternation
 * above must be added there too, and `src/lib/__tests__/asset-url-404.test.ts`
 * fails if they diverge.
 *
 * **Why the same source appears twice (#2404).** Matcher entries are OR-ed — the
 * proxy runs if ANY entry matches — so the pair below reads as one rule: run
 * unless the request is a real flight prefetch. The prefetch exemption exists
 * because Next's router prefetches whole route trees on hover and minting a
 * nonce for a response the user may never see is waste. But `missing:` on its
 * own made that exemption depend on a header ANYONE can set: a bare
 * `GET /anything` carrying `Purpose: prefetch` skipped the proxy on EVERY URL,
 * and so was served with no nonce, no `Content-Security-Policy` and no #2420
 * setup gate — the same end state as the asset-URL class, reachable on any
 * address rather than only the asset-shaped ones.
 *
 * A genuine prefetch is never bare: Next's app router sends `RSC` alongside
 * `Next-Router-Prefetch`. So entry one runs when NO prefetch header is present,
 * and entry two runs when NO `RSC` header is present. Their union skips the proxy
 * only when a prefetch header and `RSC` arrive TOGETHER, which is exactly the
 * flight prefetch the exemption was for; a header-only probe now pays the nonce
 * mint and meets the setup gate like any other document request. Ordinary RSC
 * navigations (an `RSC` header with no prefetch header) still match entry one, so
 * nothing about them changes. The cost is one extra regex evaluation on prefetch
 * traffic only — every other request matches entry one first.
 *
 * The source string is repeated LITERALLY because Next extracts `export const
 * config` from the middleware source statically and cannot evaluate a shared
 * constant. `csp-proxy.test.ts` pins both copies and asserts they are identical.
 */
export const config = {
  matcher: [
    {
      source:
        "/((?!api(?:/|$)|_next/static/|_next/image$|favicon\\.ico$|logo\\.png$|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
    {
      source:
        "/((?!api(?:/|$)|_next/static/|_next/image$|favicon\\.ico$|logo\\.png$|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico)$).*)",
      missing: [{ type: "header", key: "RSC" }],
    },
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
    "/api/bookings/:id/waitlist-confirm",
    "/api/admin/bookings/:id/force-confirm",
    "/api/chores/:path*",
    "/api/cron/xero",
    "/api/display/:path*",
    "/api/finance/:path*",
    "/api/group-bookings/:path*",
    "/api/inductions/:path*",
    "/api/lodge/:path*",
    "/api/notices/:path*",
    "/api/promo-codes/:path*",
    "/api/skifield-conditions/:path*",
    "/api/skifield-whakapapa/:path*",
    "/api/webhooks/xero",
    "/api/work-parties/:path*",
  ],
};
