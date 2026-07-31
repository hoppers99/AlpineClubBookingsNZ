import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Not ready yet" until site setup is complete (#2420).
 *
 * The defect: while `ClubTheme.completedAt IS NULL`, `(website)/layout.tsx`
 * returns its holding screen instead of `{children}`, the page component never
 * runs, and EVERY public address — real page, typo, and bot probe alike —
 * answers `200 OK`. Search engines are told a dead address is fine and
 * monitoring cannot tell an unconfigured site from a working one.
 *
 * Both halves of the contract are pinned here, and the second is as load-bearing
 * as the first:
 *  - with setup incomplete, every public-website address is 503 with the holding
 *    screen, and the admin area / API / setup wizard / login are untouched, so
 *    an operator part-way through setup can still finish it;
 *  - with setup complete, the gate is inert and behaviour is exactly as before —
 *    a change that 503s a live club's website would be far worse than the bug.
 */

const mocks = vi.hoisted(() => ({
  themeState: vi.fn(),
  clubIdentity: vi.fn(),
  emailSettings: vi.fn(),
}));

vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: mocks.themeState,
}));
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentity: mocks.clubIdentity,
}));
vi.mock("@/lib/email-message-settings", () => ({
  loadEmailMessageSettings: mocks.emailSettings,
}));

import {
  getSetupInProgressResponse,
  isPublicWebsitePath,
  NON_WEBSITE_ROOT_SEGMENTS,
  resetSetupGateCache,
  SETUP_STATE_TTL_MS,
} from "@/lib/setup-gate";
import {
  SETUP_IN_PROGRESS_COPY,
  SETUP_IN_PROGRESS_RETRY_AFTER_SECONDS,
} from "@/lib/setup-in-progress-screen";
import { CSP_HEADER, SECURITY_HEADERS } from "@/lib/csp";
import proxy from "@/proxy";

const CLUB_NAME = "Example Alpine Club";
const CONTACT_EMAIL = "office@example.org";

function setupIncomplete() {
  mocks.themeState.mockResolvedValue({
    isComplete: false,
    css: ":root{--brand-gold:#c8a227}",
  });
}

function setupComplete() {
  mocks.themeState.mockResolvedValue({
    isComplete: true,
    css: ":root{--brand-gold:#c8a227}",
  });
}

function request(url: string, init?: { method?: string }) {
  return new NextRequest(`https://example.org${url}`, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSetupGateCache();
  mocks.clubIdentity.mockResolvedValue({ name: CLUB_NAME });
  mocks.emailSettings.mockResolvedValue({
    clubName: CLUB_NAME,
    contactEmail: CONTACT_EMAIL,
  });
  setupComplete();
});

/**
 * The addresses the issue measured, plus the two shapes that matter most either
 * side of the fix: a real published page and the site root.
 */
const publicWebsiteUrls = [
  "/",
  "/about",
  "/contact",
  "/join/membership",
  "/hut-leader-instructions",
  "/definitely-missing",
  "/wp-admin/setup-config.php",
  "/.env",
  // Not the admin area: Next routing is case-sensitive, so this is an unmatched
  // website address and must be gated like any other.
  "/Admin/nope",
];

/**
 * Everything an operator part-way through setup still needs, plus the machine
 * surfaces. `/api/*` is listed even though the proxy matcher already drops it —
 * the gate must refuse it on its own so `api/[[...unmatched]]` (#2405) keeps
 * answering JSON 404, and the module gate keeps its verb-by-verb parity with
 * that route, identically in both setup states. Bare `/api` and `/api/` are
 * included because #2405 moved that route to an OPTIONAL catch-all to claim
 * them, and the gate must not take them back.
 */
const exemptUrls = [
  "/admin",
  "/admin/site-style",
  "/admin/setup",
  "/api",
  "/api/",
  "/api/admin/site-style",
  "/api/definitely-missing",
  "/login",
  "/forgot-password",
  "/reset-password/some-token",
  "/dashboard",
  "/bookings",
  "/finance",
  "/lodge/kiosk",
  "/display",
  "/robots.txt",
  "/sitemap.xml",
  "/_next/static/chunks/main.js",
];

