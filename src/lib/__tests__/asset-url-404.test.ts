import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";
import {
  API_ASSET_MISS_SOURCE,
  API_ASSET_NOT_FOUND_PATH,
  ASSET_MISS_SOURCE,
  ASSET_NOT_FOUND_PATH,
  ASSET_NOT_FOUND_REWRITES,
  ASSET_URL_EXTENSIONS,
  NEXT_STATIC_MISS_SOURCE,
} from "@/lib/asset-url-404";
import { isPublicWebsitePath } from "@/lib/setup-gate";
import * as assetNotFoundRoute from "@/app/asset-not-found/route";
import { config } from "../../proxy";

/**
 * The standing invariant this file exists to hold (#2404):
 *
 *   **No URL may reach a page render without the proxy having minted a CSP
 *   nonce for it.**
 *
 * Production CSP is nonce-only (`script-src 'self' 'nonce-…'`, `src/lib/csp.ts`)
 * and the nonce comes from `src/proxy.ts`, which by design does not run on
 * static-asset shapes — #2420 re-affirmed that exclusion, and `csp-proxy.test.ts`
 * asserts those shapes stay outside the matcher so a real asset never pays a
 * nonce mint. The bug was what happened on a MISS: the request fell through to
 * the `(website)/[...slug]` CMS catch-all and rendered the club's 404 document
 * anyway, unnonced and with no CSP header at all.
 *
 * `scripts/ci/check-prerendered-script-nonces.mjs` cannot see this class — it
 * reads emitted prerender HTML, and these responses render per request. So the
 * property is pinned here, at the level where it is decided: every shape is
 * covered by exactly one set of mechanisms, and a shape covered by none is the
 * bug.
 *
 * Resolved through Next's OWN routing primitives — `unstable_doesMiddlewareMatch`
 * and `getPathMatch`, the functions the framework itself uses — so this tests the
 * rules Next will actually apply rather than a hand-written restatement of them.
 * `e2e/asset-url-404.spec.ts` then measures the same shapes on the wire against
 * the running container; this suite is what fails without a stack, in the
 * ordinary `npm test` run, the moment the matcher and the rewrites stop agreeing.
 */

/** How a given URL shape is kept away from an unnonced page render. */
type Coverage =
  /** `src/proxy.ts` runs: a nonce is minted and the CSP header is set. */
  | "proxy"
  /** An `afterFiles` rewrite terminates it with an empty 404, no document. */
  | "asset-404"
  /**
   * An `afterFiles` rewrite sends it to the `/api` catch-all, which answers the
   * same JSON 404 as any other unmatched `/api` URL.
   */
  | "api-asset-404"
  /** Under `/api`: terminated as JSON by a route handler, never a document. */
  | "api-json"
  /** The image optimiser: a real handler that answers a short 400, never HTML. */
  | "image-optimiser";

const matchesNextStaticMiss = getPathMatch(NEXT_STATIC_MISS_SOURCE);
const matchesApiAssetMiss = getPathMatch(API_ASSET_MISS_SOURCE);
const matchesAssetMiss = getPathMatch(ASSET_MISS_SOURCE);

/**
 * Resolved in the SAME ORDER Next applies the rules, because the order IS the
 * mechanism: the `/api` rule has to win over the general one, and a test that
 * evaluated the rules as an unordered set would pass on a rule list whose order
 * had been swapped — the exact regression that reopens #2405's parity oracle.
 */
function rewriteCoverage(pathname: string): Coverage | null {
  if (matchesNextStaticMiss(pathname) !== false) return "asset-404";
  if (matchesApiAssetMiss(pathname) !== false) return "api-asset-404";
  if (matchesAssetMiss(pathname) !== false) return "asset-404";
  return null;
}

