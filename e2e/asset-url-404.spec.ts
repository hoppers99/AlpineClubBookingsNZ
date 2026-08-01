import { expect, test, type APIRequestContext } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";

/**
 * Static-asset URLs on the wire (#2404).
 *
 * The CSP is nonce-only and the nonce is minted per request by `src/proxy.ts`,
 * whose matcher used to skip every asset shape. A MISS on one of those shapes
 * fell through to the `(website)/[...slug]` CMS catch-all and rendered the club's
 * whole 404 document with no nonce and no CSP header at all — measured on the
 * merged #2434 build: `GET /foo.png` answered 404 with ~29KB of `text/html`,
 * 19 inline `<script>` tags, 0 of them nonced.
 *
 * Two layers close that, and both are measured here: `afterFiles` rewrites remove
 * the document, and (#2404 Option A) the matcher no longer skips image
 * extensions, so the proxy runs on those URLs and a policy is attached to
 * whatever answers.
 *
 * The unit suite (`src/lib/__tests__/asset-url-404.test.ts`) pins the routing
 * rules; only a running server can show the things that actually matter and that
 * a route table cannot express:
 *  • a REAL asset is still served, because Next checks the filesystem before it
 *    consults an `afterFiles` rewrite — get that ordering wrong and every image
 *    in the app 404s — and it is still served now that middleware runs on it;
 *  • a MISS is answered with no document, so there is no unnonced script to
 *    block in the first place; and
 *  • a policy header actually arrives on the wire in both cases, which is the
 *    half of the fix a routing table cannot show at all.
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

/** The policy `src/app/asset-not-found/route.ts` sets on its own responses. */
const TERMINAL_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * `/_next/static` is the one namespace above that the proxy matcher still skips,
 * so it is the one URL whose policy can only have come from the terminal route.
 */
const PROXY_SKIPPED_URL = "/_next/static/chunks/nope.js";

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

    // A policy always ships, and it comes from the app rather than the edge, so
    // this holds without the reverse proxy in front. WHICH policy depends on the
    // layer that answered, and both are correct for an empty body:
    //  • `src/proxy.ts` runs on image-extension URLs since #2404's Option A and
    //    writes its per-request page policy first. Next appends a route
    //    handler's header only when the name is not already set on the outgoing
    //    response (`next/dist/server/send-response.js`), so the proxy's nonced
    //    policy is what reaches the wire for those.
    //  • `/_next/static/…` is still outside the matcher, so the terminal route's
    //    own `default-src 'none'` is what ships there. That case is asserted
    //    exactly, below the loop, so the route's headers stay pinned.
    const csp = response.headers()["content-security-policy"];

    expect(csp, `${url} must carry a policy from the app`).toBeTruthy();
    expect(
      csp === TERMINAL_CSP || csp.includes("'nonce-"),
      `${url} must carry either the terminal policy or a nonced page policy, got: ${csp}`,
    ).toBe(true);
    expect(csp, `${url} must not be framable`).toContain(
      "frame-ancestors 'none'",
    );
    // Identical in both layers, so these do not depend on which one answered.
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  }

  // The exact pin, on the one shape the proxy cannot have touched.
  const skipped = await request.get(PROXY_SKIPPED_URL);
  expect(skipped.headers()["content-security-policy"]).toBe(TERMINAL_CSP);
});

test("a real static asset is still served — the rewrite must not shadow the filesystem", async ({
  request,
}) => {
  // `public/branding/*` is the app's own shipped imagery (the favicon the root
  // layout points at lives in this directory). If `afterFiles` ordering were
  // wrong, or the rules were moved to `beforeFiles`, this 404s and the whole
  // site loses its images — which is the failure this test exists to catch.
  //
  // Since #2404's Option A the proxy also RUNS on this URL, so this is now the
  // measurement of that too: middleware must not disturb the bytes Next serves
  // from `public/`, and the response gains the app's security headers, which it
  // did not carry before.
  const response = await request.get("/branding/favicon.example.ico");

  expect(response.status()).toBe(200);
  expect((await response.body()).byteLength).toBeGreaterThan(0);
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["content-security-policy"]).toContain("'nonce-");
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
  // asset-shaped /api URL anywhere at all would reopen that oracle — to the
  // empty asset 404 on the BODY, and to any other destination on the HEADERS,
  // because Next stamps `x-nextjs-rewritten-path` on an RSC request whenever a
  // rewrite's destination differs from the request path, and with the module off
  // no rewrite runs. So the ordered `/api` rule claims these (keeping the
  // general rule off them) and hands them straight back to the same JSON
  // catch-all any other unmatched `/api` URL reaches.
  for (const url of [
    "/api/does-not-exist.png",
    "/api/chores/zzz.svg",
    "/api/admin/lockers/zzz.png",
  ]) {
    const response = await request.get(url);

    expect(response.status(), `${url} must be a hard 404`).toBe(404);
    expect(
      response.headers()["content-type"],
      `${url} must stay on the JSON path`,
    ).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(
      response.headers()["x-nextjs-rewritten-path"],
      `${url} must not advertise that a rewrite ran — that header is the module-state oracle`,
    ).toBeUndefined();
  }
});

test("a mixed-case /API asset shape renders the club's nonced 404, not the JSON", async ({
  request,
}) => {
  // The recorded consequence of the `/api` rule being a case-PRESERVING
  // identity. Rewrites compile case-insensitively, so `/API/x.png` is claimed by
  // that rule and never terminated as a miss; the destination is the rule's own
  // capture, so it is handed back spelled exactly as it arrived. Next's route
  // table is case-SENSITIVE, so no `/api` route claims it and the CMS catch-all
  // renders the club's 404 page.
  //
  // Pinned because the alternative — substituting a literal lowercase `/api` —
  // would hand `/API/admin/lockers/1.png` to the real, module-gated handler with
  // the gate never having run, the gate's own route table being case-sensitive
  // too. This is the assertion that fails if that literal ever comes back.
  //
  // The proxy runs on it, so the page is nonced and carries a policy: a wasted
  // render, never a missing nonce.
  const response = await request.get("/API/x.png");

  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("text/html");

  const body = await response.text();
  expect(body).toContain("Page Not Found");
  expect(unnoncedInlineScripts(body)).toEqual([]);
  expect(response.headers()["content-security-policy"]).toContain("'nonce-");
});

test("a mixed-case uploaded-images URL does not reach the real handler", async ({
  request,
}) => {
  // The same property on the one `/api` route that really serves image bytes.
  // `/API/images/uploaded/…` must NOT be folded onto it: that would give every
  // uploaded image an unauthenticated case-insensitive alias with its own cache
  // key, and would pre-bypass any gate later put on that prefix.
  const response = await request.get("/API/images/uploaded/anything.jpg");

  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).not.toContain("image/");
});