describe("which addresses the setup gate covers", () => {
  it.each(publicWebsiteUrls)("treats %s as a public-website address", (url) => {
    expect(isPublicWebsitePath(url)).toBe(true);
  });

  it.each(exemptUrls)("leaves %s outside the gate", (url) => {
    expect(isPublicWebsitePath(url)).toBe(false);
  });

  it("ignores a trailing slash", () => {
    expect(isPublicWebsitePath("/about/")).toBe(true);
    expect(isPublicWebsitePath("/admin/")).toBe(false);
  });

  /**
   * The exemption list is a DENY list because `(website)/[...slug]` claims every
   * URL no other route group claims — so a top-level route added to any other
   * group would start answering 503 during setup unless it is listed. This walks
   * the route tree and fails when that happens, which is what keeps the list
   * from quietly going stale.
   */
  it("exempts every top-level route that lives outside the (website) group", () => {
    const appDir = path.join(process.cwd(), "src/app");
    const directories = (dir: string) =>
      readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

    const missing: string[] = [];
    const websiteSegments: string[] = [];

    for (const entry of directories(appDir)) {
      // Route groups are transparent to the URL; their children are the real
      // top-level segments. Anything else at the app root already is one.
      const isGroup = entry.startsWith("(") && entry.endsWith(")");
      const segments = isGroup ? directories(path.join(appDir, entry)) : [entry];

      for (const segment of segments) {
        // Test folders, private folders and dynamic segments are not fixed
        // top-level URLs.
        if (
          segment === "__tests__" ||
          segment.startsWith("_") ||
          segment.startsWith("[")
        ) {
          continue;
        }

        if (entry === "(website)") {
          websiteSegments.push(segment);
          continue;
        }

        if (!NON_WEBSITE_ROOT_SEGMENTS.has(segment)) {
          missing.push(segment);
        }
      }
    }

    expect(missing).toEqual([]);
    // Sanity check on the walk itself: if this came back empty the assertion
    // above would pass vacuously.
    expect(websiteSegments.length).toBeGreaterThan(0);
    for (const segment of websiteSegments) {
      expect(NON_WEBSITE_ROOT_SEGMENTS.has(segment)).toBe(false);
    }
  });
});

