import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
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
  it("matches root page requests but skips API/static/prefetch requests", () => {
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
    expect(
      unstable_doesProxyMatch({
        config,
        headers: { purpose: "prefetch" },
        nextConfig: {},
        url: "/",
      })
    ).toBe(false);
  });

  it("emits a single enforced CSP header with a per-request nonce and no report-only header", async () => {
    const response = await proxy(new NextRequest("https://example.org/"));
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

  it("generates a different nonce per request", async () => {
    const a = await proxy(new NextRequest("https://example.org/"));
    const b = await proxy(new NextRequest("https://example.org/"));
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
  it("matcher runs for every feature-gated route prefix", () => {
    const gatedPrefixes = FEATURE_ROUTE_RULES.flatMap(
      (rule) => rule.prefixes ?? [],
    );

    for (const prefix of gatedPrefixes) {
      expect(
        unstable_doesProxyMatch({ config, nextConfig: {}, url: prefix }),
        `middleware matcher must run for ${prefix} (feature-gated route)`,
      ).toBe(true);
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

describe("anonymous public-page cache headers (#2322)", () => {
  function requestWithCookie(url: string, cookie?: string, method = "GET") {
    return new NextRequest(url, {
      method,
      ...(cookie ? { headers: { cookie } } : {}),
    });
  }

  it("marks an anonymous GET of an allow-listed page cacheable by shared caches", async () => {
    const response = await proxy(new NextRequest("https://example.org/"));

    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
    );
    // Without Vary: Cookie a shared cache would hand the stored anonymous
    // render to a member who has a session.
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
    ).toBe("public, max-age=60, s-maxage=60, stale-while-revalidate=300");
  });

  it.each([
    ["RSC", "RSC"],
    ["Next-Router-State-Tree", "Next-Router-State-Tree"],
    ["Next-Router-Prefetch", "Next-Router-Prefetch"],
    ["Next-Router-Segment-Prefetch", "Next-Router-Segment-Prefetch"],
  ])("never caches a flight request carrying %s (#2322)", (_label, header) => {
    // A flight response is a different body under the SAME URL. On stable Next
    // builds the RSC-header validation is off, so a crafted `RSC: 1` GET would
    // otherwise be handed a cacheable flight body under the HTML's cache key.
    const request = new NextRequest("https://example.org/", {
      headers: { [header]: "1" },
    });

    expect(getAnonymousPageCacheControl(request)).toBeNull();
  });

  it("still caches a plain document request with no flight headers", () => {
    expect(
      getAnonymousPageCacheControl(new NextRequest("https://example.org/")),
    ).toBe("public, max-age=60, s-maxage=60, stale-while-revalidate=300");
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
      "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
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
});
