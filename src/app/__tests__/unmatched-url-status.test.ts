import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Status codes for URLs nothing serves (#2405).
 *
 * The issue reported a soft 404: unmatched URLs answering `200 OK` while
 * showing the "page not found" screen, so search engines index dead addresses
 * and monitoring cannot tell a missing page from a working one. Two things came
 * out of measuring it, and both are pinned here.
 *
 * 1. The PAGE class was already right. `(website)/[...slug]` claims every
 *    human-plausible mistyped or bot-probed URL and calls `notFound()`; Next's
 *    `HTTPAccessFallbackBoundary` catches that during the render and sets 404.
 *    The reported 200s came from a staging stack that had never completed
 *    site-style setup — see the layout note below. These cases stop the
 *    `notFound()` calls being deleted or narrowed.
 * 2. The API class was wrong, in every configuration. `/api/<anything>` that no
 *    handler claimed fell through to that same CMS PAGE catch-all, so a JSON
 *    client was handed ~23KB of `text/html`. `api/[...unmatched]/route.ts` now
 *    terminates those URLs with JSON.
 *
 * The "still 200" cases are as load-bearing as the 404s: a change that 404s a
 * published page, or that swallows a real API route, is far worse than the bug.
 */

const mocks = vi.hoisted(() => {
  class NotFoundSignal extends Error {
    constructor() {
      super("NEXT_HTTP_ERROR_FALLBACK;404");
      this.name = "NotFoundSignal";
    }
  }

  return {
    NotFoundSignal,
    getPage: vi.fn(),
    clubIdentity: vi.fn(),
    buildBody: vi.fn(),
    // The real `notFound()` throws, and callers rely on it never returning.
    // A mock that returned instead would let the code under test carry on down
    // a path it never takes in production, and pass vacuously.
    notFound: vi.fn(() => {
      throw new NotFoundSignal();
    }),
  };
});

const { NotFoundSignal, notFound } = mocks;

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/page-content-html", () => ({
  getSanitizedPageContentByPath: mocks.getPage,
  pageContentHtmlToPlainText: (html: string) => html,
}));
vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: mocks.clubIdentity,
}));
vi.mock("@/lib/page-content-embeds", () => ({
  buildEmbeddedBody: mocks.buildBody,
}));
vi.mock("@/components/website/embedded-page-content-parts", () => ({
  EmbeddedPageContentParts: () => null,
}));

import DynamicWebsitePage, {
  generateMetadata,
} from "@/app/(website)/[...slug]/page";
import * as unmatchedApi from "@/app/api/[...unmatched]/route";
import { getFeatureFlagBlockResponse } from "@/proxy";

const publishedPage = {
  id: "page-1",
  slug: "about",
  caption: "About",
  menuTitle: "About",
  title: "About the Club",
  headerText: "<p>Who we are</p>",
  path: "/about",
  sortOrder: 1,
  contentHtml: "<p>Body</p>",
  published: true,
};

function props(...slug: string[]) {
  return { params: Promise.resolve({ slug }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clubIdentity.mockResolvedValue({ name: "Example Alpine Club" });
  mocks.buildBody.mockResolvedValue([]);
});

/**
 * Every unmatched shape the issue measured. They do not all reach the database:
 * `/.env` and `/foo\0bar` are rejected by the slug rules and `/admin/nope` and
 * `/wp-admin/...` by the reserved-prefix rules, while `/definitely-missing` is
 * a well-formed slug that simply has no row. The real `isValidPageSlug` and
 * `isReservedPageSlug` are deliberately NOT mocked so each shape travels its
 * own path; all six must still end at `notFound()`.
 */
const unmatchedPageUrls: ReadonlyArray<readonly [string, string[]]> = [
  ["/definitely-missing", ["definitely-missing"]],
  ["/wp-admin/setup-config.php", ["wp-admin", "setup-config.php"]],
  ["/.env", [".env"]],
  ["/admin/nope", ["admin", "nope"]],
  // `/foo%00bar` as Next hands it to the segment: percent-decoded, embedded
  // NUL and all. Written as an escape so no raw NUL byte sits in the source.
  ["/foo%00bar", ["foo\u0000bar"]],
];

describe("unmatched page URLs resolve to a 404, not a soft 200", () => {
  it.each(unmatchedPageUrls)(
    "%s raises notFound() from generateMetadata before the page renders",
    async (_label, slug) => {
      mocks.getPage.mockResolvedValue(null);

      await expect(generateMetadata(props(...slug))).rejects.toBeInstanceOf(
        NotFoundSignal,
      );
      expect(notFound).toHaveBeenCalled();
    },
  );

  it.each(unmatchedPageUrls)(
    "%s raises notFound() from the page component too",
    async (_label, slug) => {
      mocks.getPage.mockResolvedValue(null);

      await expect(DynamicWebsitePage(props(...slug))).rejects.toBeInstanceOf(
        NotFoundSignal,
      );
      expect(notFound).toHaveBeenCalled();
    },
  );

  it("404s a CMS page the admin has unpublished, like a missing one", async () => {
    mocks.getPage.mockResolvedValue({ ...publishedPage, published: false });

    await expect(generateMetadata(props("about"))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
  });
});

describe("a published CMS page still answers 200", () => {
  it("returns real metadata rather than raising notFound()", async () => {
    mocks.getPage.mockResolvedValue(publishedPage);

    const metadata = await generateMetadata(props("about"));

    expect(notFound).not.toHaveBeenCalled();
    expect(metadata.title).toBe("About the Club");
  });

  it("renders the page component rather than raising notFound()", async () => {
    mocks.getPage.mockResolvedValue(publishedPage);

    await expect(DynamicWebsitePage(props("about"))).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("keeps the page lookup memoised for the request", () => {
    // #2405 assumed this lookup was already cached per request. It was not:
    // `generateMetadata()` and the component each called it, and only Prisma's
    // same-tick findUnique batching hid the second read. React `cache()` makes
    // the single read explicit rather than incidental.
    //
    // Checked structurally, not by counting calls: React `cache()` only
    // memoises inside a request scope, and a unit test has none — the memo is a
    // no-op here, so a call-count assertion would fail against a correct page
    // and could never fail against a broken one. The observable check lives in
    // the running app (one `PageContent` read per CMS page render).
    const source = readFileSync(
      path.join(process.cwd(), "src/app/(website)/[...slug]/page.tsx"),
      "utf8",
    );

    expect(source).toMatch(/import \{ cache \} from "react"/);
    expect(source).toMatch(/const loadPublishedPage = cache\(/);
  });
});

describe("unmatched /api URLs answer JSON, not the website's HTML", () => {
  const jsonMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

  it.each(jsonMethods)("%s returns 404 with a JSON body", async (method) => {
    const response = unmatchedApi[method]();

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("answers HEAD with the same status and no body", async () => {
    const response = unmatchedApi.HEAD();

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("");
  });

  it("is indistinguishable from a path hidden by a disabled module", async () => {
    // Same bytes as src/proxy.ts's module gate, so a caller cannot tell a route
    // that does not exist from one a module flag is hiding, and so cannot probe
    // an install for which modules are switched on.
    const gated = getFeatureFlagBlockResponse("/api/chores", {
      chores: false,
    } as never);

    expect(gated?.status).toBe(404);
    await expect(gated?.json()).resolves.toEqual(
      await unmatchedApi.GET().json(),
    );
  });
});
