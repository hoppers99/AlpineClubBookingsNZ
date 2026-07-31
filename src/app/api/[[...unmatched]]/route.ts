import { NextResponse } from "next/server";

/**
 * Terminal 404 for any `/api` URL that no real route handler claims (#2405).
 *
 * Without it these URLs fall through to the root `(website)/[...slug]` CMS
 * catch-all, which is a PAGE: a JSON client asking for `/api/definitely-missing`
 * was handed ~23KB of `text/html` — the club's whole "page not found" screen,
 * site header, fonts and all. Measured on the staging build before this landed.
 *
 * Two things follow from being a route handler rather than a page, and both are
 * the point:
 *  • the body is JSON, so anything that parses `/api` responses gets something
 *    it can parse instead of a document; and
 *  • it never enters the `(website)` layout, so it is not affected by that
 *    layout's pre-setup branch — which is what made these URLs answer `200 OK`
 *    on a club that has not finished site-style setup (see #2405's findings).
 *
 * OPTIONAL catch-all (`[[...unmatched]]`, double brackets) on purpose. The
 * required form matches one segment or more, so bare `/api` and `/api/` still
 * fell through to the CMS page and were answered with `text/html`. The optional
 * form matches zero segments as well, which is what makes "every `/api` URL"
 * true rather than "every `/api/<something>` URL". Nothing lives at
 * `src/app/api/route.ts` or `src/app/api/page.tsx`, so there is nothing to
 * conflict with, and every real route is a longer, more specific match that
 * still wins.
 *
 * The body is byte-identical to the one `src/proxy.ts` already returns when a
 * disabled module hides an `/api` path (`getFeatureFlagBlockResponse`). Stated
 * precisely, because the point is a security property and a loose version of it
 * would be false: an `/api` path under a module-gated prefix that no handler
 * claims answers exactly the same thing whether that module is switched ON (the
 * request reaches here) or OFF (the proxy answers it) — so it cannot be used to
 * probe which optional modules an install runs. Frozen and parameterless on
 * purpose: it echoes nothing from the URL.
 *
 * That parity has to hold on the HEADERS too, which is why HEAD is deliberately
 * NOT exported. Next auto-implements HEAD from GET
 * (`next/dist/server/route-modules/app-route/helpers/auto-implement-methods.js`)
 * and strips the body on the way out, so the reply carries GET's `content-type`
 * exactly as the module gate's HEAD reply does. The hand-written HEAD this file
 * used to export returned `new NextResponse(null, …)` with NO `content-type`,
 * and that one missing header was enough to read off which optional modules a
 * club runs: one anonymous `HEAD /api/<gated-prefix>/zzz`, `content-type`
 * present means the module is off, absent means it is on.
 *
 * The remaining methods are listed because Next only answers the verbs a route
 * exports; an unlisted standard verb would 405 here and, worse, could differ
 * from the verb next to it. OPTIONS is listed for the same reason — left off,
 * Next would auto-implement it as `204` with an `Allow` header, which the
 * module gate does not do. A NON-standard verb (`PROPFIND` and friends) never
 * reaches this module: Next's app-route module answers those with a bare `400`
 * before it resolves a handler, and `src/proxy.ts`'s module gate mirrors that
 * bare 400 so the two paths stay indistinguishable there as well.
 */

export const dynamic = "force-dynamic";

function notFoundJson() {
  // Literal, not a shared constant: the body must stay byte-identical to
  // `src/proxy.ts`'s module-gate response, and an inline literal is what the
  // repo's response-shape contract test reads.
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function GET() {
  return notFoundJson();
}

export function POST() {
  return notFoundJson();
}

export function PUT() {
  return notFoundJson();
}

export function PATCH() {
  return notFoundJson();
}

export function DELETE() {
  return notFoundJson();
}

export function OPTIONS() {
  return notFoundJson();
}
