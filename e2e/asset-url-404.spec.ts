import { expect, test, type APIRequestContext } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";

/**
 * Static-asset URLs on the wire (#2404).
 *
 * The CSP is nonce-only and the nonce is minted per request by `src/proxy.ts`,
 * whose matcher deliberately does not run on asset shapes. A MISS on one of
 * those shapes used to fall through to the `(website)/[...slug]` CMS catch-all
 * and render the club's whole 404 document with no nonce and no CSP header at
 * all — measured on the merged #2434 build: `GET /foo.png` answered 404 with
 * ~29KB of `text/html`, 19 inline `<script>` tags, 0 of them nonced.
 *
 * The unit suite (`src/lib/__tests__/asset-url-404.test.ts`) pins the routing
 * rules; only a running server can show the two things that actually matter and
 * that a route table cannot express:
 *  • a REAL asset is still served, because Next checks the filesystem before it
 *    consults an `afterFiles` rewrite — get that ordering wrong and every image
 *    in the app 404s; and
 *  • a MISS is answered with no document, so there is no unnonced script to
 *    block in the first place.
 *
 * Anonymous on purpose: these are the addresses scanners and stale browser tabs
 * ask for, never a logged-in human.
 */

/** Every inline `<script>` in `html` that carries no non-empty `nonce`. */
function unnoncedInlineScripts(html: string) {
  const offenders: string[] = [];

  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes)) continue;
    if (/\btype\s*=\s*["']?application\/(ld\+)?json/i.test(attributes)) continue;
    if (/\bnonce\s*=\s*(?:"[^"]+"|'[^']+'|[^\s"'>]+)/i.test(attributes)) continue;
    offenders.push(match[0]);
  }

  return offenders;
}

const missingAssetUrls = [
  "/foo.png",
  "/foo.jpg",
  "/foo.svg",
  "/foo.ico",
  "/foo.webp",
  "/favicon.ico",
  "/logo.png",
  "/wp-content/uploads/x.jpg",
  "/branding/definitely-missing.png",
  // A stale browser tab asking for a chunk a deploy removed. This is the
  // ordinary real-world case, not a synthetic one.
  "/_next/static/chunks/nope.js",
];

test("a missing asset URL is answered with nothing, not the 404 document", async ({
  request,
}) => {
  for (const url of missingAssetUrls) {
    const response = await request.get(url);

    expect(response.status(), `${url} must be a hard 404`).toBe(404);

    const body = await response.text();
    expect(body, `${url} must carry no body at all`).toBe("");
    expect(
      response.headers()["content-type"],
      `${url} must not be answered with a document`,
    ).toBeUndefined();

    // The property this issue is about, stated directly rather than inferred
    // from the body being empty: nothing unnonced ships.
    expect(unnoncedInlineScripts(body), `${url} must ship no unnonced script`).toEqual(
      [],
    );

    // Set by the route itself, so it holds without the reverse proxy in front.
    expect(response.headers()["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  }
});

test("a real static asset is still served — the rewrite must not shadow the filesystem", async ({
  request,
}) => {
  // `public/branding/*` is the app's own shipped imagery (the favicon the root
  // layout points at lives in this directory). If `afterFiles` ordering were
  // wrong, or the rules were moved to `beforeFiles`, this 404s and the whole
  // site loses its images — which is the failure this test exists to catch.
  const response = await request.get("/branding/favicon.example.ico");

  expect(response.status()).toBe(200);
  expect((await response.body()).byteLength).toBeGreaterThan(0);
});

test("a real _next/static chunk is still served", async ({ page, request }) => {
  // Take the chunk URL from a real page render rather than guessing a hashed
  // filename, so this follows the build instead of pinning to it.
  await page.goto("/");
  const chunkUrl = await page.evaluate(() => {
    const script = Array.from(document.querySelectorAll("script[src]")).find(
      (element) =>
        (element as HTMLScriptElement).src.includes("/_next/static/chunks/"),
    );
    return script ? new URL((script as HTMLScriptElement).src).pathname : null;
  });

  expect(chunkUrl, "the home page must load at least one chunk").not.toBeNull();

  const response = await request.get(chunkUrl!);
  expect(response.status()).toBe(200);
  expect((await response.body()).byteLength).toBeGreaterThan(0);
});

test("page-shaped URLs just outside an excluded namespace keep their nonce", async ({
  request,
}) => {
  // `_next/static` and `_next/image` were BARE prefixes in the proxy matcher, so
  // these were skipped by it and served with no CSP header at all — ordinary
  // addresses that no framework handler claims. They are nonced pages again.
  // `/apiary` and `/api-docs` are the same class, anchored one issue earlier in
  // #2420, and are measured here so both anchors are covered by one test.
  for (const url of [
    "/_next/staticfoo",
    "/_next/imagemap",
    "/_next/image/x",
    "/apiary",
    "/api-docs",
  ]) {
    const response = await request.get(url);

    const csp = response.headers()["content-security-policy"];
    expect(csp, `${url} must carry the per-request policy`).toContain("'nonce-");
    expect(
      unnoncedInlineScripts(await response.text()),
      `${url} must have every inline script nonced`,
    ).toEqual([]);
  }
});

test("an ordinary page miss is unchanged: the club's own 404 screen, fully nonced", async ({
  request,
}) => {
  // The guard against over-reach. Nothing here may turn a human-plausible
  // mistyped address into a blank response — that stays the CMS 404 page.
  const response = await request.get("/definitely-missing");

  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("text/html");

  const body = await response.text();
  expect(body).toContain("Page Not Found");
  expect(unnoncedInlineScripts(body)).toEqual([]);
});

/**
 * The half of #2404 that a routing table cannot state: a rule written to catch
 * misses must not swallow the URLs a real route exists to SERVE.
 *
 * `src/app/api/images/uploaded/[...path]/route.ts` is the production URL for
 * every admin-uploaded image — `imagePublicUrl()` in `src/lib/image-storage.ts`
 * mints `/api/images/uploaded/…`, and `Caddyfile` rewrites `/images/*` onto the
 * same route. Every one of those URLs ends in an image extension, so the first
 * cut of this fix routed them all to the `/api` JSON 404 and every uploaded
 * picture in the app disappeared. The image is UPLOADED here rather than assumed
 * present because the uploads directory is a container volume (`image_uploads`
 * in docker-compose.yml) and the seeds put nothing in it.
 *
 * The `/images/*` shape is NOT asserted: `caddy` is behind the
 * `production-caddy` compose profile and the Playwright base URL is the app's own
 * port, so that rewrite has no edge to run at in this stack. It resolves to the
 * URL asserted below, which is the one the app actually has to serve.
 */
test.describe("an uploaded image is still served — the rewrites must not shadow it", () => {
  let admin: APIRequestContext;
  const filename = `e2e-asset-url-404-${Date.now()}.png`;
  // A 1x1 transparent PNG. Small on purpose: this measures routing, not upload.
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  test.beforeAll(async ({ playwright, baseURL }) => {
    admin = await playwright.request.newContext({
      baseURL,
      storageState: storageStatePath(E2E_ADMIN.email),
    });
  });

  test.afterAll(async () => {
    // Best effort: the volume outlives the spec, so do not leave litter behind.
    await admin
      .delete("/api/admin/image-manager/images", {
        data: { dir: "", filename },
      })
      .catch(() => undefined);
    await admin.dispose();
  });

  test("serves the uploaded bytes at its own /api/images/uploaded URL", async ({
    request,
  }) => {
    const upload = await admin.post("/api/admin/image-manager/upload", {
      multipart: {
        dir: "",
        files: { name: filename, mimeType: "image/png", buffer: pngBytes },
      },
    });

    expect(upload.status(), await upload.text()).toBe(200);
    expect((await upload.json()).results).toEqual([{ filename, ok: true }]);

    // Fetched ANONYMOUSLY, through the default `request` fixture: these URLs are
    // embedded in public website pages, so the serving path must not depend on
    // the admin session that uploaded the file.
    const served = await request.get(`/api/images/uploaded/${filename}`);

    expect(
      served.status(),
      "the uploaded image must be served, not answered as an asset miss",
    ).toBe(200);
    expect(served.headers()["content-type"]).toBe("image/png");
    expect(await served.body()).toEqual(pngBytes);

    // The failure mode this guards is specific and quiet — a JSON 404 with the
    // same body an unmatched /api URL gets — so it is ruled out by name.
    expect(served.headers()["content-type"]).not.toContain("application/json");
  });

  test("still answers a MISSING uploaded image without a document", async ({
    request,
  }) => {
    // The exemption must not turn the uploads route into a hole in #2404: a file
    // that is not there gets the route's own JSON 404, never the club's HTML.
    const response = await request.get(
      "/api/images/uploaded/definitely-not-uploaded.png",
    );

    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

test("unmatched /api URLs still answer JSON — the asset rewrite must not claim them", async ({
  request,
}) => {
  // #2405's module-state parity: a path under a gated prefix that no handler
  // claims must answer identically whether the module is on or off. Routing an
  // asset-shaped /api URL to the empty asset 404 would reopen that oracle, so
  // the ordered `/api` rewrite rule sends these to the same JSON catch-all
  // instead. The mixed-case entry is the one that matters most: rewrites are
  // compiled case-INSENSITIVELY, and an ordered rule is what stops `/API/x.png`
  // falling through the case seam a lookahead-based carve-out left open.
  for (const url of [
    "/api/does-not-exist.png",
    "/api/chores/zzz.svg",
    "/API/x.png",
  ]) {
    const response = await request.get(url);

    expect(response.status(), `${url} must be a hard 404`).toBe(404);
    expect(
      response.headers()["content-type"],
      `${url} must stay on the JSON path`,
    ).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Not found" });
  }
});
