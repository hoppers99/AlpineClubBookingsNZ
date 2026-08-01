/**
 * Static-asset URLs nothing serves are answered without a document (#2404).
 *
 * **What was wrong.** `src/proxy.ts` mints the CSP nonce per request, and its
 * matcher used to skip every static-asset shape — anything ending in an image
 * extension, plus `_next/static` and `_next/image` — on the reasoning that
 * running edge middleware on the dozens of chunk and image requests a single page
 * load issues is the hottest path in the app.
 *
 * That was fine for a file that EXISTS and wrong for one that does NOT. The miss
 * fell through to the `(website)/[...slug]` CMS catch-all, which called
 * `notFound()` and rendered the club's whole "page not found" document — with no
 * nonce on any inline script, because the thing that mints nonces had been
 * skipped, and with no `Content-Security-Policy` header at all. `Caddyfile`'s
 * set-if-absent `default-src 'self'` fallback then supplied a policy carrying no
 * `'nonce-…'` source, which blocked every one of those scripts. Same end state as
 * #2356, on the URL shapes bots actually hit.
 *
 * **This module is the layer that removes the RENDER.** `afterFiles` rewrites
 * terminate the miss before the dynamic catch-all can claim it: a machine asked
 * for image bytes or JavaScript, and ~29KB of club branding was waste on both
 * sides. It also removes a render amplifier — every probe of
 * `/wp-content/uploads/x.png` used to buy a full dynamic React render, and bots
 * probe those addresses continuously.
 *
 * **The other layer is in the matcher, and it landed alongside this one.** Owner
 * decision, 1 Aug 2026 (#2404 "Option A"): the extension exclusion came out of
 * `config.matcher` as well, because removing the document only makes the missing
 * nonce harmless — it cannot put a `Content-Security-Policy` on the response, and
 * it cannot bring the URL inside the #2420 setup gate. Measured, the exclusion
 * was not even buying speed. So an asset-shaped miss now meets both layers and
 * they compose: the proxy attaches the policy, the rewrite removes the document.
 * The rules below are unchanged by that and stay load-bearing on their own — they
 * are what keeps `/_next/static/chunks/deleted.js` (still excluded, still the hot
 * path) from rendering anything, and what keeps every other probe from buying a
 * render it would otherwise still get.
 *
 * **Why `afterFiles`.** Next checks the filesystem — `public/`, `_next/static`,
 * and the non-dynamic routes — BEFORE it consults an `afterFiles` rewrite, so a
 * real asset is served exactly as it was and never touches these rules; only a
 * miss reaches them. `beforeFiles` would shadow every real asset; `fallback` runs
 * after `(website)/[...slug]` has already turned the URL into a render.
 *
 * **Case sensitivity is the trap here, and rule ORDER is how it is closed.** Next
 * compiles the middleware matcher case-SENSITIVELY and `rewrites`
 * case-INSENSITIVELY (path-to-regexp's `sensitive` defaults to false). A first cut
 * of this fix gave the asset rule a `(?!api…)` lookahead to protect #2405's
 * module-state parity, and `/API/x.png` then fell between the two: skipped by the
 * matcher (its `.png` tail, matched case-sensitively) AND skipped by the rewrite
 * (its `/api` carve-out, matched case-insensitively), so it still rendered the
 * unnonced document. There is no portable way to write a case-SENSITIVE lookahead
 * inside a case-insensitive regex, so the carve-out is an ORDERED RULE instead:
 * `/api` asset shapes are claimed AHEAD of the general rule and sent where an
 * unmatched `/api` URL already goes, and the general rule that follows needs no
 * lookahead and so has no case seam to leak through.
 *
 * Option A closed the matcher's half of that seam — `/API/x.png` runs the proxy
 * now, so a lookahead-based carve-out would no longer produce an unnonced
 * document. The ordered rule stays anyway, because the seam it closes has a
 * second consequence that Option A does not touch: a `/API/…` asset shape
 * falling into the GENERAL rule would be answered with the empty 404 while its
 * lowercase twin got JSON, which is #2405's module-state parity read off from one
 * anonymous request.
 *
 * **A rewrite is not the end of routing, and one route depends on that.** An
 * `afterFiles` rewrite carries `check: true`
 * (`next/dist/server/lib/router-utils/filesystem.js`, `buildCustomRoute`), so
 * after the destination is substituted Next runs `checkTrue()`
 * (`resolve-routes.js`) over the REWRITTEN path: an exact filesystem/app match
 * first, then every DYNAMIC route. That is why a rewrite whose destination is the
 * matched path itself is not a no-op loop — it re-enters resolution and a real
 * dynamic route can still claim the URL. `UPLOADED_IMAGE_MISS_SOURCE` uses
 * exactly that, because `src/app/api/images/uploaded/[...path]/route.ts` is a
 * REAL dynamic route whose URLs all end in an image extension. Without that
 * identity rule the `/api` rule below would swallow every admin-uploaded image
 * in the app (`src/lib/image-storage.ts`'s public URL prefix, and the
 * `Caddyfile` `/images/*` rewrite that feeds the same route) and answer it with
 * a JSON 404.
 */

