import { describe, expect, it } from "vitest";
import {
  buildWarmupPlan,
  classifyWarmupRoute,
  CRITICAL_PUBLIC_ROUTES,
  warmupPathRejection,
  type CriticalRouteDeclaration,
  type RouteTableSnapshot,
} from "../warmup-route-policy";

/**
 * Route discovery for the pre-cutover warm-up gate (#2566).
 *
 * The route table below is the SHAPE of a real one, and the shape is not invented:
 * `scripts/ci/check-website-prerender-manifest.mjs` records that a container build
 * of this branch produced `dynamicRoutes: ["/[...slug]"]` and
 * `routes: ["/_global-error", "/sitemap.xml"]`, with every other app route dynamic.
 * The regex is Next's own form for a one-or-more catch-all.
 */
const CATCH_ALL_REGEX = "^/(.+?)(?:/)?$";

function routeTable(
  overrides: Partial<RouteTableSnapshot> = {},
): RouteTableSnapshot {
  return {
    appRoutePatterns: [
      "/",
      "/[...slug]",
      "/contact",
      "/join",
      "/join/apply",
      "/join/[code]",
      "/join/verify/[token]",
      "/hut-leader-instructions",
      "/login",
      "/dashboard",
      "/admin/page-content",
      "/api/health/ready",
      "/sitemap.xml",
      ...(overrides.appRoutePatterns ?? []),
    ],
    prebuiltRoutes: overrides.prebuiltRoutes ?? [
      { path: "/_global-error", revalidates: false },
      { path: "/sitemap.xml", revalidates: false },
    ],
    isrDynamicRoutes: overrides.isrDynamicRoutes ?? [
      { pattern: "/[...slug]", routeRegex: CATCH_ALL_REGEX },
    ],
  };
}

describe("warmupPathRejection", () => {
  it("accepts the ordinary public shapes", () => {
    for (const path of ["/", "/about", "/join/apply", "/trips/2026/spring"]) {
      expect(warmupPathRejection(path)).toBeNull();
    }
  });

  it("refuses external and protocol-relative URLs", () => {
    expect(warmupPathRejection("https://evil.example/steal")).toBe(
      "external or protocol-relative URL",
    );
    expect(warmupPathRejection("//evil.example/steal")).toBe(
      "external or protocol-relative URL",
    );
    expect(warmupPathRejection("javascript:alert(1)")).toBe(
      "external or protocol-relative URL",
    );
  });

  it("refuses query-string and fragment variants, so one address is warmed once", () => {
    expect(warmupPathRejection("/about?utm_source=x")).toBe(
      "query-string variant",
    );
    expect(warmupPathRejection("/about#section")).toBe("fragment variant");
  });

  it("refuses traversal, malformed encodings and control characters", () => {
    expect(warmupPathRejection("/../etc/passwd")).toBe("path traversal");
    expect(warmupPathRejection("/a/./b")).toBe("path traversal");
    expect(warmupPathRejection("/about%zz")).toBe("malformed percent-encoding");
    expect(warmupPathRejection("/about%2e%2e%2fadmin")).toBe(
      "malformed path once decoded",
    );
    expect(warmupPathRejection("/about page")).toContain("malformed path");
    expect(warmupPathRejection("/about\\admin")).toContain("malformed path");
    expect(warmupPathRejection("/about%00")).toContain("malformed path");
  });

  it("refuses a relative path and an empty one", () => {
    expect(warmupPathRejection("about")).toBe("not an absolute path");
    expect(warmupPathRejection("")).toBe("empty path");
  });

  it("keeps an unusual but legal slug", () => {
    // A percent-encoded, non-ASCII or hyphen-heavy slug is legal and must survive:
    // Next matches the RAW pathname, so the gate has to ask for it as stored.
    expect(warmupPathRejection("/te-reo-m%C4%81ori")).toBeNull();
    expect(warmupPathRejection("/committee-2026-27")).toBeNull();
  });
});