function coverageFor(pathname: string): Coverage[] {
  const covers: Coverage[] = [];

  if (unstable_doesProxyMatch({ config, nextConfig: {}, url: pathname })) {
    covers.push("proxy");
  }

  const rewrite = rewriteCoverage(pathname);
  if (rewrite) {
    covers.push(rewrite);
  }

  // Only counted when no rewrite claimed the URL first — a rewrite is applied
  // before the dynamic catch-all, so it decides.
  if (!rewrite && (pathname === "/api" || pathname.startsWith("/api/"))) {
    covers.push("api-json");
  }

  if (pathname === "/_next/image") {
    covers.push("image-optimiser");
  }

  return covers;
}

/**
 * Every shape measured while fixing #2404, with the mechanisms that must cover
 * it.
 *
 * Read the `asset-404` rows as "cannot render a document", NOT as "returns 404":
 * `/branding/logo.example.png` is a real file, served by the filesystem stage
 * that Next checks BEFORE any `afterFiles` rewrite, so the rule is never
 * consulted for it. That ordering is what keeps real assets working, and it is a
 * runtime fact a route table cannot show — `e2e/asset-url-404.spec.ts` asserts it
 * against the running server instead.
 */
const shapes: ReadonlyArray<readonly [string, Coverage[]]> = [
  // Ordinary pages and page-shaped misses: the proxy runs, so the 404 document
  // these render is nonced like any other page.
  ["/", ["proxy"]],
  ["/about", ["proxy"]],
  ["/definitely-missing", ["proxy"]],
  ["/wp-admin/setup-config.php", ["proxy"]],
  ["/admin/nope", ["proxy"]],
  // #2420's F3 anchors, kept honest here as well.
  ["/apiary", ["proxy"]],
  ["/api-docs", ["proxy"]],
  // The two bare prefixes #2404 anchored — the same class as F3, one namespace
  // over. Both were measured answering 404 with unnonced inline scripts and no
  // CSP header at all.
  ["/_next/staticfoo", ["proxy"]],
  ["/_next/imagemap", ["proxy"]],
  ["/_next/image/x", ["proxy"]],
  // Asset-shaped URLs: outside the matcher on purpose (a real one must not pay a
  // nonce mint), so a miss must be terminated by a rewrite rather than rendered.
  ["/foo.png", ["asset-404"]],
  ["/foo.jpg", ["asset-404"]],
  ["/foo.jpeg", ["asset-404"]],
  ["/foo.gif", ["asset-404"]],
  ["/foo.webp", ["asset-404"]],
  ["/foo.svg", ["asset-404"]],
  ["/foo.ico", ["asset-404"]],
  ["/favicon.ico", ["asset-404"]],
  ["/logo.png", ["asset-404"]],
  ["/gallery.svg", ["asset-404"]],
  ["/wp-content/uploads/x.jpg", ["asset-404"]],
  ["/branding/favicon.ico", ["asset-404"]],
  ["/branding/logo.example.png", ["asset-404"]],
  ["/_next/static/chunks/nope.js", ["asset-404"]],
  ["/_next/static", ["proxy", "asset-404"]],
  // `/api` asset shapes go to the catch-all's JSON, never the empty 404.
  ["/api/does-not-exist.png", ["api-asset-404"]],
  ["/api/chores/zzz.png", ["proxy", "api-asset-404"]],
  // Case variants of the same. The matcher is compiled case-SENSITIVELY and
  // rewrites case-INSENSITIVELY, which is exactly how `/API/x.png` fell between a
  // lookahead-based carve-out and the matcher in the first cut of this fix.
  ["/API/x.png", ["api-asset-404"]],
  ["/Api/does-not-exist.png", ["api-asset-404"]],
  ["/FOO.PNG", ["proxy", "asset-404"]],
  // Plain `/api` URLs: src/app/api/[[...unmatched]]/route.ts answers JSON.
  ["/api", ["api-json"]],
  ["/api/does-not-exist", ["api-json"]],
  ["/api/health", ["api-json"]],
  // An extension nobody listed. It renders the club's 404 page rather than an
  // empty one, and the proxy DOES run on it, so it is nonced — a wasted render,
  // never a missing nonce. This row is why the extension list is allowed to go
  // stale without becoming a security problem.
  ["/foo.avif", ["proxy"]],
  // The image optimiser answers its own short plain-text 400, never a document.
  ["/_next/image", ["image-optimiser"]],
];

