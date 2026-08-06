import { describe, expect, it } from "vitest";
import {
  DEFAULT_WARMUP_TOLERANCE,
  evaluateWarmup,
  type WarmupEvaluationInput,
} from "../warmup-evaluate";
import type { PlannedWarmupRoute } from "../warmup-route-policy";
import type { WarmupFailureKind, WarmupRouteResult } from "../warmup-run";

/**
 * The tiered pass/block rules (#2566), read against the owner's decision.
 *
 * Each case names the sentence it enforces, because this is the module where a
 * plausible-looking simplification changes what a production deploy is allowed to
 * do.
 */

function plan(
  tier: "critical" | "cms",
  path: string,
  cacheClass: PlannedWarmupRoute["cacheClass"] = "isr",
): PlannedWarmupRoute {
  return {
    path,
    tier,
    cacheClass,
    source: tier === "critical" ? "critical-list" : "published-cms-page",
    why: "test route",
  };
}

function warmed(route: PlannedWarmupRoute): WarmupRouteResult {
  return {
    route,
    rendered: true,
    cacheApplicable: route.cacheClass === "isr",
    cacheVerified: route.cacheClass === "isr",
    outcome: "warmed",
    httpStatus: 200,
    cacheHeader: route.cacheClass === "isr" ? "HIT" : null,
    requests: 2,
    durationMs: 50,
  };
}

function failing(
  route: PlannedWarmupRoute,
  kind: WarmupFailureKind = "server-error",
): WarmupRouteResult {
  return {
    route,
    rendered: false,
    cacheApplicable: route.cacheClass === "isr",
    cacheVerified: false,
    outcome: "failed",
    failure: { kind, detail: "the release answered HTTP 500" },
    httpStatus: 500,
    cacheHeader: null,
    requests: 1,
    durationMs: 50,
  };
}

function evaluate(overrides: Partial<WarmupEvaluationInput> = {}) {
  return evaluateWarmup({
    discoveryProblems: [],
    results: [],
    deadlineExpired: false,
    releaseIdentity: { state: "match" },
    ...overrides,
  });
}

function cmsRoutes(count: number): PlannedWarmupRoute[] {
  return Array.from({ length: count }, (_, index) =>
    plan("cms", `/page-${index}`),
  );
}

