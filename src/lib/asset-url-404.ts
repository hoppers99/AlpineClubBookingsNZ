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
 * **A rewrite is not the end of routing, and the `/api` rules depend on that.**
 * An `afterFiles` rewrite carries `check: true`
 * (`next/dist/server/lib/router-utils/filesystem.js`, `buildCustomRoute`), so
 * after the destination is substituted Next runs `checkTrue()`
 * (`resolve-routes.js`) over the REWRITTEN path: an exact filesystem/app match
 * first, then every DYNAMIC route. A rewrite whose destination is the matched
 * path itself is therefore not a no-op loop and not a diversion either — it
 * hands the request back to resolution exactly where it started, and the route
 * that would have claimed the URL still claims it.
 *
 * **`/api` is claimed by an IDENTITY rewrite, and that is a security decision
 * rather than a tidiness one.** Both `/api` rules below hand the path straight
 * back, so the only thing they do is claim the URL before the general rule can
 * terminate it. Two properties depend on that:
 *
 *  1. **#2405's module-state parity survives on the HEADERS as well as the
 *     bytes.** A path under a module-gated prefix that no handler claims must
 *     answer identically whether the module is ON or OFF. With it off,
 *     `src/proxy.ts`'s gate answers the JSON 404 from middleware and routing
 *     stops there, so no rewrite runs. With it on, the request continues — and
 *     `resolve-routes.js` sets `x-nextjs-rewritten-path` on an RSC request
 *     whenever a rewrite's destination DIFFERS from the request path. A
 *     terminating `/api` rule therefore added a response header in one module
 *     state and not the other, and one anonymous
 *     `curl -H 'RSC: 1' /api/<gated>/zzz.png` read the flag off. An identity
 *     destination cannot: the paths are equal, so the header is never set and
 *     the request lands on `api/[[...unmatched]]` with the same bytes the gate
 *     would have sent.
 *  2. **`src/app/api/images/uploaded/[...path]/route.ts` keeps serving.** It is a
 *     REAL dynamic route whose URLs all end in an image extension
 *     (`src/lib/image-storage.ts`'s public URL prefix, and the `Caddyfile`
 *     `/images/*` rewrite that feeds the same route). Handing the path back is
 *     what lets `checkTrue()` resolve it onto that route.
 *
 * **Case sensitivity is the trap here, and CAPTURING the whole path is how it is
 * closed.** Next compiles the middleware matcher case-SENSITIVELY and `rewrites`
 * case-INSENSITIVELY (path-to-regexp's `sensitive` defaults to false, and
 * `next.config.ts` sets no `experimental.caseSensitiveRoutes`), so every rule
 * here also matches `/API/…` and `/Api/…`. A destination written with a literal
 * `/api/` prefix would substitute that LITERAL LOWERCASE spelling, which is not
 * an identity at all: it would rewrite `/API/admin/lockers/1.png` onto the real,
 * module-gated handler with nothing having gated it, because the module gate's
 * route table is case-SENSITIVE (`matchesPrefix` in
 * `src/config/feature-routes.ts` is a `startsWith` and its patterns carry no `i`
 * flag). Each rule therefore captures the ENTIRE path, prefix included, in one
 * `:path` parameter and substitutes that capture — so the destination is the
 * request's own spelling, byte for byte, whatever case it arrived in.
 *
 * The consequence for an odd-cased `/API/x.png` is recorded rather than hidden:
 * handed back, it matches no `/api` route (Next's own route table is
 * case-sensitive) and the `(website)/[...slug]` catch-all renders the club's 404
 * page for it. That is a wasted render, not a missing nonce — since Option A the
 * proxy runs on it, so it is nonced and carries a policy — and it is the same
 * outcome `/foo.avif` already gets from an unlisted extension.
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
 * The destination shared by both `/api` rules: the path the rule matched, given
 * straight back.
 *
 * `:path` is the rule's own single capture, which spans the WHOLE path including
 * the `/api` prefix — see the case-sensitivity note in this module's header. A
 * destination that spelled any part of the path as a literal would substitute
 * that literal's case and stop being an identity for `/API/…`.
 */
export const IDENTITY_DESTINATION = "/:path";

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
 * The same prefix as a path-to-regexp PATTERN fragment: no leading slash,
 * because the rule below supplies the one slash the capture starts after.
 */
const UPLOADED_IMAGE_URL_PATTERN = UPLOADED_IMAGE_URL_PREFIX.slice(1);

/**
 * The one route that legitimately SERVES extension-suffixed URLs, declared
 * exempt from termination in its own right.
 *
 * Claimed before the `/api` rule below, so the exemption holds however that rule
 * is written: if the `/api` destination is ever made terminating again — the
 * change #2405's parity pressure keeps inviting — every admin-uploaded image in
 * the app would 404 as JSON without this line, which is exactly what the first
 * cut of #2404 did.
 *
 * Scoped to the extension alternation, not `:path*`, so it stays symmetric with
 * the rule below and does not put a rewrite compile on `/api/images/uploaded`
 * URLs the terminating rules would never have touched. The `:path` capture spans
 * the prefix as well as the tail so the destination reproduces the request's own
 * spelling: the prefix appears inside the PATTERN, where case-insensitive
 * matching makes it accept `/API/…`, and never in the destination, where it
 * would impose lowercase.
 */
export const UPLOADED_IMAGE_MISS_SOURCE = `/:path(${UPLOADED_IMAGE_URL_PATTERN}/(?:.*)\\.(?:${EXTENSION_ALTERNATION}))`;

/**
 * Every OTHER asset-shaped URL under `/api`, claimed before the general rule so
 * that rule never sees them. Matched case-insensitively like every Next rewrite,
 * which is what makes `/API/x.png` and `/Api/x.png` land here too rather than
 * falling into the general rule and being terminated while their lowercase twins
 * were not.
 *
 * Claiming is all this rule does: the destination is the captured path, so the
 * request goes back to resolution untouched and `api/[[...unmatched]]` answers
 * the same `{"error":"Not found"}` JSON it answers for `/api/does-not-exist`.
 * That equality is what #2405's parity needs, and the identity is what keeps it
 * true of the response HEADERS too — see this module's header.
 */
export const API_ASSET_MISS_SOURCE = `/:path(api/(?:.*)\\.(?:${EXTENSION_ALTERNATION}))`;

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
 *  1. `_next/static` misses, to the empty 404;
 *  2. the uploaded-images route, handed back so real images still work;
 *  3. every other `/api` asset shape, handed back so `api/[[...unmatched]]`
 *     answers it (#2405 parity, bytes and headers);
 *  4. everything else, to the empty 404.
 * Move 3 behind 4 and the parity oracle reopens; move 2 behind 3 and the
 * uploaded-images exemption starts depending on rule 3's destination instead of
 * being declared. Both orderings are asserted in the guard.
 *
 * `_next/image` is deliberately absent: it is a REAL handler (the image
 * optimiser), so a rewrite would break optimised images rather than catch a miss.
 * It answers a bad request with its own short plain-text 400 and never renders a
 * page.
 */
export const ASSET_NOT_FOUND_REWRITES = [
  { source: NEXT_STATIC_MISS_SOURCE, destination: ASSET_NOT_FOUND_PATH },
  { source: UPLOADED_IMAGE_MISS_SOURCE, destination: IDENTITY_DESTINATION },
  { source: API_ASSET_MISS_SOURCE, destination: IDENTITY_DESTINATION },
  { source: ASSET_MISS_SOURCE, destination: ASSET_NOT_FOUND_PATH },
] as const;
