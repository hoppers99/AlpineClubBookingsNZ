/**
 * Which URLs belong to the `(website)` route group — the public website.
 *
 * Extracted from `src/lib/setup-gate.ts` in the #2352 slice-1 review so three
 * callers can share one answer without dragging the gate's database reads with
 * them. It is deliberately DEPENDENCY-FREE (no `next/server`, no Prisma, no
 * `server-only`): the proxy, the CMS catch-all render and the admin slug
 * validator all import it.
 *
 * The three questions it answers, and why they have to be the same answer:
 *  • **The #2420 setup gate** — is this an address the "Site setup in progress"
 *    503 stands in for?
 *  • **The #2352 D1 nonce split** — does this address carry the FIXED per-release
 *    script nonce, or a freshly minted per-request one?
 *  • **The CMS catch-all's territory** — may `(website)/[...slug]` serve a page
 *    here at all?
 *
 * The third is the one the slice-1 review added, and it is what makes the other
 * two safe. `(website)/[...slug]` claims every URL no other route claims, so
 * without it the catch-all's territory was WIDER than this predicate: a published
 * CMS page at `/pay` (a legal slug — `pay` was reserved nowhere) was rendered by
 * the catch-all, stored in the full-route cache with whatever per-request nonce
 * the generating request happened to carry, and then served to every later
 * visitor under a policy naming a different one. Every inline script on it would
 * be refused and the page would never hydrate. Making the catch-all refuse those
 * paths — and the admin write refuse those slugs — is what keeps
 * "stored by the catch-all" a subset of "carries the fixed nonce".
 */

/**
 * Top-level path segments that belong to a route group OTHER than `(website)`,
 * and so are never gated and never CMS territory.
 *
 * An ALLOW list would be wrong: `(website)/[...slug]` is a catch-all, so "is this
 * a public-website address?" really is "is it anything but one of these?".
 * Enumerated rather than inferred because the proxy sees only a URL — it has no
 * access to the route tree — and `setup-gate.test.ts` walks `src/app/**` and
 * fails if a new top-level route outside `(website)` is added without being
 * listed here.
 *
 * Everything here is either an operator surface or an address the operator needs
 * in order to FINISH setup: the admin area and its site-style wizard, the login
 * and password flows that get them there, the lodge/finance/authenticated member
 * areas, and the lobby display. `/api/*` is excluded by the proxy matcher itself
 * as well as here, which is what keeps `api/[[...unmatched]]/route.ts` (#2405)
 * answering JSON 404 — and the module gate's verb-by-verb parity with it —
 * identical in both setup states.
 *
 * @see setup-gate.test.ts — the filesystem check that keeps this exhaustive.
 */
// test seam
export const NON_WEBSITE_ROOT_SEGMENTS: ReadonlySet<string> = new Set([
  // (admin) — includes /admin/site-style, the wizard that ends the gate.
  "admin",
  // (authenticated)
  "book",
  "bookings",
  "calendar",
  "dashboard",
  "induction",
  "lodge-instructions",
  "nominations",
  "notices",
  "profile",
  // (public) — login and the token flows an operator may need mid-setup.
  "booking-requests",
  "change-password",
  "chores",
  "confirm-email-change",
  "family-invite",
  "forgot-password",
  "login",
  "membership-cancellation",
  "pay",
  "register",
  "reset-password",
  "school-bookings",
  "verify-email",
  // (finance)
  "finance",
  // (lodge)
  "lodge",
  // app root, outside every group
  "api",
  "display",
  // The terminal 404 asset-shaped misses are rewritten to (#2404). Not a
  // website page in any setup state: it exists to answer a machine that asked
  // for an image or a script with an empty 404 and no document.
  //
  // Two independent reasons it has to be listed, and NEITHER is "missing images
  // would get a 503" — they would not. The rewrites run in `afterFiles`, which
  // is AFTER middleware, so the gate only ever sees the ORIGINAL URL
  // (`/foo.png`), and the extension rule below refuses that shape. A rewritten
  // request never reaches this function at all. (Since #2404's Option A the
  // proxy DOES run on `/foo.png`, so the gate really is consulted for it now —
  // which is exactly why that extension rule has to stay.)
  //
  //  1. `/asset-not-found` is a REAL, directly reachable URL, and a direct
  //     request for it does run the proxy — it has no extension, so the matcher
  //     matches it. Unlisted, it would be classified as a public-website path
  //     and answered pre-setup with the "Site setup in progress" screen: a 503
  //     HTML document, from the one route whose entire purpose is to answer
  //     without a document.
  //  2. `setup-gate.test.ts` walks `src/app` and requires every top-level route
  //     segment to be classified one way or the other, so an unlisted new
  //     segment fails the suite by construction rather than by review.
  "asset-not-found",
]);