/**
 * The extensions a miss is terminated on.
 *
 * These used to be the extensions `src/proxy.ts`'s matcher skipped, and the list
 * was kept byte-identical to that alternation. #2404's Option A deleted the
 * alternation, so the only copy left to stay in step with is
 * `STATIC_ASSET_EXTENSION_PATTERN` in `src/lib/setup-gate.ts` — and that coupling
 * matters MORE than the old one did: an extension terminated here but
 * unrecognised there would be classed a public-website path and answered, on a
 * club mid-setup, with the 503 holding screen. That is an HTML document on an
 * asset URL, i.e. this issue reopened through the gate. The guard in
 * `src/lib/__tests__/asset-url-404.test.ts` fails if the two drift.
 *
 * An extension MISSING from this list is a cost regression rather than a security
 * one: `/foo.avif` renders the club's 404 page, but the proxy runs on it, so it
 * is nonced and carries a policy like any other page.
 */
export const ASSET_URL_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
] as const;

const EXTENSION_ALTERNATION = ASSET_URL_EXTENSIONS.join("|");

/** Where a missing asset-shaped URL outside `/api` is rewritten to. */
export const ASSET_NOT_FOUND_PATH = "/asset-not-found";

/**
 * Where an asset-shaped `/api` URL is rewritten to.
 *
 * Deliberately a path with NO route file of its own, so
 * `src/app/api/[[...unmatched]]/route.ts` claims it — that optional catch-all is a
 * DYNAMIC route, and Next resolves dynamic routes AFTER `afterFiles` rewrites, so
 * the rewritten request lands there and is answered with the same
 * `{"error":"Not found"}` JSON as any other unmatched `/api` URL.
 *
 * The indirection is the point rather than an accident. #2405's parity property is
 * that a path under a module-gated prefix that no handler claims must answer the
 * same bytes AND the same headers whether the module is ON or OFF — with it off,
 * `src/proxy.ts`'s gate answers that JSON, and its matcher entries
 * (`/api/chores/:path*` and friends) match whatever the URL's tail looks like,
 * `.png` included. Routing these to the empty-bodied `/asset-not-found` would have
 * answered module-ON with no body and no `content-type` while module-OFF still
 * answered JSON, and one anonymous request would again read off which optional
 * modules a club runs. Pointing at the catch-all keeps the two byte-identical BY
 * CONSTRUCTION, with no second copy of the body to drift.
 */
export const API_ASSET_NOT_FOUND_PATH = "/api/unmatched-asset";

/**
 * Misses under `_next/static`. A stale browser tab asking for a chunk a deploy
 * removed is the ordinary case, and it wants JavaScript.
 *
 * `:path*` rather than `:path+` so bare `/_next/static` is covered too, for the
 * same reason `src/app/api/[[...unmatched]]/route.ts` is an optional catch-all.
 */
export const NEXT_STATIC_MISS_SOURCE = "/_next/static/:path*";

/**
 * The public URL prefix `src/lib/image-storage.ts` mints for every
 * admin-uploaded image, and the target of `Caddyfile`'s `/images/*` rewrite.
 *
 * Written out rather than imported because `next.config.ts` loads this module
 * through Next's own config loader and `image-storage.ts` pulls in `fs`/`path`
 * and reads `process.cwd()`. The copy is not left to trust: the guard in
 * `src/lib/__tests__/asset-url-404.test.ts` calls the real `imagePublicUrl()`
 * and asserts the URL it actually produces resolves to the real route.
 */
export const UPLOADED_IMAGE_URL_PREFIX = "/api/images/uploaded";

