import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  listPublishedCmsPagePaths: vi.fn(),
  getConfiguredBookNowPagePath: vi.fn(),
  getWebsiteThemeRenderState: vi.fn(),
}));

vi.mock("@/lib/page-content-html", () => ({
  listPublishedCmsPagePaths: mocks.listPublishedCmsPagePaths,
}));

vi.mock("@/lib/book-now-config", () => ({
  getConfiguredBookNowPagePath: mocks.getConfiguredBookNowPagePath,
}));

vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: mocks.getWebsiteThemeRenderState,
}));

import {
  discoverWarmupRoutes,
  readPublicSiteOpenState,
  readRouteTableSnapshot,
  resolveReleaseIdentity,
} from "../warmup-discovery";

/**
 * Reading the target release's own build output and published pages (#2566).
 *
 * The fixture manifests below are the SHAPE of the real ones as
 * `scripts/ci/check-website-prerender-manifest.mjs` records them from a container
 * build of this branch.
 */

let distDir: string;

function writeManifests(
  prerender: unknown,
  appPaths: unknown = {
    "/(website)/page": "/",
    "/(website)/[...slug]/page": "/[...slug]",
    "/(website)/join/page": "/join",
    "/(website)/join/apply/page": "/join/apply",
    "/(website)/contact/page": "/contact",
    "/(website)/booking-requests/page": "/booking-requests",
    "/(website)/school-bookings/page": "/school-bookings",
    "/api/health/ready/route": "/api/health/ready",
  },
) {
  fs.writeFileSync(
    path.join(distDir, "prerender-manifest.json"),
    JSON.stringify(prerender),
  );
  fs.writeFileSync(
    path.join(distDir, "app-path-routes-manifest.json"),
    JSON.stringify(appPaths),
  );
}

const REAL_PRERENDER_MANIFEST = {
  version: 4,
  routes: {
    "/sitemap.xml": { initialRevalidateSeconds: false, dataRoute: null },
    "/_global-error": { initialRevalidateSeconds: false, dataRoute: null },
  },
  dynamicRoutes: {
    "/[...slug]": { routeRegex: "^/(.+?)(?:/)?$", dataRoute: null },
  },
};

beforeEach(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), "warmup-dist-"));
  mocks.listPublishedCmsPagePaths.mockResolvedValue(["/about"]);
  mocks.getConfiguredBookNowPagePath.mockResolvedValue({ state: "none" });
  mocks.getWebsiteThemeRenderState.mockResolvedValue({
    isComplete: true,
    readFailed: false,
  });
});

afterEach(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
  vi.clearAllMocks();
  delete process.env.RELEASE_ID;
  delete process.env.GIT_COMMIT_SHA;
});

describe("readRouteTableSnapshot", () => {
  it("reads what the build says is stored and what routes exist", () => {
    writeManifests(REAL_PRERENDER_MANIFEST);

    const result = readRouteTableSnapshot(distDir);

    expect("table" in result).toBe(true);
    if (!("table" in result)) return;
    expect(result.table.isrDynamicRoutes).toEqual([
      { pattern: "/[...slug]", routeRegex: "^/(.+?)(?:/)?$" },
    ]);
    expect(result.table.prebuiltRoutes).toEqual([
      { path: "/sitemap.xml", revalidates: false },
      { path: "/_global-error", revalidates: false },
    ]);
    expect(result.table.appRoutePatterns).toContain("/join/apply");
  });

  it("records a build-time route that revalidates as one with a store to verify", () => {
    // The slice-2 shape: `/` prerendered at build with a revalidate window.
    writeManifests({
      ...REAL_PRERENDER_MANIFEST,
      routes: {
        ...REAL_PRERENDER_MANIFEST.routes,
        "/": { initialRevalidateSeconds: 300, dataRoute: null },
      },
    });

    const result = readRouteTableSnapshot(distDir);

    expect("table" in result).toBe(true);
    if (!("table" in result)) return;
    expect(result.table.prebuiltRoutes).toContainEqual({
      path: "/",
      revalidates: true,
    });
  });

  it("fails closed when a manifest is missing, unparseable, or the wrong shape", () => {
    const missing = readRouteTableSnapshot(distDir);
    expect("problem" in missing && missing.problem).toContain(
      "prerender-manifest.json could not be read",
    );

    fs.writeFileSync(path.join(distDir, "prerender-manifest.json"), "{oops");
    fs.writeFileSync(path.join(distDir, "app-path-routes-manifest.json"), "{}");
    const broken = readRouteTableSnapshot(distDir);
    expect("problem" in broken && broken.problem).toContain(
      "not readable JSON",
    );

    writeManifests({ version: 4 });
    const shapeless = readRouteTableSnapshot(distDir);
    expect("problem" in shapeless && shapeless.problem).toContain(
      "missing its routes or dynamicRoutes",
    );

    writeManifests(REAL_PRERENDER_MANIFEST, {});
    const noRoutes = readRouteTableSnapshot(distDir);
    expect("problem" in noRoutes && noRoutes.problem).toContain(
      "lists no routes at all",
    );

    writeManifests({
      version: 4,
      routes: {},
      dynamicRoutes: { "/[...slug]": { dataRoute: null } },
    });
    const noRegex = readRouteTableSnapshot(distDir);
    expect("problem" in noRegex && noRegex.problem).toContain(
      "no usable route regex",
    );
  });
});