/**
 * Machine-readable addresses served from the app root or `public/` that are not
 * the visitor-facing website. `robots.txt` in particular has to keep answering:
 * a crawler that cannot read it falls back to crawling everything, which is the
 * opposite of what the holding screen is for.
 */
const NON_WEBSITE_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/robots.txt",
  "/sitemap.xml",
  "/favicon.ico",
]);

/**
 * Static-asset shapes that are never public-website pages, whatever the setup
 * state.
 *
 * **This is an INDEPENDENT rule with its own reason, and it stopped mirroring
 * `config.matcher` in #2404.** It was introduced in #2420 (review finding F3) as
 * the classifier's half of a reconciliation: the matcher skipped every
 * image-extension path so a real asset never paid a nonce mint, and the gate had
 * to agree, because claiming a path the proxy never runs on asserts a 503 that
 * can never be served. #2404's Option A then removed that exclusion from the
 * matcher, so the mirror is gone — the proxy now runs on `/gallery.svg`, the gate
 * really is consulted for it, and this rule is the only thing deciding the answer.
 *
 * The reason it must stay is simpler than the one it replaced, and stronger: **the
 * holding screen is an HTML DOCUMENT.** A request for an image or a deleted
 * script chunk must never be answered with one — that is the whole of #2404 — and
 * a club mid-setup would otherwise answer every such request with the 503 "Site
 * setup in progress" page.
 *
 * Not for the holding screen's own sake: it loads no image at all
 * (`src/lib/setup-in-progress-screen.ts` inlines its theme CSS and ships no
 * `<img>`, no `<link>` and no external anything, precisely so this constraint is
 * satisfied by needing nothing). The surface that does need `public/branding/*`
 * mid-setup is the ADMIN's site-style wizard, which an operator uses in exactly
 * the state this rule covers — `branding` is not in
 * {@link NON_WEBSITE_ROOT_SEGMENTS}, so without this rule
 * `/branding/favicon.ico` would be gated 503 underneath them.
 *
 * The list is kept in step with `ASSET_URL_EXTENSIONS` in
 * `src/lib/asset-url-404.ts` — the shapes the `afterFiles` rewrites terminate —
 * because an extension terminated there but unrecognised here is exactly the
 * gap that puts a document back on an asset URL.
 * `src/lib/__tests__/asset-url-404.test.ts` fails if the two drift apart.
 *
 * Consequence, recorded rather than hidden: pre-setup, a request for an
 * asset-shaped URL that no file backs (`/gallery.svg`) is answered by the app
 * rather than the gate — since #2404, with an empty 404 rather than a 200.
 */
const STATIC_ASSET_EXTENSION_PATTERN = /\.(?:png|jpg|jpeg|gif|webp|svg|ico)$/i;

function normalisePathname(pathname: string) {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/**
 * Does this URL resolve into the `(website)` route group — i.e. is it part of
 * the public website the holding screen stands in for?
 *
 * Case-sensitive, like Next's own routing: `/Admin/nope` is not the admin area,
 * it is an unmatched website address, and it should be gated exactly as
 * `/definitely-missing` is.
 *
 * MUST stay a subset of what `config.matcher` matches: the gate runs inside
 * `proxy()`, so claiming a path the proxy never runs on would assert a 503 that
 * can never be served. That invariant is asserted, not assumed.
 */
// test seam
export function isPublicWebsitePath(pathname: string): boolean {
  const path = normalisePathname(pathname);

  if (!path.startsWith("/")) {
    return false;
  }

  if (path === "/") {
    return true;
  }

  if (NON_WEBSITE_EXACT_PATHS.has(path)) {
    return false;
  }

  if (STATIC_ASSET_EXTENSION_PATTERN.test(path)) {
    return false;
  }

  const rootSegment = path.split("/")[1] ?? "";

  // `/_next/*` and any other framework-internal prefix. The proxy matcher
  // already drops `_next/static` and `_next/image`; this covers the rest.
  if (rootSegment.startsWith("_")) {
    return false;
  }

  return !NON_WEBSITE_ROOT_SEGMENTS.has(rootSegment);
}

/**
 * May the `(website)/[...slug]` CMS catch-all serve a page for this slug?
 *
 * Takes a SLUG (`about`, `trips/2026`), not a path, because that is what both
 * callers hold: the admin write validator and the catch-all's own loader. The
 * answer is `isPublicWebsitePath()` of the corresponding path, and the point of
 * the wrapper is the name — a reader at either call site should see the reason
 * rather than a path predicate used for something that is not a path decision.
 *
 * A `false` here is not a preference. Under full-route ISR a page served outside
 * the fixed-nonce set is a page stored with a per-request nonce, which every
 * later response then fails to name — see this module's header.
 */
export function isCmsServablePageSlug(slug: string): boolean {
  return isPublicWebsitePath(`/${slug}`);
}