describe("with setup incomplete (ClubTheme.completedAt IS NULL)", () => {
  beforeEach(() => {
    setupIncomplete();
  });

  it.each(publicWebsiteUrls)("answers 503 for %s", async (url) => {
    const response = await getSetupInProgressResponse(request(url));

    expect(response?.status).toBe(503);
    expect(response?.headers.get("content-type")).toContain("text/html");
  });

  it.each(exemptUrls)("does not gate %s", async (url) => {
    await expect(getSetupInProgressResponse(request(url))).resolves.toBeNull();
  });

  it("serves the holding screen as the body, for a real page and a missing one alike", async () => {
    // Stated choice, not an accident: a published page is 503 too. Answering 200
    // for /about and 503 for /nope would publish the club's page inventory from
    // a half-built install and let a crawler index pages before the club has
    // chosen how they look.
    const real = await getSetupInProgressResponse(request("/about"));
    const missing = await getSetupInProgressResponse(
      request("/definitely-missing"),
    );

    const realBody = await real!.text();

    expect(realBody).toContain(SETUP_IN_PROGRESS_COPY.eyebrow);
    expect(realBody).toContain(SETUP_IN_PROGRESS_COPY.heading(CLUB_NAME));
    expect(realBody).toContain(SETUP_IN_PROGRESS_COPY.body);
    expect(realBody).toContain(`mailto:${CONTACT_EMAIL}`);
    expect(await missing!.text()).toBe(realBody);
  });

  it("tells clients when to come back, and forbids caching the screen", async () => {
    // Retry-After is set deliberately: a bare long-running 503 is a signal to
    // start dropping the club's URLs from an index, whereas 503 + Retry-After is
    // read as a temporary outage. no-store because `/` is otherwise allow-listed
    // as browser-cacheable for 60s, which would outlive setup completion.
    const response = await getSetupInProgressResponse(request("/"));

    expect(response?.headers.get("Retry-After")).toBe(
      String(SETUP_IN_PROGRESS_RETRY_AFTER_SECONDS),
    );
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("gates a form POST as well as a GET", async () => {
    const response = await getSetupInProgressResponse(
      request("/contact", { method: "POST" }),
    );

    expect(response?.status).toBe(503);
  });

  it("answers HEAD with the same status and no body", async () => {
    const response = await getSetupInProgressResponse(
      request("/", { method: "HEAD" }),
    );

    expect(response?.status).toBe(503);
    await expect(response!.text()).resolves.toBe("");
  });

  it("escapes admin-editable values into the document", async () => {
    mocks.clubIdentity.mockResolvedValue({
      name: '<script>alert(1)</script> & Co',
    });
    resetSetupGateCache();

    const body = await (await getSetupInProgressResponse(request("/")))!.text();

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co");
  });

  it("carries the club's own theme CSS so the screen is not unbranded", async () => {
    const body = await (await getSetupInProgressResponse(request("/")))!.text();

    expect(body).toContain("--brand-gold:#c8a227");
  });
});

describe("with setup complete", () => {
  it.each([...publicWebsiteUrls, ...exemptUrls])(
    "lets %s through untouched",
    async (url) => {
      await expect(getSetupInProgressResponse(request(url))).resolves.toBeNull();
    },
  );

  it("never reads the club identity or contact address", async () => {
    await getSetupInProgressResponse(request("/"));

    expect(mocks.clubIdentity).not.toHaveBeenCalled();
    expect(mocks.emailSettings).not.toHaveBeenCalled();
  });
});

describe("the gate does not add a database read per request", () => {
  it("reads the setup state once and reuses it inside the TTL", async () => {
    await getSetupInProgressResponse(request("/"));
    await getSetupInProgressResponse(request("/about"));
    await getSetupInProgressResponse(request("/contact"));

    expect(mocks.themeState).toHaveBeenCalledTimes(1);
  });

  it("shares one read between requests that arrive together on a cold cache", async () => {
    await Promise.all([
      getSetupInProgressResponse(request("/")),
      getSetupInProgressResponse(request("/about")),
      getSetupInProgressResponse(request("/contact")),
    ]);

    expect(mocks.themeState).toHaveBeenCalledTimes(1);
  });

  it("re-reads once the TTL lapses, so completing setup opens the site", async () => {
    setupIncomplete();
    expect((await getSetupInProgressResponse(request("/")))?.status).toBe(503);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + SETUP_STATE_TTL_MS + 1);
      setupComplete();

      await expect(
        getSetupInProgressResponse(request("/")),
      ).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.themeState).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the setup state cannot be read", async () => {
    // getWebsiteThemeRenderState swallows its own database failure and reports
    // isComplete: false, which is what the layout already does — and 503 is the
    // literally correct answer for an unreachable database. Failing open would
    // restore the 200-for-everything defect under exactly the conditions that
    // make it hardest to notice.
    mocks.themeState.mockResolvedValue({ isComplete: false, css: "" });

    expect((await getSetupInProgressResponse(request("/")))?.status).toBe(503);
  });

  it("still answers 503 with a readable screen if resolving the state throws", async () => {
    // A Prisma client that never constructed, say — a realistic first-boot state
    // for exactly the install this screen exists for. An unhandled throw in the
    // proxy would be a 500; the config-derived fallback keeps it a 503.
    mocks.themeState.mockRejectedValue(new Error("no database client"));

    const response = await getSetupInProgressResponse(request("/"));

    expect(response?.status).toBe(503);
    await expect(response!.text()).resolves.toContain(
      SETUP_IN_PROGRESS_COPY.eyebrow,
    );
  });
});

describe("the proxy applies the gate end to end", () => {
  it("returns the 503 with the security headers still attached", async () => {
    setupIncomplete();

    const response = await proxy(request("/definitely-missing"));

    expect(response.status).toBe(503);
    expect(response.headers.get(CSP_HEADER)).toBeTruthy();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it("passes an admin request through while the gate is closed", async () => {
    setupIncomplete();

    const response = await proxy(request("/admin/site-style"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does nothing once setup is complete", async () => {
    const response = await proxy(request("/definitely-missing"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("the layout's fallback screen says the same thing", () => {
  it("renders its pre-setup branch from the shared copy", () => {
    // The layout still has to hold a copy of this screen: the proxy matcher
    // deliberately skips RSC prefetches, and those reach the layout directly. It
    // cannot set a status, so its copy is 200 — but it must never say something
    // different from the 503 body. Checked structurally because the branch only
    // renders inside a request scope.
    const source = readFileSync(
      path.join(process.cwd(), "src/app/(website)/layout.tsx"),
      "utf8",
    );

    expect(source).toContain(
      'import { SETUP_IN_PROGRESS_COPY } from "@/lib/setup-in-progress-screen"',
    );
    expect(source).toContain("SETUP_IN_PROGRESS_COPY.eyebrow");
    expect(source).toContain("SETUP_IN_PROGRESS_COPY.heading(");
    expect(source).toContain("SETUP_IN_PROGRESS_COPY.body");
    expect(source).toContain("SETUP_IN_PROGRESS_COPY.contactPrefix");
  });
});