describe("classifyWarmupRoute", () => {
  it("reads the CMS catch-all's addresses as stored", () => {
    expect(classifyWarmupRoute("/about", routeTable())).toBe("isr");
    expect(classifyWarmupRoute("/trips/2026", routeTable())).toBe("isr");
  });

  it("keeps a literal route per-request even when the catch-all's regex matches it", () => {
    // The precedence that matters: `/join/apply` matches the catch-all regex, and
    // Next serves the static route. Classifying it as stored would make the gate
    // demand a cache hit that can never come.
    expect(new RegExp(CATCH_ALL_REGEX).test("/join/apply")).toBe(true);
    expect(classifyWarmupRoute("/join/apply", routeTable())).toBe(
      "render-only",
    );
    expect(classifyWarmupRoute("/join", routeTable())).toBe("render-only");
    expect(classifyWarmupRoute("/contact", routeTable())).toBe("render-only");
  });

  it("separates build-time HTML that revalidates from HTML frozen for the release", () => {
    expect(classifyWarmupRoute("/sitemap.xml", routeTable())).toBe("prebuilt");
    expect(
      classifyWarmupRoute(
        "/",
        routeTable({ prebuiltRoutes: [{ path: "/", revalidates: true }] }),
      ),
    ).toBe("isr");
  });

  it("reads a dynamic route that is not stored as per-request", () => {
    expect(
      classifyWarmupRoute(
        "/join/some-code",
        routeTable({ isrDynamicRoutes: [] }),
      ),
    ).toBe("render-only");
  });

  it("reports an address no route claims", () => {
    // Only reachable for a release with NO catch-all: while `/[...slug]` is in the
    // route table it claims every unclaimed address, which is the whole point of a
    // catch-all. Asserted anyway, because the classifier must not answer
    // "render-only" for an address nothing serves — that would let a critical route
    // deleted from a future release pass discovery.
    expect(
      classifyWarmupRoute("/anything", {
        appRoutePatterns: ["/", "/contact"],
        prebuiltRoutes: [],
        isrDynamicRoutes: [],
      }),
    ).toBe("unrouted");
  });
});

