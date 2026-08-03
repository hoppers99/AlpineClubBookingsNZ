import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { adapter } from "next/dist/server/web/adapter";
import {
  unstable_doesMiddlewareMatch as unstable_doesProxyMatch,
} from "next/experimental/testing/server";
import {
  buildContentSecurityPolicy,
  CSP_HEADER,
  CSP_NONCE_HEADER,
  CSP_REPORT_ONLY_HEADER,
  SECURITY_HEADERS,
  setSecurityHeaders,
} from "@/lib/csp";
import { REQUEST_PATH_HEADER } from "@/lib/internal-return-path";
import { getPublicWebsiteNonce } from "@/lib/release-nonce";
import { isFixedNonceWebsitePath } from "@/lib/public-website-paths";
import { isPublicWebsitePath } from "@/lib/setup-gate";
import {
  SIGNED_IN_HINT_COOKIE,
  SIGNED_IN_HINT_VALUE,
} from "@/lib/signed-in-hint";
import { FEATURE_ROUTE_RULES } from "@/config/feature-routes";
import { MODULE_KEYS } from "@/config/modules";
import proxy, {
  config,
  getAnonymousPageCacheControl,
  getFeatureFlagBlockResponse,
} from "../../proxy";
import type { FeatureFlags } from "@/config/schema";

// #2420: the proxy now short-circuits every public-website URL with a 503 until
// site setup is complete, and with no database it would resolve "incomplete" and
// never reach the header work these cases are about. Every case here describes a
// configured, live site, so the gate's single input is pinned complete. The
// gate's own behaviour in BOTH setup states is covered by setup-gate.test.ts.
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: async () => ({ isComplete: true, css: "" }),
}));

// #2352 D1: the public website's script nonce is derived from the release
// identifier baked into the image. Pinned here so the website-path cases below
// assert a genuinely FIXED value rather than the per-process fallback — which is
// also stable inside one test process, and would therefore have passed for the
// wrong reason.
process.env.RELEASE_ID = "csp-proxy-test-release-identifier";

const allFeaturesOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

function directive(policy: string, name: string) {
  const match = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));

  expect(match).toBeDefined();
  return match as string;
}

function nonceFromScriptSrc(policy: string) {
  return directive(policy, "script-src").match(/'nonce-([^']+)'/)?.[1];
}

function expectStrictScriptSrc(policy: string) {
  const scriptSrc = directive(policy, "script-src");

  expect(scriptSrc).toContain("'self'");
  expect(scriptSrc).toContain("https://js.stripe.com");
  expect(scriptSrc).toContain("https://www.googletagmanager.com");
  expect(scriptSrc).not.toContain("https://api-nz.addysolutions.com");
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(nonceFromScriptSrc(policy)).toMatch(/^[A-Za-z0-9+/=]+$/);
}

/**
 * The public website's script-src (#2352 D1): Stripe dropped, and — the half that
 * is easy to forget — everything else exactly as strict as before. `unsafe-inline`
 * in particular was the option the owner REJECTED, so its absence here is the trade
 * being kept to its terms.
 *
 * This is about the SOURCE LIST and says nothing about which nonce the policy
 * names. Since the 3 Aug narrowing the two travel separately: every public-website
 * address gets this tightened list, while only the five approved routes get the
 * fixed per-release nonce.
 */
function expectPublicWebsiteScriptSrc(policy: string) {
  const scriptSrc = directive(policy, "script-src");

  expect(scriptSrc).toContain("'self'");
  expect(scriptSrc).not.toContain("https://js.stripe.com");
  // Google Tag Manager stays: the analytics module loads gtag from it on exactly
  // these pages when an admin has switched analytics on.
  expect(scriptSrc).toContain("https://www.googletagmanager.com");
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(nonceFromScriptSrc(policy)).toMatch(/^[A-Za-z0-9+/=]+$/);
}