describe("evaluateWarmup", () => {
  it("passes when every critical route rendered and every stored page verified", () => {
    const critical = [
      plan("critical", "/", "render-only"),
      plan("critical", "/join", "render-only"),
    ];
    const cms = cmsRoutes(3);

    const evaluation = evaluate({
      results: [...critical, ...cms].map(warmed),
    });

    expect(evaluation.verdict).toBe("pass");
    expect(evaluation.blockingReasons).toEqual([]);
    expect(evaluation.counts.criticalDiscovered).toBe(2);
    expect(evaluation.counts.cmsCacheVerified).toBe(3);
  });

  it("blocks on ANY critical route failure", () => {
    const evaluation = evaluate({
      results: [
        failing(plan("critical", "/", "render-only")),
        ...cmsRoutes(20).map(warmed),
      ],
    });

    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons.join(" ")).toContain(
      "Critical route failed",
    );
  });

  it("blocks a critical stored route that rendered but was never confirmed stored", () => {
    const route = plan("critical", "/booking-info");
    const evaluation = evaluate({
      results: [
        { ...warmed(route), cacheVerified: false, cacheHeader: "MISS" },
      ],
    });

    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons.join(" ")).toContain(
      "never confirmed as stored",
    );
  });

  it("blocks when route discovery failed, whatever the requests said", () => {
    const evaluation = evaluate({
      discoveryProblems: ["the prerender manifest could not be read"],
      results: [plan("critical", "/", "render-only")].map(warmed),
    });

    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons[0]).toContain("Route discovery failed");
  });

  it("blocks when the container is not running the release being deployed", () => {
    const evaluation = evaluate({
      results: [plan("critical", "/", "render-only")].map(warmed),
      releaseIdentity: {
        state: "mismatch",
        detail: "expected abc1234, got def5678",
      },
    });

    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons.join(" ")).toContain(
      "not identify itself as the release being deployed",
    );
    expect(evaluation.systemicSignals.length).toBeGreaterThan(0);
  });

  it("warns, without blocking, when the release identity could not be checked", () => {
    for (const state of ["not-declared", "not-checked"] as const) {
      const evaluation = evaluate({
        results: [plan("critical", "/", "render-only")].map(warmed),
        releaseIdentity: { state },
      });

      expect(evaluation.verdict).toBe("pass");
      expect(evaluation.warnings.join(" ")).toContain("could not");
    }
  });

  it("tolerates ONE isolated CMS failure on a site with enough pages", () => {
    const cms = cmsRoutes(20);
    const evaluation = evaluate({
      results: [
        ...[plan("critical", "/", "render-only")].map(warmed),
        failing(cms[0]),
        ...cms.slice(1).map(warmed),
      ],
    });

    expect(evaluation.verdict).toBe("pass-with-warning");
    expect(evaluation.blockingReasons).toEqual([]);
    // "the failed path and response are recorded prominently"
    expect(evaluation.warnings.join(" ")).toContain("/page-0");
    expect(evaluation.warnings.join(" ")).toContain("HTTP 500");
  });

  it("blocks a SECOND CMS failure even on a large site (the count rule)", () => {
    const cms = cmsRoutes(100);
    const evaluation = evaluate({
      results: [
        ...[plan("critical", "/", "render-only")].map(warmed),
        failing(cms[0]),
        failing(cms[1]),
        ...cms.slice(2).map(warmed),
      ],
    });

    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons.join(" ")).toContain(
      "exceeds the tolerance",
    );
  });

  it("blocks one failure out of five, because BOTH conditions must hold", () => {
    // The consequence the owner asked for and DEPLOYMENT.md states: a club with
    // fewer than ten published pages tolerates none. 1 of 5 is 20%.
    const cms = cmsRoutes(5);
    const evaluation = evaluate({
      results: [
        ...[plan("critical", "/", "render-only")].map(warmed),
        failing(cms[0]),
        ...cms.slice(1).map(warmed),
      ],
    });

    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons.join(" ")).toContain("10%");
  });

  it("respects a deliberately widened tolerance, and records that it was widened", () => {
    const cms = cmsRoutes(5);
    const evaluation = evaluate({
      results: [
        ...[plan("critical", "/", "render-only")].map(warmed),
        failing(cms[0]),
        ...cms.slice(1).map(warmed),
      ],
      tolerance: { maxFailedCmsRoutes: 1, maxFailedCmsPercent: 25 },
    });

    expect(evaluation.verdict).toBe("pass-with-warning");
    expect(evaluation.warnings.join(" ")).toContain("tolerance was widened");
  });

  it("blocks when no stored page could be verified at all (systemic)", () => {
    const cms = cmsRoutes(4);
    const evaluation = evaluate({
      results: [
        ...[plan("critical", "/", "render-only")].map(warmed),
        ...cms.map((route) => ({
          ...warmed(route),
          cacheVerified: false,
          cacheHeader: "MISS",
        })),
      ],
    });

    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.systemicSignals.join(" ")).toContain(
      "not populating its page cache at all",
    );
  });

  it("blocks when every CMS page failed, however large the tolerance", () => {
    const cms = cmsRoutes(30);
    const evaluation = evaluate({
      results: [
        ...[plan("critical", "/", "render-only")].map(warmed),
        ...cms.map((route) => failing(route)),
      ],
      tolerance: { maxFailedCmsRoutes: 100, maxFailedCmsPercent: 100 },
    });

    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.systemicSignals.join(" ")).toContain(
      "release-wide fault",
    );
  });

  it("treats a nonce mismatch and an unexpected cache header as systemic on one page", () => {
    for (const kind of ["nonce-mismatch", "unexpected-cache-header"] as const) {
      const cms = cmsRoutes(30);
      const evaluation = evaluate({
        results: [
          ...[plan("critical", "/", "render-only")].map(warmed),
          failing(cms[0], kind),
          ...cms.slice(1).map(warmed),
        ],
      });

      expect(evaluation.verdict).toBe("blocked");
      expect(evaluation.systemicSignals.join(" ")).toContain(
        "property of the whole release",
      );
    }
  });

  it("does not count a page unpublished mid-run as a failure, but does report it", () => {
    const cms = cmsRoutes(3);
    const evaluation = evaluate({
      results: [
        ...[plan("critical", "/", "render-only")].map(warmed),
        {
          ...warmed(cms[0]),
          outcome: "unpublished-during-warmup",
          rendered: false,
          cacheApplicable: false,
          cacheVerified: false,
          httpStatus: 404,
        },
        ...cms.slice(1).map(warmed),
      ],
    });

    expect(evaluation.verdict).toBe("pass");
    expect(evaluation.counts.cmsFailed).toBe(0);
    expect(evaluation.counts.cmsUnpublishedDuringWarmup).toBe(1);
    expect(evaluation.warnings.join(" ")).toContain(
      "unpublished between discovery",
    );
  });

  it("reports an unpublished Book Now target as a prominent warning, and lets the deploy through", () => {
    // The promoted Book Now target is the one CMS page at critical tier, so an admin's
    // timing used to block a production cutover on a page that was answering
    // correctly. Nothing public is broken in that state — the button falls back — but
    // the admin needs to know it fell back.
    const bookNow: PlannedWarmupRoute = {
      path: "/how-booking-works",
      tier: "critical",
      cacheClass: "isr",
      source: "book-now-target",
      why: "the club's configured booking entry",
    };

    const evaluation = evaluate({
      results: [
        ...[plan("critical", "/", "render-only")].map(warmed),
        {
          ...warmed(bookNow),
          outcome: "unpublished-during-warmup",
          rendered: false,
          cacheApplicable: false,
          cacheVerified: false,
          httpStatus: 404,
        },
      ],
    });

    expect(evaluation.verdict).toBe("pass");
    expect(evaluation.blockingReasons).toEqual([]);
    expect(evaluation.counts.criticalUnpublishedDuringWarmup).toBe(1);
    expect(evaluation.warnings.join(" ")).toContain(
      "fallen back to the member booking flow",
    );
    expect(evaluation.warnings.join(" ")).toContain("Admin > Page Content");
  });

  it("surfaces a discovery warning prominently without blocking", () => {
    const evaluation = evaluate({
      results: [plan("critical", "/", "render-only")].map(warmed),
      discoveryWarnings: [
        "this club's Book Now setting could not be read, so the gate could not establish whether there is a public booking entry page to warm",
      ],
    });

    expect(evaluation.verdict).toBe("pass");
    expect(evaluation.warnings.join(" ")).toContain(
      "could not establish whether there is a public booking entry page",
    );
  });

  it("blocks when nothing was warmed at all", () => {
    const evaluation = evaluate({ results: [] });

    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons.join(" ")).toContain(
      "No critical public route was warmed",
    );
  });

  it("warns when the overall deadline expired", () => {
    const evaluation = evaluate({
      results: [plan("critical", "/", "render-only")].map(warmed),
      deadlineExpired: true,
    });

    expect(evaluation.warnings.join(" ")).toContain("deadline expired");
  });

  it("applies the tolerance to every non-critical tier it counts, not just to \"cms\"", () => {
    // Latent by construction today — `tier` is a two-value union — so the third value
    // is forced in. Counting bucketed everything non-critical into `cms*` while the
    // tolerance filtered on `tier === "cms"`, so a failure on a future non-critical
    // public tier would have been counted, then skipped by the arithmetic: no warning,
    // no blocking reason, verdict `pass`, and a failed public page reported nowhere.
    const futureTier = {
      path: "/history",
      tier: "public-fixed",
      cacheClass: "prebuilt",
      source: "critical-list",
      why: "a non-critical fixed public page a later change adds",
    } as unknown as PlannedWarmupRoute;

    const evaluation = evaluate({
      results: [
        ...[plan("critical", "/", "render-only")].map(warmed),
        failing(futureTier),
      ],
    });

    expect(evaluation.counts.cmsFailed).toBe(1);
    expect(evaluation.warnings.join(" ")).toContain("/history");
    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons.join(" ")).toContain(
      "exceeds the tolerance",
    );
  });

  it("keeps the owner's conservative default", () => {
    expect(DEFAULT_WARMUP_TOLERANCE).toEqual({
      maxFailedCmsRoutes: 1,
      maxFailedCmsPercent: 10,
    });
  });
});
