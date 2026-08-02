import { describe, expect, it } from "vitest";

import { auditPrerenderManifest } from "./check-website-prerender-manifest.mjs";

/**
 * Unit coverage for the pure half of the prerender-manifest gate (#2352 slice 1).
 *
 * The shape below is the one a real `docker build --target builder` of this branch
 * produced, copied out of the image rather than imagined: `dynamicRoutes` held
 * exactly `/[...slug]` and `routes` held Next's own error shell plus the sitemap.
 */
function manifest(overrides = {}) {
  return {
    version: 4,
    routes: { "/_global-error": {}, "/sitemap.xml": {} },
    dynamicRoutes: { "/[...slug]": {} },
    notFoundRoutes: [],
    ...overrides,
  };
}

describe("auditPrerenderManifest", () => {
  it("passes the shape #2352 slice 1 ships", () => {
    expect(auditPrerenderManifest(manifest())).toEqual([]);
  });

  it("fails when the CMS catch-all is no longer cached at all", () => {
    // The silent regression this file exists for: a component under (website)
    // reading auth()/cookies()/headers() opts the route out with no other symptom.
    const problems = auditPrerenderManifest(manifest({ dynamicRoutes: {} }));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/[...slug]");
    expect(problems[0]).toContain("full-route cache");
  });

  it("fails when a held-back website route is prerendered at build time", () => {
    const problems = auditPrerenderManifest(
      manifest({ routes: { "/_global-error": {}, "/sitemap.xml": {}, "/join": {} } }),
    );

    expect(problems.some((p) => p.includes("/join") && p.includes("BUILD"))).toBe(
      true,
    );
  });

  it("fails when a token-bearing route becomes on-demand generated and stored", () => {
    const problems = auditPrerenderManifest(
      manifest({
        dynamicRoutes: { "/[...slug]": {}, "/join/verify/[token]": {} },
      }),
    );

    expect(
      problems.some(
        (p) => p.includes("/join/verify/[token]") && p.includes("STORED"),
      ),
    ).toBe(true);
  });

  it("fails on a NEW build-time prerendered route rather than accepting it", () => {
    const problems = auditPrerenderManifest(
      manifest({
        routes: { "/_global-error": {}, "/sitemap.xml": {}, "/some-new-page": {} },
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/some-new-page");
    expect(problems[0]).toContain("ALLOWED_BUILD_TIME_ROUTES");
  });

  it("treats an empty manifest as broken, not as clean", () => {
    expect(auditPrerenderManifest({}).length).toBeGreaterThan(0);
  });

  it("reports every problem at once rather than stopping at the first", () => {
    const problems = auditPrerenderManifest({
      routes: { "/join": {}, "/contact": {} },
      dynamicRoutes: {},
    });

    // Missing catch-all, two build-time website routes, and both of those are also
    // outside the allowlist.
    expect(problems.length).toBe(5);
  });
});