describe("no URL reaches a page render without a CSP nonce (#2404)", () => {
  it.each(shapes)("%s is covered by %s", (pathname, expected) => {
    expect(
      coverageFor(pathname),
      `${pathname} must be covered by exactly these mechanisms`,
    ).toEqual(expected);
  });

  it("has no shape covered by nothing", () => {
    const uncovered = shapes.filter(
      ([pathname]) => coverageFor(pathname).length === 0,
    );

    expect(uncovered).toEqual([]);
  });
});

describe("the /api namespace keeps #2405's module-state parity", () => {
  /**
   * A path under a module-gated prefix that no handler claims must answer the
   * same bytes and the same headers whether the module is on or off, or one
   * anonymous request reads off which optional modules a club runs. With the
   * module OFF `src/proxy.ts`'s gate answers `{"error":"Not found"}` as
   * `application/json`; with it ON the request must still reach
   * `src/app/api/[[...unmatched]]/route.ts`, which answers the same thing.
   *
   * Sending an asset-shaped `/api` URL to the empty-bodied `/asset-not-found`
   * would reopen exactly that oracle: no `content-type` with the module on, a
   * JSON one with it off.
   */
  it.each([
    "/api/chores/zzz.png",
    "/api/admin/lockers/1.svg",
    "/api/images/uploaded/photo.jpg",
    "/API/chores/zzz.png",
  ])("%s is routed to the /api catch-all, not the empty 404", (pathname) => {
    expect(rewriteCoverage(pathname)).toBe("api-asset-404");
  });

  it("sends them to a path no route file claims, so the catch-all answers", async () => {
    // The parity is byte-identical BY CONSTRUCTION rather than by a second copy
    // of the body: the destination has no route of its own, so
    // `api/[[...unmatched]]` (a DYNAMIC route, resolved after afterFiles
    // rewrites) is what replies. A route file appearing here would silently
    // change the answer, so its absence is asserted rather than assumed.
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const destination = join(process.cwd(), "src/app", API_ASSET_NOT_FOUND_PATH);

    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${destination}.ts`)).toBe(false);
  });

  it.each(["/apiary-photo.png", "/api.png", "/apis/logo.png"])(
    "does not treat %s as an /api path — it is not one",
    (pathname) => {
      // `/api.png` is the sharp one: a file called `api.png` at the root, not
      // anything under the `/api` namespace, and Next's router treats it so.
      expect(rewriteCoverage(pathname)).toBe("asset-404");
    },
  );

  it("keeps the /api rule ahead of the general one", () => {
    // Order is the mechanism, not a detail: swap these and the general rule
    // swallows every /api asset shape and the parity oracle reopens.
    const sources = ASSET_NOT_FOUND_REWRITES.map((rule) => rule.source);

    expect(sources.indexOf(API_ASSET_MISS_SOURCE)).toBeLessThan(
      sources.indexOf(ASSET_MISS_SOURCE),
    );
  });
});

describe("the rewrite rules and the proxy matcher cannot drift", () => {
  /**
   * The matcher is a LITERAL string because Next extracts `export const config`
   * from the middleware source statically — it cannot evaluate an imported
   * constant or a template literal. So the extension list is written twice by
   * necessity, and this is what stops the copies disagreeing: adding `avif` to
   * the matcher and not to the rules would leave `/foo.avif` skipped by the proxy
   * AND unterminated by the rewrites, which is the hole #2404 closed.
   */
  it("lists the same extensions as the matcher", () => {
    const source = (config.matcher[0] as { source: string }).source;
    const alternation = source.match(/\\\.\(\?:([a-z|]+)\)\$/)?.[1];

    expect(
      alternation,
      "matcher must still carry an extension alternation",
    ).toBeDefined();
    expect(alternation!.split("|")).toEqual([...ASSET_URL_EXTENSIONS]);
  });

  it("keeps the matcher exclusions to the set that has been paid for", () => {
    // Pinned deliberately. Every alternative in this lookahead is a path the
    // proxy does NOT run on, so each one needs its own answer to "what stops a
    // miss here rendering an unnonced document" — recorded in the JSDoc above
    // `config` in src/proxy.ts. Changing this string means re-deciding the
    // coverage table above, not just updating the expectation.
    expect((config.matcher[0] as { source: string }).source).toBe(
      "/((?!api(?:/|$)|_next/static/|_next/image$|favicon\\.ico$|logo\\.png$|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico)$).*)",
    );
  });

  it("ships a route at the non-/api destination", async () => {
    // A rewrite to a path with no route is a 404 rendered by the CMS catch-all —
    // i.e. silently the very bug this fixes, with an extra hop. (The /api
    // destination is the opposite case, asserted above: it must have no route.)
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");

    expect(
      existsSync(
        join(process.cwd(), "src/app", ASSET_NOT_FOUND_PATH, "route.ts"),
      ),
    ).toBe(true);
  });

  it("cannot rewrite either destination into itself", () => {
    expect(rewriteCoverage(ASSET_NOT_FOUND_PATH)).toBeNull();
    expect(rewriteCoverage(API_ASSET_NOT_FOUND_PATH)).toBeNull();
  });

  it("is exempt from the pre-setup gate", () => {
    // The destination is a top-level route, so #2420's gate would otherwise
    // classify it as a public-website path and answer the "Site setup in
    // progress" screen — a 503 HTML document — for every missing image on a club
    // that has not launched yet. Exactly the document this fix exists to stop
    // sending, reintroduced through the back door.
    //
    // `setup-gate.test.ts` catches this too, by walking the app directory; it is
    // asserted here as well so the coupling fails in the suite that owns the
    // decision rather than only in someone else's.
    expect(isPublicWebsitePath(ASSET_NOT_FOUND_PATH)).toBe(false);
  });
});

/**
 * The terminal handler itself. The body being EMPTY is the whole security
 * property — with no document there is nothing a nonce-less policy has to permit
 * — so it is asserted rather than left implied, on every verb.
 */
describe("the asset 404 answers nothing at all", () => {
  const exportedMethods = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ] as const;

  function servedHandler(method: string) {
    // Resolved through Next's own verb resolver, so HEAD is tested as it is
    // SERVED (derived from GET) rather than as the file happens to spell it.
    const handlers = autoImplementMethods(
      assetNotFoundRoute,
    ) as unknown as Record<string, () => Response>;
    return handlers[method];
  }

  it.each([...exportedMethods, "HEAD"])(
    "%s returns an empty 404 with no content-type",
    async (method) => {
      const response = servedHandler(method)();

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBeNull();
      await expect(response.text()).resolves.toBe("");
    },
  );

  it("does not hand-write HEAD, so HEAD cannot drift from GET", () => {
    expect("HEAD" in assetNotFoundRoute).toBe(false);
    expect(servedHandler("HEAD")).toBe(assetNotFoundRoute.GET);
  });

  it("carries the app's own security headers and a nonce-free policy", () => {
    // Set here rather than left to Caddyfile so the property holds in dev, in the
    // E2E stack, and in any deployment that does not front the app with our
    // reverse proxy. `default-src 'none'` is tighter than the edge's
    // set-if-absent `default-src 'self'`, and needs no nonce — so unlike the
    // page-render path it cannot rot.
    const response = assetNotFoundRoute.GET();

    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });
});