describe("CSP policy", () => {
  it("builds a script-src with a nonce and without unsafe-inline", () => {
    const policy = buildContentSecurityPolicy("unit-test-nonce");

    expect(directive(policy, "script-src")).toContain(
      "'nonce-unit-test-nonce'"
    );
    expect(directive(policy, "script-src")).not.toContain("'unsafe-inline'");
    expect(directive(policy, "style-src")).toContain("'unsafe-inline'");
    expect(directive(policy, "connect-src")).toContain(
      "https://www.google-analytics.com",
    );
    expect(directive(policy, "connect-src")).toContain(
      "https://*.google-analytics.com",
    );
    expect(directive(policy, "img-src")).toContain(
      "https://www.google-analytics.com",
    );
    // The member-photo crop UI (epic #171) previews the selected file by loading
    // its object URL into an <img>, so the global img-src must allow blob:.
    expect(directive(policy, "img-src")).toContain("blob:");
    expect(directive(policy, "worker-src")).toBe("worker-src 'self' blob:");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  // Issue #161 (ADR-003 residual): admin-authored display HTML/CSS can embed an
  // <img>, and the global img-src otherwise allows any https host — tighten
  // img-src to 'self' data: on /display and the sandboxed preview host only.
  it("tightens img-src to 'self' data: on /display and the sandboxed preview host", () => {
    const displayPolicy = buildContentSecurityPolicy("unit-test-nonce", {
      pathname: "/display",
    });
    const previewHostPolicy = buildContentSecurityPolicy("unit-test-nonce", {
      pathname: "/admin/display/preview",
    });

    expect(directive(displayPolicy, "img-src")).toBe("img-src 'self' data:");
    expect(directive(previewHostPolicy, "img-src")).toBe(
      "img-src 'self' data:",
    );
    // The other /display-only relaxations (frame-ancestors, frame-src) are
    // untouched by this change.
    expect(directive(displayPolicy, "frame-ancestors")).toBe(
      "frame-ancestors 'self'",
    );
    expect(directive(previewHostPolicy, "frame-src")).toContain("'self'");
  });

  // Issue #2246: the Visual builder frames /display for its Live preview, so it
  // needs frame-src 'self' too — but it is a full admin page, not a sandboxed
  // display document, so it must NOT inherit the #161 tightened img-src.
  it("grants frame-src 'self' to the builder while keeping its normal img-src", () => {
    const builderPolicy = buildContentSecurityPolicy("unit-test-nonce", {
      pathname: "/admin/display/builder",
    });

    expect(directive(builderPolicy, "frame-src")).toContain("'self'");
    // The admin chrome around the builder still loads blob: (member-photo crop,
    // epic #171) and https: imagery.
    expect(directive(builderPolicy, "img-src")).toBe(
      "img-src 'self' data: blob: https: https://www.google-analytics.com https://*.google-analytics.com",
    );
    // Only /display itself may be framed by others.
    expect(directive(builderPolicy, "frame-ancestors")).toBe(
      "frame-ancestors 'none'",
    );
  });

  // A trailing slash is the ONE thing normalised before the exact-match
  // comparison (#2246). Next 308-redirects `/admin/display/builder/` to the
  // canonical form, but this proxy runs before that redirect — so without
  // normalisation the redirect response, and anything that ever bypassed it,
  // carried the unrelaxed policy and the relaxation was silently inert.
  it("treats a trailing slash as the canonical path on every allowlist", () => {
    const builderPolicy = buildContentSecurityPolicy("unit-test-nonce", {
      pathname: "/admin/display/builder/",
    });
    expect(directive(builderPolicy, "frame-src")).toContain("'self'");

    // The same normalisation, applied to the OTHER allowlist and to /display's
    // own relaxations — the two lists must never diverge on a trailing slash.
    const displayPolicy = buildContentSecurityPolicy("unit-test-nonce", {
      pathname: "/display/",
      selfOrigin: "https://example.org",
    });
    expect(directive(displayPolicy, "img-src")).toBe("img-src 'self' data:");
    expect(directive(displayPolicy, "frame-ancestors")).toBe(
      "frame-ancestors 'self'",
    );
    expect(directive(displayPolicy, "connect-src")).toContain(
      "https://example.org",
    );

    const headers = new Headers();
    setSecurityHeaders(headers, "/display/");
    expect(headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  // The allowlists are exact-match, never prefixes: a prefix match would hand
  // frame-src 'self' to every current and future /admin/display/* page. The
  // normalisation above rewrites the INPUT only — it must admit nothing else.
  it("does not grant frame-src 'self' to unlisted /admin/display/* paths", () => {
    for (const pathname of [
      "/admin/display/templates",
      "/admin/display/devices",
      "/admin/display/builder/extra",
      "/admin/display/builder/extra/",
      "/admin/display/builder-foo",
      "/admin/display/builderfoo",
      // A doubled leading slash is a different URL and is not canonicalised
      // here; it fails closed, as does a doubled trailing slash (only ONE
      // trailing slash is stripped).
      "//admin/display/builder",
      "/admin/display/builder//",
      "/ADMIN/DISPLAY/BUILDER",
      "/admin/display/previews",
      "/admin/display",
    ]) {
      const policy = buildContentSecurityPolicy("unit-test-nonce", { pathname });

      expect(
        directive(policy, "frame-src"),
        `${pathname} must not gain frame-src 'self'`,
      ).toBe("frame-src https://js.stripe.com https://hooks.stripe.com");
      expect(
        directive(policy, "img-src"),
        `${pathname} must keep the normal img-src`,
      ).toBe(
        "img-src 'self' data: blob: https: https://www.google-analytics.com https://*.google-analytics.com",
      );
    }
  });

  // Case sensitivity is load-bearing on BOTH sides (#2246). The app compares
  // `normalisePathname(pathname) === "/display"`, and the Caddyfiles use
  // `path_regexp` — not Caddy's case-INSENSITIVE `path` matcher — precisely so
  // the edge agrees with it. `/DISPLAY` is therefore the case that pins the two
  // together: if the app ever case-folded, the edge would silently start denying
  // a path the app had relaxed.
  it("keeps /DISPLAY fully denied, matching the case-sensitive edge matcher", () => {
    for (const pathname of ["/DISPLAY", "/Display", "/DISPLAY/", "/displaY"]) {
      const policy = buildContentSecurityPolicy("unit-test-nonce", { pathname });

      expect(
        directive(policy, "frame-ancestors"),
        `${pathname} must not be framable`,
      ).toBe("frame-ancestors 'none'");
      expect(
        directive(policy, "img-src"),
        `${pathname} must keep the normal img-src`,
      ).toBe(
        "img-src 'self' data: blob: https: https://www.google-analytics.com https://*.google-analytics.com",
      );

      const headers = new Headers();
      setSecurityHeaders(headers, pathname);
      expect(
        headers.get("X-Frame-Options"),
        `${pathname} must keep the global DENY`,
      ).toBe("DENY");
    }

    // …and the exact-case path really does relax, so the loop above is testing
    // case sensitivity rather than a path that never relaxes at all.
    const displayHeaders = new Headers();
    setSecurityHeaders(displayHeaders, "/display");
    expect(displayHeaders.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(
      directive(
        buildContentSecurityPolicy("unit-test-nonce", { pathname: "/display" }),
        "frame-ancestors",
      ),
    ).toBe("frame-ancestors 'self'");
  });

  it("leaves every non-display route's CSP byte-identical to the pre-#161 policy", () => {
    // A pinned expected policy string — any accidental change to a non-display
    // route's CSP (not just img-src) fails this test, not just a directive-by-
    // directive check.
    const expected =
      "default-src 'self'; " +
      "script-src 'self' 'nonce-unit-test-nonce' https://js.stripe.com https://www.googletagmanager.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https: https://www.google-analytics.com https://*.google-analytics.com; " +
      "font-src 'self' data:; " +
      "connect-src 'self' https://api.stripe.com https://js.stripe.com https://*.ingest.sentry.io https://www.google-analytics.com https://*.google-analytics.com; " +
      "frame-src https://js.stripe.com https://hooks.stripe.com; " +
      "worker-src 'self' blob:; " +
      "object-src 'none'; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'";

    expect(buildContentSecurityPolicy("unit-test-nonce")).toBe(expected);
    expect(
      buildContentSecurityPolicy("unit-test-nonce", { pathname: "/dashboard" }),
    ).toBe(expected);
    expect(
      buildContentSecurityPolicy("unit-test-nonce", {
        pathname: "/admin/display/templates",
      }),
    ).toBe(expected);
  });
});

describe("CSP proxy", () => {
  it("matches root page requests, and skips only the API and static shapes", () => {
    expect(
      unstable_doesProxyMatch({
        config,
        nextConfig: {},
        url: "/",
      })
    ).toBe(true);
    expect(
      unstable_doesProxyMatch({
        config,
        nextConfig: {},
        url: "/api/health",
      })
    ).toBe(false);
    expect(
      unstable_doesProxyMatch({
        config,
        nextConfig: {},
        url: "/api/admin/waitlist",
      })
    ).toBe(true);
    expect(
      unstable_doesProxyMatch({
        config,
        nextConfig: {},
        url: "/_next/static/chunks/app.js",
      })
    ).toBe(false);
    // A real flight prefetch is matched like everything else since #2404
    // removed the exemption; the matrix below covers the whole header space.
    expect(
      unstable_doesProxyMatch({
        config,
        headers: { purpose: "prefetch", rsc: "1" },
        nextConfig: {},
        url: "/",
      })
    ).toBe(true);
  });

  /**
   * The prefetch headers, exhaustively (#2404).
   *
   * **Every row is `true`, and that is the whole point.** The matcher used to
   * carry a `missing:` clause exempting `next-router-prefetch`/`purpose:
   * prefetch`, and those are headers ANYONE can set: a plain `GET /anything`
   * carrying `Purpose: prefetch` skipped the proxy on EVERY URL and was answered
   * with no nonce, no `Content-Security-Policy` and no #2420 setup gate.
   *
   * Narrowing the exemption to "a prefetch header AND `RSC`" was tried and
   * rejected (owner decision, 1 Aug 2026), because the matcher cannot express
   * Next's own definition of a flight request. `missing:` with no `value` counts
   * ANY non-empty header as present (`prepare-destination.js`'s `matchHas`),
   * while Next flags a flight request on `RSC: 1` exactly
   * (`next/dist/server/lib/is-rsc-request.js`) — so `RSC: 2`, `RSC: 0` and the
   * `1, 1` that Node produces from two `RSC` headers all skipped the proxy while
   * Next still rendered the full HTML document. Those rows are listed below by
   * name: they are the vectors the narrowed form left open, and they are why the
   * exemption was deleted rather than tightened.
   *
   * A genuine flight prefetch now mints a nonce like any other request. That is
   * a deliberate cost, taken because #2352 (static/ISR public pages) cannot
   * tolerate the alternative: a prefetch that skipped the proxy would store a
   * nonce-less copy of the page in the page cache for every later visitor.
   */
  const prefetchMatrix: ReadonlyArray<
    readonly [string, Record<string, string>]
  > = [
    ["an ordinary request", {}],
    ["a bare Purpose: prefetch probe", { purpose: "prefetch" }],
    ["a bare Next-Router-Prefetch probe", { "next-router-prefetch": "1" }],
    ["an RSC navigation", { rsc: "1" }],
    // The requests that used to be exempt.
    ["a true flight prefetch", { "next-router-prefetch": "1", rsc: "1" }],
    ["a true flight prefetch (Purpose form)", { purpose: "prefetch", rsc: "1" }],
    // The vectors the narrowed exemption left open: Next does NOT treat any of
    // these as a flight request, so each returned a full HTML document.
    ["prefetch + RSC: 2", { purpose: "prefetch", rsc: "2" }],
    ["prefetch + two RSC headers joined", { purpose: "prefetch", rsc: "1, 1" }],
    ["prefetch + a non-numeric RSC", { "next-router-prefetch": "1", rsc: "x" }],
    ["prefetch + RSC: 0", { "next-router-prefetch": "0", rsc: "0" }],
    // A value other than "prefetch" was never the exemption and still is not.
    ["Purpose: preload", { purpose: "preload" }],
  ];

  it.each(prefetchMatrix)(
    "%s runs the proxy: %o",
    (_label, headers) => {
      expect(
        unstable_doesProxyMatch({ config, headers, nextConfig: {}, url: "/" }),
        "no combination of request headers may take a URL outside the proxy",
      ).toBe(true);
    },
  );

  it("states the root rule once, with no header exemption to bypass", () => {
    // Structural, because the matrix above can only probe the header space
    // someone thought to list. A `missing:`/`has:` clause on the root entry is
    // by construction a way to skip the proxy by setting a request header, and
    // there is no header a caller can send that our nonce, our CSP and the
    // #2420 setup gate should be conditional on.
    const entries: readonly unknown[] = config.matcher;

    expect(
      entries.filter((entry) => typeof entry !== "string"),
      "every entry must be a bare source string — only an object entry can carry `missing:`/`has:`",
    ).toEqual([]);
    expect(
      entries.filter(
        (entry) => typeof entry === "string" && !entry.startsWith("/api"),
      ),
      "the root rule is stated once; a second copy is where the two used to drift",
    ).toHaveLength(1);
  });

  // `/dashboard` rather than `/`: since #2352 D1 the whole `(website)` group —
  // including `/` — carries the FIXED per-release nonce, so a per-request-nonce
  // case has to be asserted on a route outside it.
  it("emits a single enforced CSP header with a per-request nonce and no report-only header", async () => {
    const response = await proxy(new NextRequest("https://example.org/dashboard"));
    const enforcedPolicy = response.headers.get(CSP_HEADER);

    expect(enforcedPolicy).toBeTruthy();
    expect(response.headers.get(CSP_REPORT_ONLY_HEADER)).toBeNull();
    expectStrictScriptSrc(enforcedPolicy as string);

    const nonce = nonceFromScriptSrc(enforcedPolicy as string);
    expect(nonce).toBeTruthy();
    expect(response.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`)).toBe(
      nonce
    );
    expect(
      response.headers.get(`x-middleware-request-${CSP_HEADER.toLowerCase()}`)
    ).toBe(enforcedPolicy);

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it("serves the tightened img-src on real /display and preview-host requests (issue #161)", async () => {
    const displayResponse = await proxy(
      new NextRequest("https://example.org/display"),
    );
    const previewResponse = await proxy(
      new NextRequest("https://example.org/admin/display/preview"),
    );
    const dashboardResponse = await proxy(
      new NextRequest("https://example.org/dashboard"),
    );

    expect(directive(displayResponse.headers.get(CSP_HEADER) as string, "img-src")).toBe(
      "img-src 'self' data:",
    );
    expect(
      directive(previewResponse.headers.get(CSP_HEADER) as string, "img-src"),
    ).toBe("img-src 'self' data:");
    expect(
      directive(dashboardResponse.headers.get(CSP_HEADER) as string, "img-src"),
    ).toBe(
      "img-src 'self' data: blob: https: https://www.google-analytics.com https://*.google-analytics.com",
    );
  });

  it("serves frame-src 'self' on a real builder request and not on its siblings (issue #2246)", async () => {
    const builderResponse = await proxy(
      new NextRequest("https://example.org/admin/display/builder?templateId=tpl-1"),
    );
    const templatesResponse = await proxy(
      new NextRequest("https://example.org/admin/display/templates"),
    );

    // The Live preview iframe is only reachable if the builder's own policy
    // allows framing same-origin content.
    expect(
      directive(builderResponse.headers.get(CSP_HEADER) as string, "frame-src"),
    ).toContain("'self'");
    expect(
      directive(templatesResponse.headers.get(CSP_HEADER) as string, "frame-src"),
    ).not.toContain("'self'");
  });

  it("exposes the requested path to server components via a request header", async () => {
    const response = await proxy(
      new NextRequest("https://example.org/dashboard?tab=bookings")
    );

    expect(
      response.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)
    ).toBe("/dashboard?tab=bookings");
  });

  it("generates a different nonce per request outside the public website", async () => {
    const a = await proxy(new NextRequest("https://example.org/dashboard"));
    const b = await proxy(new NextRequest("https://example.org/dashboard"));
    const nonceA = nonceFromScriptSrc(a.headers.get(CSP_HEADER) as string);
    const nonceB = nonceFromScriptSrc(b.headers.get(CSP_HEADER) as string);

    expect(nonceA).toBeTruthy();
    expect(nonceB).toBeTruthy();
    expect(nonceA).not.toEqual(nonceB);
  });

  it("returns 404 for disabled feature page and API paths", async () => {
    const pageResponse = getFeatureFlagBlockResponse("/admin/waitlist", {
      ...allFeaturesOn,
      waitlist: false,
    });
    const apiResponse = getFeatureFlagBlockResponse("/api/admin/waitlist", {
      ...allFeaturesOn,
      waitlist: false,
    });
    const bedAllocationResponse = getFeatureFlagBlockResponse(
      "/admin/bed-allocation",
      {
        ...allFeaturesOn,
        bedAllocation: false,
      },
    );

    expect(pageResponse).not.toBeNull();
    expect(apiResponse).not.toBeNull();
    expect(bedAllocationResponse).not.toBeNull();
    expect(pageResponse?.status).toBe(404);
    expect(apiResponse?.status).toBe(404);
    expect(bedAllocationResponse?.status).toBe(404);
    await expect(apiResponse!.json()).resolves.toEqual({ error: "Not found" });
  });

  it("returns 404 for a disabled new-module page and its API route", async () => {
    // The page AND the backend API must both 404 when the module is off.
    const pageResponse = getFeatureFlagBlockResponse("/admin/lockers", {
      ...allFeaturesOn,
      lockers: false,
    });
    const apiResponse = getFeatureFlagBlockResponse("/api/admin/lockers", {
      ...allFeaturesOn,
      lockers: false,
    });
    const groupApiResponse = getFeatureFlagBlockResponse(
      "/api/group-bookings/abc/join",
      { ...allFeaturesOn, groupBookings: false },
    );
    const addyApiResponse = getFeatureFlagBlockResponse(
      "/api/address-autocomplete/search",
      { ...allFeaturesOn, addressAutocomplete: false },
    );

    expect(pageResponse?.status).toBe(404);
    expect(apiResponse?.status).toBe(404);
    expect(groupApiResponse?.status).toBe(404);
    expect(addyApiResponse?.status).toBe(404);
    await expect(addyApiResponse!.json()).resolves.toEqual({
      error: "Not found",
    });
  });

  // Regression guard: every feature-gated route must actually be covered by the
  // middleware matcher, or the proxy never runs and the 404 gate above is dead
  // code for that route. (An earlier bug shipped feature-routes rules for new
  // modules whose /api paths were missing from the matcher, so disabled modules
  // still served their backend.)
  it("matcher runs for every feature-gated route prefix, bare and child", () => {
    const gatedPrefixes = FEATURE_ROUTE_RULES.flatMap(
      (rule) => rule.prefixes ?? [],
    );

    for (const prefix of gatedPrefixes) {
      // A prefix rule gates the whole SUBTREE (`matchesPrefix`), so the bare
      // path alone is not enough: `/api/cron/xero` and `/api/webhooks/xero`
      // were literal entries whose children the proxy never ran on, leaving
      // the xeroIntegration gate dead the moment a child route was added.
      for (const url of [prefix, `${prefix}/probe-child`]) {
        expect(
          unstable_doesProxyMatch({ config, nextConfig: {}, url }),
          `middleware matcher must run for ${url} (feature-gated route)`,
        ).toBe(true);
      }
    }
  });

  // The other half of the same invariant, for the rules that gate by REGEX
  // rather than by prefix (#2435). `/api/bookings/[id]/guests/[guestId]/consent`
  // shipped a `memberGuests` pattern with no matcher entry at all, so the proxy
  // never ran on it and that gate could not fire — the endpoint's own module
  // check was the only thing refusing. A regex cannot be handed to the matcher
  // directly, so each one carries concrete sample paths here; the map is
  // asserted to be exactly the set of live patterns, so a NEW pattern rule with
  // no sample fails this suite rather than slipping past it. Every ALTERNATION
  // BRANCH gets its own sample: one sample per regex would pass while the
  // matcher covered only the branch that happened to be sampled.
  const PATTERN_SAMPLE_PATHS = new Map<string, string[]>([
    [
      String(/^\/api\/bookings\/[^/]+\/waitlist-confirm$/),
      ["/api/bookings/bkg-1/waitlist-confirm"],
    ],
    [
      String(/^\/api\/admin\/bookings\/[^/]+\/force-confirm$/),
      ["/api/admin/bookings/bkg-1/force-confirm"],
    ],
    [
      String(/^\/api\/admin\/members\/[^/]+\/xero-(link|push|unlink)$/),
      [
        "/api/admin/members/mem-1/xero-link",
        "/api/admin/members/mem-1/xero-push",
        "/api/admin/members/mem-1/xero-unlink",
      ],
    ],
    [
      String(/^\/api\/bookings\/[^/]+\/guests\/[^/]+\/consent$/),
      ["/api/bookings/bkg-1/guests/gst-1/consent"],
    ],
  ]);

  it("has a sample path for every feature-gated route pattern, and no stale ones", () => {
    // Deduplicated on both sides: two rules may legitimately declare the SAME
    // regex (a second flag gating an existing endpoint), which the map cannot
    // represent twice and which is not drift.
    const livePatterns = FEATURE_ROUTE_RULES.flatMap(
      (rule) => rule.patterns ?? [],
    ).map(String);

    expect([...new Set(PATTERN_SAMPLE_PATHS.keys())].sort()).toEqual(
      [...new Set(livePatterns)].sort(),
    );
  });

  it("matcher runs for every feature-gated route pattern", () => {
    for (const rule of FEATURE_ROUTE_RULES) {
      for (const pattern of rule.patterns ?? []) {
        const urls = PATTERN_SAMPLE_PATHS.get(String(pattern));

        expect(
          urls,
          `${String(pattern)} (${rule.flag}) needs sample paths in PATTERN_SAMPLE_PATHS`,
        ).toBeDefined();
        expect(
          (urls ?? []).length,
          `${String(pattern)} (${rule.flag}) needs at least one sample path`,
        ).toBeGreaterThan(0);

        for (const url of urls ?? []) {
          // The sample has to be a genuine instance of the pattern, or the
          // matcher assertion below would be testing an unrelated URL.
          expect(
            pattern.test(url),
            `${url} must actually match ${String(pattern)}`,
          ).toBe(true);

          expect(
            unstable_doesProxyMatch({ config, nextConfig: {}, url }),
            `proxy matcher must run for ${url} — without a config.matcher entry the ${rule.flag} module gate never fires there`,
          ).toBe(true);
        }
      }
    }
  });

  it("matcher runs for the new modules' child API paths", () => {
    // The real routes live under these prefixes (e.g. /[id], /[code]), so the
    // matcher must cover the children too — not just the bare prefix.
    const childApiPaths = [
      "/api/group-bookings/CODE/join",
      "/api/admin/lockers/123",
      "/api/admin/inductions/123",
      "/api/admin/induction-templates/123",
      "/api/inductions/123",
      "/api/admin/work-parties/123",
      "/api/work-parties/active",
      "/api/admin/promo-codes/123",
      "/api/promo-codes/validate",
      "/api/admin/hut-leaders/123",
      "/api/admin/internet-banking-settings",
      "/api/admin/communications/send",
      "/api/admin/setup/finance-report-mappings/backfill",
      "/api/admin/mountain-conditions",
      "/api/skifield-whakapapa",
      "/api/skifield-conditions",
      "/api/address-autocomplete/search",
      "/api/address-autocomplete/details/123",
    ];

    for (const url of childApiPaths) {
      expect(
        unstable_doesProxyMatch({ config, nextConfig: {}, url }),
        `middleware matcher must run for ${url} (gated API route)`,
      ).toBe(true);
    }
  });
});

describe("public website fixed release nonce (#2352 D1)", () => {
  /**
   * The URL matrix, driven through the REAL proxy rather than through
   * `buildContentSecurityPolicy()` directly.
   *
   * That distinction is the whole value of this block. `csp.ts` takes a
   * `publicWebsite` boolean from its caller, so a test of the builder alone would
   * only prove that the flag does what it says. What has to hold is that the proxy
   * asks the right question of each address — and since the owner's 3 Aug 2026
   * narrowing there are TWO questions, deliberately answered by two predicates:
   *
   *  • the NONCE follows `isFixedNonceWebsitePath()` — the five approved
   *    `(website)` routes and everything the CMS catch-all serves, and nothing
   *    else. `/hut-leader-instructions`, `/join/[code]` and `/join/verify/[token]`
   *    moved to `(website-dynamic)` and are back on a per-request value;
   *  • the POLICY's Stripe tightening follows `isPublicWebsitePath()` — the WHOLE
   *    public website, both groups, because Stripe.js has no business on a
   *    PIN-gated instructions page either.
   *
   * Asserting against the predicates rather than against a second hand-written
   * list is what stops any of the three drifting; the cases below name the
   * addresses where the two answers differ, which is where a regression would land.
   */
  const urls = [
    // (website): the CMS catch-all's territory and its fixed routes.
    "/",
    "/about",
    "/about/history",
    "/contact",
    "/join",
    "/join/apply",
    "/definitely-missing",
    "/wp-admin/setup-config.php",
    // (website-dynamic): public website, per-request nonce, tightened policy.
    "/join/ABC123",
    "/join/verify/token-xyz",
    "/hut-leader-instructions",
    // Not the website: every other group, plus the shapes the gate refuses.
    "/login",
    "/register",
    "/dashboard",
    "/book",
    "/admin",
    "/admin/site-style",
    "/finance",
    "/lodge",
    "/display",
    "/robots.txt",
    "/sitemap.xml",
    "/gallery.png",
    "/asset-not-found",
  ] as const;

  it.each(urls)(
    "carries the fixed nonce iff isFixedNonceWebsitePath() claims %s",
    async (url) => {
      const releaseNonce = await getPublicWebsiteNonce();
      const response = await proxy(new NextRequest(`https://example.org${url}`));
      const policy = response.headers.get(CSP_HEADER) as string;
      const nonce = nonceFromScriptSrc(policy);

      if (isFixedNonceWebsitePath(url)) {
        expect(nonce, `${url} is served by one of the five approved routes`).toBe(
          releaseNonce,
        );
      } else {
        expect(nonce, `${url} must keep a fresh per-request nonce`).not.toBe(
          releaseNonce,
        );
      }

      // The policy's public-website flag is the WIDE predicate, on purpose: its
      // only effect is dropping Stripe from `script-src`, and the three
      // per-request public pages should be tightened too. Following the nonce here
      // would have handed them a LOOSER policy as a side effect of a security fix.
      if (isPublicWebsitePath(url)) {
        expectPublicWebsiteScriptSrc(policy);
      } else {
        expectStrictScriptSrc(policy);
      }

      // Either way, when the request is passed THROUGH to a render, the nonce the
      // render is handed is the nonce in the policy — a mismatch would block every
      // inline script on the page. Some of these URLs are answered by the proxy
      // itself instead (a module gate's 404), and those carry no request headers
      // by construction; `x-middleware-next` is how `NextResponse.next()` marks
      // the difference.
      if (response.headers.get("x-middleware-next")) {
        expect(
          response.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`),
        ).toBe(nonce);
      }
    },
  );

  it("is asserting the real release-derived nonce, not the fallback", async () => {
    // Without this the whole block would pass on the per-process fallback, which
    // is also stable inside one test process — the classic "green for the wrong
    // reason". `resolvePublicWebsiteNonce()` reports where the value came from.
    const { resolvePublicWebsiteNonce } = await import("@/lib/release-nonce");

    expect((await resolvePublicWebsiteNonce()).source).toBe("release-id");
  });

  it("serves the SAME nonce on two requests for a website page", async () => {
    // The property a stored page depends on: the policy on the response that
    // SERVES a cached page still names the nonce frozen into its inline scripts.
    const a = await proxy(new NextRequest("https://example.org/about"));
    const b = await proxy(new NextRequest("https://example.org/about"));

    expect(nonceFromScriptSrc(a.headers.get(CSP_HEADER) as string)).toBe(
      nonceFromScriptSrc(b.headers.get(CSP_HEADER) as string),
    );
  });

  /**
   * The narrowing, as the property it is meant to buy (owner decision, 3 Aug 2026).
   *
   * The matrix above pins that these three do not get the RELEASE value; this pins
   * the thing that actually matters, which is that they get a fresh one every time.
   * An unguessable per-response nonce is the defence the fixed value gives up, and
   * these pages give up nothing because none of them is ever stored.
   */
  it.each([
    "/hut-leader-instructions",
    "/join/ABC123",
    "/join/verify/token-xyz",
  ])("mints a DIFFERENT nonce on each request for %s", async (url) => {
    const a = await proxy(new NextRequest(`https://example.org${url}`));
    const b = await proxy(new NextRequest(`https://example.org${url}`));
    const first = nonceFromScriptSrc(a.headers.get(CSP_HEADER) as string);
    const second = nonceFromScriptSrc(b.headers.get(CSP_HEADER) as string);

    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
    // And each response hands its own value to the render, or the page's inline
    // scripts would be refused by the policy on the very same response.
    expect(a.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`)).toBe(first);
    expect(b.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`)).toBe(second);
  });

  /**
   * F1, at the unit level (#2352 reconciliation, highest severity).
   *
   * #2404 deleted the matcher's prefetch exemption, and the matrix above pins that
   * no header combination takes a URL outside the proxy. This adds the half #2352
   * needs: a prefetch-shaped request must also come out with the SAME policy as an
   * ordinary one. Under full-route ISR a prefetch that reached the render without a
   * CSP header would generate and store a page with NO nonce stamped into it, and
   * every later visitor would then be served a page whose every inline script the
   * nonce-only policy blocks — the page would never hydrate. The Playwright gate
   * makes the same assertion against a real server.
   */
  const prefetchShapes: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ["Purpose: prefetch", { purpose: "prefetch" }],
    ["Next-Router-Prefetch", { "next-router-prefetch": "1" }],
    ["Sec-Purpose: prefetch", { "sec-purpose": "prefetch" }],
    ["a flight prefetch", { purpose: "prefetch", rsc: "1" }],
    ["prefetch + RSC: 2", { purpose: "prefetch", rsc: "2" }],
  ];

  it.each(prefetchShapes)(
    "answers a %s request for a website page with the same fixed nonce",
    async (_label, headers) => {
      const releaseNonce = await getPublicWebsiteNonce();
      const response = await proxy(
        new NextRequest("https://example.org/about", { headers }),
      );
      const policy = response.headers.get(CSP_HEADER) as string;

      expect(nonceFromScriptSrc(policy)).toBe(releaseNonce);
      expectPublicWebsiteScriptSrc(policy);
      expect(
        response.headers.get(`x-middleware-request-${CSP_HEADER.toLowerCase()}`),
        "the render must see a CSP header, or it stamps no nonce at all",
      ).toBe(policy);
    },
  );

  it("leaves every directive other than script-src untouched", async () => {
    // The trade is one entry in one directive. Anything else changing here would
    // be a relaxation nobody decided.
    const website = await proxy(new NextRequest("https://example.org/about"));
    const member = await proxy(new NextRequest("https://example.org/dashboard"));
    const websitePolicy = website.headers.get(CSP_HEADER) as string;
    const memberPolicy = member.headers.get(CSP_HEADER) as string;

    for (const name of [
      "default-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "frame-src",
      "worker-src",
      "object-src",
      "frame-ancestors",
      "base-uri",
      "form-action",
    ]) {
      expect(directive(websitePolicy, name), name).toBe(
        directive(memberPolicy, name),
      );
    }
  });
});

describe("sign-in marker cookie (#2352 D2)", () => {
  const SESSION = "authjs.session-token=abc";

  function setCookieHeaders(response: Awaited<ReturnType<typeof proxy>>) {
    return response.headers.getSetCookie();
  }

  it("sets the hint when a session cookie is present and the hint is not", async () => {
    const response = await proxy(
      new NextRequest("https://example.org/dashboard", {
        headers: { cookie: SESSION },
      }),
    );
    const cookies = setCookieHeaders(response);

    expect(cookies.some((c) => c.startsWith(`${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}`))).toBe(
      true,
    );
    // Readable by the browser on purpose — that is the whole mechanism — and
    // scoped to the whole site so any public page can read it.
    const hint = cookies.find((c) => c.startsWith(SIGNED_IN_HINT_COOKIE));
    expect(hint).not.toContain("HttpOnly");
    expect(hint).toContain("Path=/");
    expect(hint?.toLowerCase()).toContain("samesite=lax");
  });

  it("clears the hint when the session cookie has gone", async () => {
    const response = await proxy(
      new NextRequest("https://example.org/about", {
        headers: { cookie: `${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}` },
      }),
    );

    const hint = setCookieHeaders(response).find((c) =>
      c.startsWith(SIGNED_IN_HINT_COOKIE),
    );
    expect(hint).toBeDefined();
    expect(hint).toContain("Max-Age=0");
  });

  it("writes NOTHING when the hint already agrees with the session", async () => {
    const signedIn = await proxy(
      new NextRequest("https://example.org/dashboard", {
        headers: {
          cookie: `${SESSION}; ${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}`,
        },
      }),
    );
    const anonymous = await proxy(new NextRequest("https://example.org/about"));

    expect(setCookieHeaders(signedIn)).toEqual([]);
    expect(setCookieHeaders(anonymous)).toEqual([]);
  });

  it("never touches the hint on an /api path or a non-GET request", async () => {
    // A JSON client has no header to correct, and a Set-Cookie it did not ask for
    // is noise a caller could reasonably read as a session change. #2405's
    // module-state parity also lives on these responses' headers.
    const api = await proxy(
      new NextRequest("https://example.org/api/admin/waitlist", {
        headers: { cookie: SESSION },
      }),
    );
    const post = await proxy(
      new NextRequest("https://example.org/dashboard", {
        method: "POST",
        headers: { cookie: SESSION },
      }),
    );

    expect(setCookieHeaders(api)).toEqual([]);
    expect(setCookieHeaders(post)).toEqual([]);
  });

  it("strips the hint from the Cookie header forwarded to the render", async () => {
    // It is a DISPLAY hint for the browser. If a server render could read it, the
    // next person to reach for "is this visitor signed in?" would find a forgeable
    // answer sitting right there.
    //
    // Asserted on `x-middleware-request-cookie`, which is where the value actually
    // travels. The previous version of this test looked for
    // `x-middleware-request-signed-in-hint` — a header name that cannot exist for
    // any input, because the override headers are named after HTTP HEADERS and the
    // hint is a cookie INSIDE the cookie header — so it passed unconditionally
    // while the hint really was reaching `cookies()` (slice-1 review, F2).
    const response = await proxy(
      new NextRequest("https://example.org/about", {
        headers: {
          cookie: `theme=dark; ${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}; locale=en-NZ`,
        },
      }),
    );
    const forwarded = response.headers.get("x-middleware-request-cookie");

    expect(
      forwarded,
      "the other cookies must still reach the render",
    ).toBe("theme=dark; locale=en-NZ");
    expect(forwarded).not.toContain(SIGNED_IN_HINT_COOKIE);
  });

  it("drops the Cookie header entirely when the hint was the only cookie", async () => {
    const response = await proxy(
      new NextRequest("https://example.org/about", {
        headers: { cookie: `${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}` },
      }),
    );

    expect(response.headers.get("x-middleware-request-cookie")).toBeNull();
    // An empty `cookie: ` would still list the header in the override set, which
    // reads like "the render was handed cookies" to anyone debugging.
    expect(
      response.headers.get("x-middleware-override-headers"),
    ).not.toContain("cookie");
  });

  it("still forwards a session cookie untouched", async () => {
    // The strip must be surgical: next-auth's own cookie is what the render's
    // `auth()` depends on, and mangling it would sign every member out.
    const response = await proxy(
      new NextRequest("https://example.org/dashboard", {
        headers: {
          cookie: `${SESSION}; ${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}`,
        },
      }),
    );

    expect(response.headers.get("x-middleware-request-cookie")).toBe(SESSION);
  });

  it("does not let the render read the hint on the request that SETS it", async () => {
    // Next seeds `cookies()` from `x-middleware-set-cookie`, which the
    // NextResponse cookie proxy writes. Writing the Set-Cookie header directly is
    // what keeps that signal absent — the browser gets the same bytes either way.
    const response = await proxy(
      new NextRequest("https://example.org/dashboard", {
        headers: { cookie: SESSION },
      }),
    );

    expect(
      response.headers.getSetCookie().some((c) => c.startsWith(SIGNED_IN_HINT_COOKIE)),
      "the browser must still be sent the hint",
    ).toBe(true);
    expect(response.headers.get("x-middleware-set-cookie")).toBeNull();
  });

  it("filters by exact cookie name, not by substring", async () => {
    const response = await proxy(
      new NextRequest("https://example.org/about", {
        headers: {
          cookie: `x-${SIGNED_IN_HINT_COOKIE}=1; ${SIGNED_IN_HINT_COOKIE}-old=1; note=${SIGNED_IN_HINT_COOKIE}=1`,
        },
      }),
    );

    expect(response.headers.get("x-middleware-request-cookie")).toBe(
      `x-${SIGNED_IN_HINT_COOKIE}=1; ${SIGNED_IN_HINT_COOKIE}-old=1; note=${SIGNED_IN_HINT_COOKIE}=1`,
    );
  });
});

describe("anonymous public-page cache headers (#2322)", () => {
  /**
   * The one directive the whole section is about. `private`, and no `s-maxage`:
   * middleware cannot tell a flight request from a document request (see the
   * adapter suite below), so no shared cache may be invited to store a response
   * whose body Next may yet render as flight bytes under the HTML's URL.
   */
  const ANONYMOUS_CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=300";

  function requestWithCookie(url: string, cookie?: string, method = "GET") {
    return new NextRequest(url, {
      method,
      ...(cookie ? { headers: { cookie } } : {}),
    });
  }

  it("marks an anonymous GET of an allow-listed page cacheable by the BROWSER only", async () => {
    const response = await proxy(new NextRequest("https://example.org/"));

    expect(response.headers.get("Cache-Control")).toBe(ANONYMOUS_CACHE_CONTROL);
    // Without Vary: Cookie the stored anonymous render — which paints the
    // header logged-out — could be replayed to the same browser after sign-in.
    expect(response.headers.get("Vary")).toContain("Cookie");
  });

  it("leaves the framework default in place for a request carrying a session", async () => {
    const response = await proxy(
      requestWithCookie("https://example.org/", "authjs.session-token=abc"),
    );

    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it.each([
    ["plain v5", "authjs.session-token=abc"],
    ["__Secure- prefixed v5", "__Secure-authjs.session-token=abc"],
    ["chunked v5", "authjs.session-token.0=abc"],
    ["__Secure- chunked v5", "__Secure-authjs.session-token.1=abc"],
    // Legacy v4 cookies are treated as "maybe authenticated" here on purpose:
    // the cost is a cache miss, the opposite error would cache a session page.
    ["legacy v4", "next-auth.session-token=abc"],
    ["legacy v4 __Secure-", "__Secure-next-auth.session-token=abc"],
  ])("suppresses caching for a %s session cookie", (_label, cookie) => {
    expect(
      getAnonymousPageCacheControl(requestWithCookie("https://example.org/", cookie)),
    ).toBeNull();
  });

  it("still caches when only unrelated cookies are present", () => {
    expect(
      getAnonymousPageCacheControl(
        requestWithCookie("https://example.org/", "theme=dark; locale=en-NZ"),
      ),
    ).toBe(ANONYMOUS_CACHE_CONTROL);
  });

  it("never invites a SHARED cache to store the response", () => {
    // The property, stated over the directive rather than over a request shape,
    // because that is where it now lives. A flight response is different bytes
    // under the SAME URL, and the proxy cannot tell one is coming — so the only
    // safe answer is that no cache but the requesting browser may keep it.
    const directive = getAnonymousPageCacheControl(
      new NextRequest("https://example.org/"),
    );

    expect(directive).toBe(ANONYMOUS_CACHE_CONTROL);
    expect(directive).toContain("private");
    expect(directive).not.toContain("public");
    expect(directive).not.toContain("s-maxage");
  });

  it("still caches a plain document request", () => {
    expect(
      getAnonymousPageCacheControl(new NextRequest("https://example.org/")),
    ).toBe(ANONYMOUS_CACHE_CONTROL);
  });

  /**
   * The #2322 invariant asserted where slice 1 MOVED it (slice-1 review).
   *
   * The two tests above hold the invariant over `getAnonymousPageCacheControl()`,
   * which only ever answers for `/`. Every other public-website path returned null,
   * which used to mean "the framework's `private, no-store` default" and, once the
   * CMS catch-all carried `export const revalidate = 300`, silently began to mean
   * `s-maxage=300, stale-while-revalidate=31535700` instead
   * (`next/dist/server/lib/cache-control.js` plus the 31536000 `expireTime`
   * default). That is the exact directive #2322 exists to keep off public pages,
   * and no test looked at a CMS path.
   */
  const CMS_PATHS = ["/about", "/faq", "/trips/2026", "/definitely-missing"];

  it.each(CMS_PATHS)(
    "never invites a shared cache to store %s",
    async (path) => {
      const response = await proxy(new NextRequest(`https://example.org${path}`));
      const directive = response.headers.get("Cache-Control");

      expect(directive).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
      expect(directive).toContain("private");
      expect(directive).not.toContain("s-maxage");
      expect(directive).not.toContain("stale-while-revalidate");
    },
  );

  it("sends the same directive to a member with a session on a CMS path", async () => {
    // A stored page is one copy for everyone, so the header cannot depend on who
    // is asking — and this response carries the D2 marker `Set-Cookie`, which a
    // shared cache would otherwise be free to hand to a stranger.
    const response = await proxy(
      requestWithCookie("https://example.org/about", "authjs.session-token=abc"),
    );

    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  it("leaves `/` on its own deliberate browser window", async () => {
    // The explicit directive must not swallow the one allow-listed route.
    const response = await proxy(new NextRequest("https://example.org/"));

    expect(response.headers.get("Cache-Control")).toBe(ANONYMOUS_CACHE_CONTROL);
  });

  it("leaves `/` to the framework when a session suppresses the anonymous window", async () => {
    // `/` is force-dynamic, so Next writes the same `private, no-store` itself and
    // there is no `s-maxage` here to correct. #2322's decision about that one route
    // stays wholly in getAnonymousPageCacheControl().
    const response = await proxy(
      requestWithCookie("https://example.org/", "authjs.session-token=abc"),
    );

    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("leaves a member or admin page to the framework", async () => {
    // Outside the public website nothing changed: no route there carries a
    // `revalidate`, so Next's own `private, no-store` default is already right and
    // the proxy has no business overwriting it.
    for (const path of ["/dashboard", "/admin", "/login", "/display"]) {
      const response = await proxy(new NextRequest(`https://example.org${path}`));
      expect(response.headers.get("Cache-Control"), path).toBeNull();
    }
  });

  it("leaves a non-GET public-website request to the framework", async () => {
    const response = await proxy(
      requestWithCookie("https://example.org/contact", undefined, "POST"),
    );

    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("never caches a non-GET request", () => {
    expect(
      getAnonymousPageCacheControl(
        requestWithCookie("https://example.org/", undefined, "POST"),
      ),
    ).toBeNull();
  });

  it("caches the home page, the one allow-listed route", () => {
    expect(getAnonymousPageCacheControl(new NextRequest("https://example.org/"))).toBe(
      ANONYMOUS_CACHE_CONTROL,
    );
  });

  // The allow list is matched after trailing-slash normalisation, so a future
  // entry cannot be silently bypassed by a trailing slash the way the CSP
  // allowlists could before #2246.
  it("normalises a trailing slash before matching the allow list", () => {
    expect(
      getAnonymousPageCacheControl(new NextRequest("https://example.org/about/")),
    ).toBeNull();
  });

  it("never caches token-, form-, or session-bearing routes", () => {
    // (public) is entirely token/auth/form pages; /join and /contact are
    // public but form-bearing; the CMS catch-all is excluded because
    // middleware cannot resolve it without a database read.
    const uncacheable = [
      "/login",
      "/logout",
      "/register",
      "/forgot-password",
      "/reset-password",
      "/change-password",
      "/verify-email",
      "/pay/tok-123",
      "/chores/tok-123",
      "/family-invite/tok-123",
      "/membership-cancellation/tok-123",
      "/booking-requests",
      "/school-bookings",
      "/join",
      "/join/apply",
      "/contact",
      // Public but per-assignment and PIN-gated (?a= from an assignment email).
      "/hut-leader-instructions",
      "/about",
      "/admin",
      "/admin/site-style",
      "/dashboard",
      "/book",
      "/finance",
      "/lodge",
      "/display",
    ];

    for (const path of uncacheable) {
      expect(
        getAnonymousPageCacheControl(new NextRequest(`https://example.org${path}`)),
        `${path} must not be publicly cacheable`,
      ).toBeNull();
    }
  });

  /**
   * The same property, measured through the REAL middleware adapter rather than
   * by handing `proxy()` a `NextRequest` this file built.
   *
   * The distinction is the whole point. Every case above constructs
   * `new NextRequest(url, { headers })` directly, so whatever headers the test
   * sets are the headers the proxy sees. In production nothing reaches the proxy
   * that way: Next wraps it in `adapter()`
   * (`next/dist/server/web/adapter.js`, entered from
   * `build/templates/middleware.js` on the node runtime and from the edge
   * sandbox), and that function DELETES every `FLIGHT_HEADERS` entry —
   * `rsc`, `next-router-state-tree`, `next-router-prefetch`,
   * `next-router-segment-prefetch`, `next-hmr-refresh` — before userland runs,
   * re-attaching them for the render afterwards. A guard written over those
   * header names therefore passes every direct-construction test and never once
   * fires in production, which is how the `public, s-maxage` directive came to
   * be shipped on a flight body.
   *
   * These cases go through `adapter()` and assert what the response ACTUALLY
   * leaves with. They fail on the directive this section exists to keep out.
   */
  describe("through Next's real middleware adapter", () => {
    async function throughAdapter(
      headers: Record<string, string>,
      url = "https://example.org/",
    ) {
      let seenByProxy: Headers | null = null;

      const result = await adapter({
        page: "/",
        handler: async (request: NextRequest) => {
          seenByProxy = new Headers(request.headers);
          return proxy(request);
        },
        request: {
          url,
          method: "GET",
          headers,
          nextConfig: {},
          body: undefined,
        },
      } as unknown as Parameters<typeof adapter>[0]);

      return {
        seenByProxy: seenByProxy as unknown as Headers,
        cacheControl: result.response.headers.get("Cache-Control"),
      };
    }

    const FLIGHT_REQUEST_HEADERS = [
      "RSC",
      "Next-Router-State-Tree",
      "Next-Router-Prefetch",
      "Next-Router-Segment-Prefetch",
    ];

    it("hides every flight header from the proxy, so no proxy-side check can see one", async () => {
      const { seenByProxy } = await throughAdapter(
        {
          rsc: "1",
          "next-router-prefetch": "1",
          "next-router-state-tree": "%5B%22%22%5D",
          purpose: "prefetch",
        },
        "https://example.org/?_rsc=abc12",
      );

      for (const header of FLIGHT_REQUEST_HEADERS) {
        expect(
          seenByProxy.get(header),
          `${header} must be assumed INVISIBLE to the proxy — the adapter strips it`,
        ).toBeNull();
      }
      // `?_rsc=` is stripped as well, so the query is no signal either.
      expect(seenByProxy.get("Purpose")).toBe("prefetch");
    });

    it.each([
      [
        "a genuine flight prefetch",
        {
          rsc: "1",
          "next-router-prefetch": "1",
          "next-router-state-tree": "%5B%22%22%5D",
          purpose: "prefetch",
        },
      ],
      // The case that rules out every remaining signal: a plain RSC navigation
      // carries no `Purpose`, no `Sec-Purpose` and no `Next-Url`, so after the
      // strip it is byte-identical to a document request at the proxy.
      ["a plain RSC navigation", { rsc: "1", "next-router-state-tree": "%5B%22%22%5D" }],
      ["a crafted bare RSC:1 GET", { rsc: "1" }],
      ["a browser speculation-rules prefetch", { "sec-purpose": "prefetch" }],
      ["a plain document GET", {}],
    ])(
      "%s leaves with no shared-cache directive on it",
      async (_label, headers) => {
        const { cacheControl } = await throughAdapter(headers);

        expect(cacheControl).toBe(ANONYMOUS_CACHE_CONTROL);
        expect(cacheControl).not.toContain("public");
        expect(cacheControl).not.toContain("s-maxage");
      },
    );
  });
});

/**
 * The matcher and the setup gate's classifier have to agree (#2420 review
 * finding F3).
 *
 * The gate lives inside `proxy()`, so a URL the matcher skips is a URL the gate
 * never sees. If `isPublicWebsitePath()` calls such a URL a website address, the
 * binding acceptance criterion — every public-website address answers 503 until
 * setup is complete — is simply false for it, silently.
 *
 * It was false. Measured before the fix, all five of these skipped the matcher
 * while the classifier called them website paths, so pre-setup they answered
 * 200: `/apiary`, `/api-docs` (the `api` alternative was a bare PREFIX, not a
 * path segment), `/favicon.icons`, `/logo.pngs` (same, and `favicon.ico`'s dot
 * was unescaped so `/faviconXico` skipped too), and `/gallery.svg` (an
 * image-extension suffix, which the matcher skipped on purpose).
 *
 * #2420 reconciled the two in opposite directions: the prefix bugs were the
 * matcher's to fix, the extension case was left to the classifier. #2404's
 * Option A then removed the extension exclusion from the matcher as well, so the
 * subset invariant below is now satisfied with room to spare — the matcher runs
 * on strictly more than the gate claims. `isPublicWebsitePath()`'s refusal of
 * asset shapes survives on its own reasoning, not as a mirror of this string;
 * see its comment, and the pair of assertions further down.
 */
describe("the proxy matcher covers every path the setup gate would gate", () => {
  const matches = (url: string) =>
    unstable_doesProxyMatch({ config, nextConfig: {}, url });

  /**
   * Shapes chosen to straddle every alternative in the matcher's negative
   * lookahead, because that is where the two definitions can drift apart. The
   * first five are the measured failures above.
   */
  const probes = [
    "/",
    "/about",
    "/apiary",
    "/api-docs",
    "/favicon.icons",
    "/logo.pngs",
    "/faviconXico",
    "/gallery.svg",
    "/definitely-missing",
    "/wp-admin/setup-config.php",
    "/.env",
    "/api",
    "/api/",
    "/api/definitely-missing",
    "/favicon.ico",
    "/logo.png",
    "/branding/logo.png",
    "/_next/static/chunks/main.js",
    "/admin/site-style",
    "/login",
    "/robots.txt",
    "/sitemap.xml",
  ];

  it.each(probes)(
    "%s is matched by config.matcher whenever the gate claims it",
    (url) => {
      if (!isPublicWebsitePath(url)) {
        return;
      }

      expect(
        matches(url),
        `${url} is classed as a public-website path but the proxy never runs on it, so the setup gate cannot answer 503 for it`,
      ).toBe(true);
    },
  );

  it("still skips the /api and static shapes #2405 and the hot path depend on", () => {
    // The three alternatives that remain, and the only three. `/api` keeps its
    // own JSON 404 route and its module-gate verb parity; `_next/static` is the
    // hot path (dozens of chunk requests per page load) and `_next/image` is a
    // real handler that answers its own plain-text 400. A miss inside either
    // `_next` namespace is covered one layer down, by the `afterFiles` rewrites.
    for (const url of [
      "/api",
      "/api/",
      "/api/definitely-missing",
      "/api/does-not-exist.png",
      "/_next/static/chunks/main.js",
      "/_next/image",
    ]) {
      expect(matches(url), `${url} must stay outside the matcher`).toBe(false);
    }
  });

  /**
   * The asset shapes MOVED, and that is #2404's Option A (owner decision,
   * 1 Aug 2026). They used to be asserted as skipped, alongside `/api` and
   * `_next/static`, on the reasoning that a real image must not pay a nonce
   * mint. The reasoning did not survive measurement: the shorter lookahead is
   * marginally cheaper per request, the genuinely hot `_next/static` shape is
   * still excluded by its own alternative, and the exclusion was the reason an
   * asset-shaped URL could be answered with no policy of ours on it at all.
   *
   * `/favicon.ico` and `/logo.png` are here for a second reason: they were NAMED
   * carve-outs for files that do not exist (`public/` holds `branding/` and
   * `robots.txt`; the root layout points at `/branding/favicon.ico`), so they
   * excluded nothing and left two URL shapes exposed. If either file is ever
   * added, the filesystem serves it ahead of any rewrite.
   */
  it("now runs on the asset shapes it used to skip (#2404 Option A)", () => {
    for (const url of [
      "/favicon.ico",
      "/logo.png",
      "/branding/logo.png",
      "/branding/favicon.ico",
      "/gallery.svg",
      "/foo.png",
      "/foo.jpg",
      "/foo.jpeg",
      "/foo.gif",
      "/foo.webp",
      "/foo.ico",
      "/wp-content/uploads/x.jpg",
    ]) {
      expect(
        matches(url),
        `${url} must run the proxy, so its response carries a CSP header`,
      ).toBe(true);
    }
  });

  /**
   * The half of Option A that has to NOT change, and the reason
   * `isPublicWebsitePath()` is now an independent rule rather than a mirror of
   * the matcher string.
   *
   * The gate lives inside `proxy()`. Before Option A an asset shape never got
   * there; now every one of them does, and if the classifier called them website
   * paths a club mid-setup would answer a request for an image with the "Site
   * setup in progress" screen — a 503 HTML DOCUMENT, from the exact URL class
   * #2404 exists to answer without one. `setup-gate.ts` refuses them on its own
   * terms, and this is where the two facts are asserted together.
   */
  it("brings asset shapes inside the gate's reach without letting the gate claim them", () => {
    for (const url of [
      "/favicon.ico",
      "/logo.png",
      "/branding/logo.png",
      "/gallery.svg",
      "/wp-content/uploads/x.jpg",
    ]) {
      expect(matches(url), `${url} must run the proxy`).toBe(true);
      expect(
        isPublicWebsitePath(url),
        `${url} must not be gated: a 503 holding screen is a document`,
      ).toBe(false);
    }
  });

  it("does run on the explicitly listed /api matcher entries", () => {
    // The negative lookahead only governs the root matcher entry; the module
    // gate's own /api list must keep matching.
    expect(matches("/api/admin/waitlist")).toBe(true);
  });
});
