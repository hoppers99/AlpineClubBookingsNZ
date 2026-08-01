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
 * **NO RULE HERE MAY MATCH AN `/api` URL, and that is a security constraint
 * rather than a tidiness one.** The general rule below carries a leading
 * `(?!api/)` lookahead, and there is no `/api` rule of any kind. Two properties
 * depend on that:
 *
 *  1. **#2405's module-state parity survives on the HEADERS as well as the
 *     bytes.** A path under a module-gated prefix that no handler claims must
 *     answer identically whether the module is ON or OFF. With it off,
 *     `src/proxy.ts`'s gate answers the JSON 404 from middleware and routing
 *     stops there, so no rewrite runs at all. With it on the request continues
 *     into the rewrite stage — and `resolve-routes.js` stamps TWO independent
 *     headers on an RSC request there, not one:
 *     `x-nextjs-rewritten-path` when the destination PATHNAME differs, and
 *     `x-nextjs-rewritten-query` when the destination SEARCH differs. A
 *     destination has no way to reproduce the request's own query string
 *     (`prepareDestination()` sets `parsedDestination.search = ''` for a
 *     query-less destination), so ANY rule matching an `/api` URL — identity
 *     included — ships `x-nextjs-rewritten-query` the moment the prober appends
 *     `?x=1`, and that header is present with the module on and absent with it
 *     off. Measured with Next's own `getPathMatch()`/`prepareDestination()`
 *     under `filesystem.js`'s exact compile options. Matching nothing under
 *     `/api` is the only form that closes both headers, and it also restores
 *     the pre-#2404 behaviour exactly: on `main` no rewrite layer exists, so no
 *     `/api` URL could carry either header in either state.
 *  2. **`src/app/api/images/uploaded/[...path]/route.ts` keeps serving.** It is a
 *     REAL dynamic route whose URLs all end in an image extension
 *     (`src/lib/image-storage.ts`'s public URL prefix, and the `Caddyfile`
 *     `/images/*` rewrite that feeds the same route). Under the lookahead no
 *     rule claims those URLs, so routing reaches that handler untouched. This
 *     is not hypothetical: the first cut of #2404 terminated every asset-shaped
 *     `/api` URL and 404'd every admin-uploaded image in the club.
 *
 * **Why a lookahead is safe here now, when an earlier cut of #2404 rejected
 * one.** That cut (commit 721bf02c7) argued a lookahead was itself a hole,
 * because Next compiles the proxy matcher case-SENSITIVELY and `rewrites`
 * case-INSENSITIVELY (path-to-regexp's `sensitive` defaults to false, and
 * `next.config.ts` sets no `experimental.caseSensitiveRoutes`), so `/API/x.png`
 * was skipped by BOTH and still rendered an unnonced document. Option A removed
 * the premise: the matcher no longer excludes asset extensions, so the proxy
 * runs on `/API/x.png` and it is nonced and policy-carrying like any other page.
 * The lookahead compiles with the same `i` flag as the rest of the rule, so it
 * excludes `/API/`, `/Api/` and `/api/` symmetrically — no case seam, and no
 * dependence on rule ORDER to keep a real route reachable.
 *
 * The consequence for an odd-cased `/API/x.png` is recorded rather than hidden:
 * no rule claims it, it matches no `/api` route (Next's own route table is
 * case-sensitive) and the `(website)/[...slug]` catch-all renders the club's 404
 * page for it. That is a wasted render, not a missing nonce — since Option A the
 * proxy runs on it, so it is nonced and carries a policy — and it is the same
 * outcome `/foo.avif` already gets from an unlisted extension.
 *
 * **A rewrite is not the end of routing.** An `afterFiles` rewrite carries
 * `check: true` (`next/dist/server/lib/router-utils/filesystem.js`,
 * `buildCustomRoute`), so after the destination is substituted Next runs
 * `checkTrue()` (`resolve-routes.js`) over the REWRITTEN path: an exact
 * filesystem/app match first, then every DYNAMIC route. That is what lets
 * `/asset-not-found` resolve onto its own route file.
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
 * No rule uses it — the `/api` lookahead below covers this prefix along with the
 * rest of the namespace. It is declared here because it is the sharpest thing
 * the lookahead protects, and it is what the guard in
 * `src/lib/__tests__/asset-url-404.test.ts` drives its assertion from: that
 * guard calls the real `imagePublicUrl()` and requires the URL it actually mints
 * to reach the real route untouched. Written out rather than imported because
 * `next.config.ts` loads this module through Next's own config loader and
 * `image-storage.ts` pulls in `fs`/`path` and reads `process.cwd()`.
 */
export const UPLOADED_IMAGE_URL_PREFIX = "/api/images/uploaded";

/**
 * The lookahead that keeps the general rule off the whole `/api` namespace.
 *
 * Written without a leading slash because the capture below starts AFTER the
 * one slash the source supplies, so the text the lookahead sees for
 * `/api/chores/zzz.png` is `api/chores/zzz.png`.
 *
 * The trailing slash is the anchor and it is deliberate: `/api.png` is a file
 * called `api.png` at the root and `/apiary-photo.png`, `/apis/logo.png` and
 * `/nested/api/x.png` are ordinary addresses, so all four must still be
 * terminated. Only a real `/api/…` URL is excluded.
 *
 * Compiled with the same `i` flag as the rest of the rule, so `/API/`, `/Api/`
 * and `/api/` are excluded symmetrically — see this module's header for why
 * that is now the right shape and why an earlier cut of #2404 rejected it.
 */
const API_NAMESPACE_LOOKAHEAD = "(?!api/)";

/**
 * Every path ending in an asset extension, at any depth
 * (`/wp-content/uploads/x.png`), except anything under `/api`.
 *
 * This is the ONLY rule that terminates by extension, and the lookahead is what
 * keeps #2405's module-state parity intact on the response headers as well as
 * the body: a rule that matched an `/api` URL would stamp
 * `x-nextjs-rewritten-query` on any RSC probe carrying a query string, with the
 * module on and not with it off. See this module's header.
 */
export const ASSET_MISS_SOURCE = `/:path(${API_NAMESPACE_LOOKAHEAD}(?:.*)\\.(?:${EXTENSION_ALTERNATION}))`;

/**
 * The `afterFiles` rewrites, in the shape `next.config.ts` hands to Next.
 *
 *  1. `_next/static` misses, to the empty 404;
 *  2. everything else that is asset-shaped and outside `/api`, to the empty 404.
 *
 * Neither rule can claim an `/api` URL, so nothing under `/api` is rewritten at
 * all and its routing is byte-identical to a build with no rewrite layer.
 * Order between these two is not load-bearing (their sources are disjoint —
 * `_next/static/…` chunks are `.js`, not an asset extension); the guard in
 * `src/lib/__tests__/asset-url-404.test.ts` resolves them in shipped order
 * anyway so a future rule cannot be inserted where order would start to matter.
 *
 * `_next/image` is deliberately absent: it is a REAL handler (the image
 * optimiser), so a rewrite would break optimised images rather than catch a miss.
 * It answers a bad request with its own short plain-text 400 and never renders a
 * page.
 */
export const ASSET_NOT_FOUND_REWRITES = [
  { source: NEXT_STATIC_MISS_SOURCE, destination: ASSET_NOT_FOUND_PATH },
  { source: ASSET_MISS_SOURCE, destination: ASSET_NOT_FOUND_PATH },
] as const;
