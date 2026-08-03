import { describe, expect, it } from "vitest";
import { DEFAULT_WARMUP_TOLERANCE, evaluateWarmup } from "../warmup-evaluate";
import type { PlannedWarmupRoute } from "../warmup-route-policy";
import {
  buildBlockedWarmupReport,
  buildSkippedWarmupReport,
  buildWarmupReport,
  renderWarmupReportText,
  WARMUP_VERDICT_SENTINEL,
} from "../warmup-report";
import type { WarmupRouteResult } from "../warmup-run";

/**
 * The operator-facing summary (#2566).
 *
 * The sentinel line is a contract with `scripts/run-production-blue-green-deploy.sh`
 * — it greps for exactly this — so it is asserted here rather than left to a
 * reviewer to notice.
 */

const home: PlannedWarmupRoute = {
  path: "/",
  tier: "critical",
  cacheClass: "render-only",
  source: "critical-list",
  why: "the home page",
};

const faq: PlannedWarmupRoute = {
  path: "/faq",
  tier: "cms",
  cacheClass: "isr",
  source: "published-cms-page",
  why: "a published page",
};

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
    durationMs: 40,
  };
}

function report(
  results: WarmupRouteResult[],
  discoveryWarnings: readonly string[] = [],
) {
  const evaluation = evaluateWarmup({
    discoveryProblems: [],
    discoveryWarnings,
    results,
    deadlineExpired: false,
    releaseIdentity: { state: "match" },
  });

  return buildWarmupReport({
    evaluation,
    plan: {
      routes: results.map((result) => result.route),
      excluded: [
        { path: "/lodge/history", reason: "not an address the website serves" },
      ],
      problems: [],
      warnings: discoveryWarnings,
      notes: ["No public booking entry route was warmed."],
    },
    run: {
      results,
      deadlineExpired: false,
      durationMs: 4_200,
      peakConcurrency: 3,
    },
    serviceRole: "web-green",
    releaseIdentity: { state: "match" },
    publicHost: "bookings.example.nz",
    origin: "http://127.0.0.1:3000",
    cmsSnapshotAt: "2026-08-03T09:00:00.000Z",
    concurrencyLimit: 3,
  });
}

describe("renderWarmupReportText", () => {
  it("reports everything the decision asks for, and ends in the verdict sentinel", () => {
    const text = renderWarmupReportText(report([warmed(home), warmed(faq)]));

    expect(text).toContain("Pre-cutover warm-up gate: web-green");
    expect(text).toContain("confirmed as the release being deployed");
    expect(text).toContain("bookings.example.nz");
    expect(text).toContain("http://127.0.0.1:3000 (this container only)");
    expect(text).toContain("2026-08-03T09:00:00.000Z");
    expect(text).toContain("4.2s over 4 request(s), at most 3 at a time");
    expect(text).toContain("critical routes");
    expect(text).toContain(
      "published CMS pages   : 1 discovered, 1 rendered, 1 of 1 confirmed stored",
    );
    expect(text).toContain("at most 1 failed CMS page(s) AND at most 10%");
    expect(text).toContain("/lodge/history");
    expect(text.trimEnd().endsWith(`${WARMUP_VERDICT_SENTINEL}: pass`)).toBe(
      true,
    );
  });

  it("puts a failed route and its HTTP result where nobody can miss them", () => {
    const failed: WarmupRouteResult = {
      route: faq,
      rendered: true,
      cacheApplicable: true,
      cacheVerified: false,
      outcome: "failed",
      failure: {
        kind: "cache-not-stored",
        detail: "repeated requests never reported the page as stored",
      },
      httpStatus: 200,
      cacheHeader: "MISS",
      requests: 3,
      durationMs: 90,
    };

    const text = renderWarmupReportText(report([warmed(home), failed]));

    expect(text).toContain("FAILED ROUTES (1):");
    expect(text).toContain("! /faq [cms] cache-not-stored");
    expect(text).toContain("HTTP: 200; cache: NOT confirmed stored (MISS)");
    expect(text).toContain("CUTOVER BLOCKED:");
    expect(text.trimEnd().endsWith(`${WARMUP_VERDICT_SENTINEL}: blocked`)).toBe(
      true,
    );
  });

  it("surfaces a discovery gap as a warning rather than a quiet note", () => {
    // The Book Now setting being UNREADABLE is the case this covers, and the operator
    // report is the only place they would ever see it. The old shape collapsed a failed
    // read into "no target" and printed "Nothing public is missing" — an all-clear on a
    // critical public route the gate had never established the existence of. A gap in
    // what was proved has to read as a gap.
    const text = renderWarmupReportText(
      report(
        [warmed(home), warmed(faq)],
        [
          "This club's Book Now setting could not be read (statement timeout), so the gate could not establish whether there is a public booking entry page to warm.",
        ],
      ),
    );

    expect(text).toContain("Book Now setting could not be read");
    expect(text).toContain("statement timeout");
    // Still a pass — the button fails open, so this is not a reason to refuse a
    // release — but a pass that says out loud what it did not check.
    expect(text.trimEnd().endsWith(`${WARMUP_VERDICT_SENTINEL}: pass`)).toBe(
      true,
    );
  });

  it("renders the skipped and could-not-start reports with a readable reason", () => {
    const base = {
      serviceRole: "web-blue",
      publicHost: "bookings.example.nz",
      origin: "http://127.0.0.1:3000",
      tolerance: DEFAULT_WARMUP_TOLERANCE,
    };

    const skipped = renderWarmupReportText(
      buildSkippedWarmupReport(
        "the site is still behind the holding screen",
        base,
      ),
    );
    expect(skipped).toContain(
      "SKIPPED: the site is still behind the holding screen",
    );
    expect(
      skipped.trimEnd().endsWith(`${WARMUP_VERDICT_SENTINEL}: skipped`),
    ).toBe(true);

    const blocked = renderWarmupReportText(
      buildBlockedWarmupReport(
        "NEXTAUTH_URL is not set in this container",
        base,
      ),
    );
    expect(blocked).toContain("CUTOVER BLOCKED:");
    expect(blocked).toContain("NEXTAUTH_URL is not set");
    expect(blocked).not.toContain("SKIPPED:");
    expect(
      blocked.trimEnd().endsWith(`${WARMUP_VERDICT_SENTINEL}: blocked`),
    ).toBe(true);
  });
});