/**
 * The one route that legitimately SERVES extension-suffixed URLs, exempted from
 * termination by an IDENTITY rewrite — destination = the matched path.
 *
 * Claimed before the `/api` rule below, so `/api/images/uploaded/photo.jpg` is
 * never answered as a miss. The rewrite fires (which is the point: a URL a rule
 * claims can never reach a later rule), and because `afterFiles` rewrites carry
 * `check: true` the substituted path re-enters resolution and
 * `src/app/api/images/uploaded/[...path]/route.ts` claims it, exactly as it
 * would have with no rule present at all. A file that is missing from the
 * uploads volume still gets that route's own JSON 404 — the same body the
 * `/api` catch-all answers — so nothing here can produce a document.
 *
 * Scoped to the extension alternation, not `:path*`, so it stays symmetric with
 * the rule below and does not put a rewrite compile on `/api/images/uploaded`
 * URLs the terminating rules would never have touched.
 */
export const UPLOADED_IMAGE_MISS_SOURCE = `${UPLOADED_IMAGE_URL_PREFIX}/:path((?:.*)\\.(?:${EXTENSION_ALTERNATION}))`;

/** Identity destination for {@link UPLOADED_IMAGE_MISS_SOURCE}. */
export const UPLOADED_IMAGE_IDENTITY_DESTINATION = `${UPLOADED_IMAGE_URL_PREFIX}/:path`;

/**
 * Every OTHER asset-shaped URL under `/api`, claimed before the general rule so
 * that rule never sees them. Matched case-insensitively like every Next rewrite,
 * which is what makes `/API/x.png` and `/Api/x.png` land here too instead of
 * falling through the case seam described above.
 *
 * Deliberately NOT an identity rewrite, even though that would be the smaller
 * change. An identity rewrite over the whole `/api` namespace substitutes the
 * destination's LITERAL lowercase `/api`, so it would hand
 * `/API/admin/lockers/1.png` to the real, module-gated handler — with nothing
 * having gated it, because the module gate's route table is case-SENSITIVE
 * (`matchesPrefix` in `src/config/feature-routes.ts` is a `startsWith`, and its
 * patterns carry no `i` flag, so `/API/…` matches no rule and
 * `getRequiredFeaturesForPath()` returns nothing). Terminating at the frozen JSON
 * keeps the gate the only way in.
 *
 * Since #2404's Option A the proxy itself runs on both case forms — the matcher's
 * `api` alternative is lowercase and the extension alternative that used to catch
 * the `.png` tail is gone — so the response carries a policy either way. That is
 * an improvement and it does not weaken the argument above: running is not the
 * same as gating, and it is the gate this rule protects. Both facts are pinned in
 * `src/lib/__tests__/asset-url-404.test.ts`.
 */
export const API_ASSET_MISS_SOURCE = `/api/:path((?:.*)\\.(?:${EXTENSION_ALTERNATION}))`;

/**
 * Every other path ending in an asset extension, at any depth
 * (`/wp-content/uploads/x.png`). No lookahead: `/api` is already gone by the time
 * this rule is reached, and a rule with no exclusion has no case seam to leak
 * through.
 */
export const ASSET_MISS_SOURCE = `/:path((?:.*)\\.(?:${EXTENSION_ALTERNATION}))`;

/**
 * The `afterFiles` rewrites, in the shape `next.config.ts` hands to Next.
 *
 * ORDER IS LOAD-BEARING — Next applies the first rule that matches, so this list
 * reads most-specific first:
 *  1. `_next/static` misses;
 *  2. the uploaded-images route, exempted by identity so real images still work;
 *  3. every other `/api` asset shape, to the frozen JSON (#2405 parity);
 *  4. everything else, to the empty 404.
 * Swap 2 behind 3 and every uploaded image 404s as JSON; swap 3 behind 4 and the
 * parity oracle reopens. Both orderings are asserted in the guard.
 *
 * `_next/image` is deliberately absent: it is a REAL handler (the image
 * optimiser), so a rewrite would break optimised images rather than catch a miss.
 * It answers a bad request with its own short plain-text 400 and never renders a
 * page.
 */
export const ASSET_NOT_FOUND_REWRITES = [
  { source: NEXT_STATIC_MISS_SOURCE, destination: ASSET_NOT_FOUND_PATH },
  {
    source: UPLOADED_IMAGE_MISS_SOURCE,
    destination: UPLOADED_IMAGE_IDENTITY_DESTINATION,
  },
  { source: API_ASSET_MISS_SOURCE, destination: API_ASSET_NOT_FOUND_PATH },
  { source: ASSET_MISS_SOURCE, destination: ASSET_NOT_FOUND_PATH },
] as const;