describe("buildWarmupPlan", () => {
  it("discovers the critical list plus every published CMS page, once each", () => {
    const plan = buildWarmupPlan({
      table: routeTable(),
      cmsPaths: ["/about", "/faq", "/about/", "/about"],
      bookNowPagePath: null,
    });

    expect(plan.problems).toEqual([]);
    expect(plan.routes.map((route) => route.path)).toEqual([
      "/",
      "/join",
      "/join/apply",
      "/contact",
      "/about",
      "/faq",
    ]);
    // Critical first, so the overall deadline cannot leave a blocking route
    // unattempted while a content page was warmed instead.
    expect(
      plan.routes.slice(0, 4).every((route) => route.tier === "critical"),
    ).toBe(true);
    expect(plan.routes.slice(4).every((route) => route.tier === "cms")).toBe(
      true,
    );
    expect(
      plan.routes.slice(4).every((route) => route.cacheClass === "isr"),
    ).toBe(true);
  });

  it("says plainly when there is no public booking entry to warm", () => {
    const plan = buildWarmupPlan({
      table: routeTable(),
      cmsPaths: [],
      bookNowPagePath: null,
    });

    expect(plan.notes.join(" ")).toContain("No public booking entry route");
  });

  it("promotes the configured Book Now page to a critical route", () => {
    const plan = buildWarmupPlan({
      table: routeTable(),
      cmsPaths: ["/about", "/booking-info"],
      bookNowPagePath: "/booking-info",
    });

    const bookNow = plan.routes.find((route) => route.path === "/booking-info");
    expect(bookNow?.tier).toBe("critical");
    expect(bookNow?.source).toBe("book-now-target");
    // And it appears exactly once, not twice with two tiers.
    expect(
      plan.routes.filter((route) => route.path === "/booking-info"),
    ).toHaveLength(1);
  });

  it("warns rather than blocks when the Book Now target is not servable", () => {
    const plan = buildWarmupPlan({
      table: routeTable(),
      cmsPaths: ["/about"],
      bookNowPagePath: "/lodge/history",
    });

    expect(plan.problems).toEqual([]);
    expect(plan.excluded.map((entry) => entry.path)).toContain(
      "/lodge/history",
    );
    expect(plan.notes.join(" ")).toContain(
      "falls back to the member booking flow",
    );
  });

  it("excludes every address the public website does not serve as a content page", () => {
    const plan = buildWarmupPlan({
      table: routeTable(),
      cmsPaths: [
        "/admin/secrets",
        "/dashboard/nope",
        "/api/health/ready",
        "/login",
        "/hut-leader-instructions",
        "/robots.txt",
        "https://evil.example/x",
        "/../escape",
      ],
      bookNowPagePath: null,
    });

    expect(plan.routes.filter((route) => route.tier === "cms")).toEqual([]);
    expect(plan.excluded).toHaveLength(8);
    expect(plan.problems).toEqual([]);
  });

  it("blocks when a critical route's declared render mode is not what the build says", () => {
    const declarations: CriticalRouteDeclaration[] = [
      { path: "/", expected: "isr", why: "home page" },
    ];

    const plan = buildWarmupPlan({
      table: routeTable(),
      criticalRoutes: declarations,
      cmsPaths: [],
      bookNowPagePath: null,
    });

    expect(plan.problems.join(" ")).toContain('is declared "isr"');
    expect(plan.problems.join(" ")).toContain(
      'build output says "render-only"',
    );
    expect(plan.routes).toEqual([]);
  });

  it("blocks when a critical route is renamed out of the release", () => {
    // A page removed from `(website)` stops being a literal route, so the CMS
    // catch-all claims its address and the build then calls it stored. That
    // disagrees with the declaration, which is how the rename reaches an operator
    // rather than a 404 reaching a visitor.
    const plan = buildWarmupPlan({
      table: routeTable(),
      criticalRoutes: [
        { path: "/joining", expected: "render-only", why: "a renamed page" },
      ],
      cmsPaths: [],
      bookNowPagePath: null,
    });

    expect(plan.problems.join(" ")).toContain('is declared "render-only"');
    expect(plan.problems.join(" ")).toContain('build output says "isr"');
  });

  it("blocks when a critical route is claimed by nothing at all", () => {
    const plan = buildWarmupPlan({
      table: {
        appRoutePatterns: ["/", "/contact"],
        prebuiltRoutes: [],
        isrDynamicRoutes: [],
      },
      criticalRoutes: [
        { path: "/join", expected: "render-only", why: "a deleted page" },
      ],
      cmsPaths: [],
      bookNowPagePath: null,
    });

    expect(plan.problems.join(" ")).toContain("claimed by no route");
  });

  it("blocks when the CMS catch-all has stopped being a stored route", () => {
    // The silent regression #2352 slice 1 exists to prevent: the pages still
    // render, so a 200 checker sees nothing, and every visit pays a cold render.
    const plan = buildWarmupPlan({
      table: routeTable({ isrDynamicRoutes: [] }),
      cmsPaths: ["/about"],
      bookNowPagePath: null,
    });

    expect(plan.problems.join(" ")).toContain(
      "no longer configured for incremental static regeneration",
    );
  });

  it("blocks when no critical route survives discovery", () => {
    const plan = buildWarmupPlan({
      table: routeTable(),
      criticalRoutes: [],
      cmsPaths: ["/about"],
      bookNowPagePath: null,
    });

    expect(plan.problems.join(" ")).toContain(
      "No critical public route survived",
    );
  });

  it("blocks on a build regex it cannot use", () => {
    const plan = buildWarmupPlan({
      table: routeTable({
        isrDynamicRoutes: [
          { pattern: "/[...slug]", routeRegex: "^/(unclosed" },
        ],
      }),
      cmsPaths: [],
      bookNowPagePath: null,
    });

    expect(plan.problems.join(" ")).toContain("unusable route regex");
  });
});

describe("CRITICAL_PUBLIC_ROUTES", () => {
  it("names the journeys the owner's decision requires", () => {
    expect(CRITICAL_PUBLIC_ROUTES.map((route) => route.path)).toEqual([
      "/",
      "/join",
      "/join/apply",
      "/contact",
    ]);
  });

  it("gives every entry a reason an operator can read", () => {
    for (const route of CRITICAL_PUBLIC_ROUTES) {
      expect(route.why.length).toBeGreaterThan(20);
    }
  });

  it("holds only addresses this release's public website can serve", () => {
    const plan = buildWarmupPlan({
      table: routeTable(),
      cmsPaths: [],
      bookNowPagePath: null,
    });

    expect(plan.problems).toEqual([]);
    expect(plan.routes).toHaveLength(CRITICAL_PUBLIC_ROUTES.length);
  });
});
