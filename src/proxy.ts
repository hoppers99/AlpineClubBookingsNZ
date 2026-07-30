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
 * `RSC` and `Next-Router-State-Tree` are the ones that actually reach here; the
 * two prefetch headers are already excluded by `config.matcher`'s `missing:`
 * clause, and are listed for symmetry so this stays correct if the matcher
 * changes.
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

export function getFeatureFlagBlockResponse(
  pathname: string,
  flags: FeatureFlags,
): NextResponse | null {
  const disabledFeature = getDisabledFeatureForPath(pathname, flags);

  if (!disabledFeature) {
    return null;
  }

  return pathname.startsWith("/api/")
    ? NextResponse.json({ error: "Not found" }, { status: 404 })
    : new NextResponse(null, { status: 404 });
}

async function getEffectiveModuleBlockResponse(pathname: string) {
  if (getRequiredFeaturesForPath(pathname).length === 0) {
    return null;
  }

  const effectiveFlags = await loadEffectiveModuleFlags();
  return getFeatureFlagBlockResponse(pathname, effectiveFlags);
}

export async function proxy(request: NextRequest) {
  const nonce = createCspNonce();
  const pathname = request.nextUrl.pathname;
  const csp = buildContentSecurityPolicy(nonce, {
    pathname,
    selfOrigin: request.nextUrl.origin,
  });
  const pageSlug = pathname === "/" ? "home" : pathname.replace(/^\//, "");
  const featureFlagBlockResponse = await getEffectiveModuleBlockResponse(
    request.nextUrl.pathname,
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

export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|logo.png|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
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