describe("discoverWarmupRoutes", () => {
  it("plans the critical routes plus the published CMS pages", async () => {
    writeManifests(REAL_PRERENDER_MANIFEST);
    mocks.listPublishedCmsPagePaths.mockResolvedValue(["/about", "/faq"]);

    const discovery = await discoverWarmupRoutes({ distDir });

    expect(discovery.plan.problems).toEqual([]);
    expect(discovery.plan.routes.map((route) => route.path)).toEqual([
      "/",
      "/join",
      "/join/apply",
      "/contact",
      "/booking-requests",
      "/school-bookings",
      "/about",
      "/faq",
    ]);
    expect(discovery.cmsPathsInSnapshot).toBe(2);
    expect(Date.parse(discovery.cmsSnapshotAt)).not.toBeNaN();
  });

  it("blocks when the build output cannot be read", async () => {
    const discovery = await discoverWarmupRoutes({ distDir });

    expect(discovery.plan.routes).toEqual([]);
    expect(discovery.plan.problems.join(" ")).toContain("could not be read");
  });

  it("blocks when the published-page read throws rather than pretending there are none", async () => {
    writeManifests(REAL_PRERENDER_MANIFEST);
    mocks.listPublishedCmsPagePaths.mockRejectedValue(new Error("db down"));

    const discovery = await discoverWarmupRoutes({ distDir });

    expect(discovery.plan.problems.join(" ")).toContain(
      "could not be read from the database",
    );
  });

  it("says the booking entry is UNKNOWN when the setting could not be read, not that there is none", async () => {
    // The misreport this replaces: the resolver fails open, so a failed settings read
    // arrived as `null` and the plan answered "Nothing public is missing" about a
    // critical public route it had never looked at.
    writeManifests(REAL_PRERENDER_MANIFEST);
    mocks.getConfiguredBookNowPagePath.mockResolvedValue({
      state: "unreadable",
      detail: "statement timeout",
    });

    const discovery = await discoverWarmupRoutes({ distDir });

    // Not blocking — the button itself fails open — but not an all-clear either.
    expect(discovery.plan.problems).toEqual([]);
    expect(discovery.plan.notes.join(" ")).not.toContain(
      "Nothing public is missing",
    );
    expect(discovery.plan.warnings.join(" ")).toContain(
      "could not establish whether there is a public booking entry page",
    );
    expect(discovery.plan.warnings.join(" ")).toContain("statement timeout");
  });

  it("treats a throw from the Book Now read the same way, rather than as no target", async () => {
    writeManifests(REAL_PRERENDER_MANIFEST);
    mocks.getConfiguredBookNowPagePath.mockRejectedValue(new Error("db down"));

    const discovery = await discoverWarmupRoutes({ distDir });

    expect(discovery.plan.problems).toEqual([]);
    expect(discovery.plan.warnings.join(" ")).toContain("db down");
    expect(discovery.plan.notes.join(" ")).not.toContain(
      "No public booking entry",
    );
  });

  it("promotes a configured Book Now page to a critical route", async () => {
    writeManifests(REAL_PRERENDER_MANIFEST);
    mocks.listPublishedCmsPagePaths.mockResolvedValue(["/about", "/how-to"]);
    mocks.getConfiguredBookNowPagePath.mockResolvedValue({
      state: "page",
      path: "/how-to",
    });

    const discovery = await discoverWarmupRoutes({ distDir });

    const bookNow = discovery.plan.routes.find(
      (route) => route.path === "/how-to",
    );
    expect(bookNow?.tier).toBe("critical");
    expect(bookNow?.source).toBe("book-now-target");
    expect(discovery.plan.warnings).toEqual([]);
  });
});

describe("readPublicSiteOpenState", () => {
  it("reports an open site, a pre-setup site, and an unreadable one differently", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      isComplete: true,
      readFailed: false,
    });
    await expect(readPublicSiteOpenState()).resolves.toEqual({ state: "open" });

    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      isComplete: false,
      readFailed: false,
    });
    await expect(readPublicSiteOpenState()).resolves.toEqual({
      state: "pre-setup",
    });

    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      isComplete: false,
      readFailed: true,
    });
    await expect(readPublicSiteOpenState()).resolves.toEqual({
      state: "unknown",
    });

    mocks.getWebsiteThemeRenderState.mockRejectedValue(new Error("no client"));
    await expect(readPublicSiteOpenState()).resolves.toEqual({
      state: "unknown",
    });
  });
});

describe("resolveReleaseIdentity", () => {
  it("matches the release identifier the deploy expects", () => {
    process.env.RELEASE_ID = "9aeef8e8d0011223344556677889900aabbccddee";

    expect(resolveReleaseIdentity(process.env.RELEASE_ID)).toEqual({
      state: "match",
    });
    // A short SHA still gives a real check rather than a false mismatch.
    expect(resolveReleaseIdentity("9aeef8e8")).toEqual({ state: "match" });
  });

  it("falls back to the commit SHA the knowledge bundle already ships", () => {
    process.env.GIT_COMMIT_SHA = "abcdef1234567890";

    expect(resolveReleaseIdentity("abcdef1234567890")).toEqual({
      state: "match",
    });
  });

  it("reports a mismatch with short forms, never the whole identifier", () => {
    process.env.RELEASE_ID = "1111111111111111111111111111111111111111";

    const result = resolveReleaseIdentity(
      "2222222222222222222222222222222222222222",
    );

    expect(result.state).toBe("mismatch");
    expect("detail" in result && result.detail).toContain("111111111111");
    expect("detail" in result && result.detail).not.toContain(
      "1111111111111111111111111111111111111111",
    );
  });

  it("separates 'the image has no identifier' from 'the deploy did not say'", () => {
    expect(resolveReleaseIdentity("abcdef1")).toEqual({
      state: "not-declared",
    });

    process.env.RELEASE_ID = "abcdef1234567";
    expect(resolveReleaseIdentity(null)).toEqual({ state: "not-checked" });
  });
});
