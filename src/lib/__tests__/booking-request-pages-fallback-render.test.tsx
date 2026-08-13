// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { starterPageContent } from "../../../prisma/starter-page-content";
import {
  BUILT_IN_DYNAMIC_PAGE_SLUGS,
  PER_REQUEST_WEBSITE_ROUTES,
} from "@/lib/public-website-paths";

const mocks = vi.hoisted(() => ({
  getPublishedPageContentByPath: vi.fn(),
  buildEmbeddedBody: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/page-content-html", () => ({
  getPublishedPageContentByPath: mocks.getPublishedPageContentByPath,
  pageContentHtmlToPlainText: (html: string) => html.replace(/<[^>]*>/g, ""),
}));

vi.mock("@/lib/page-content-embeds", () => ({
  buildEmbeddedBody: mocks.buildEmbeddedBody,
}));

vi.mock("@/lib/website-setup-metadata", () => ({
  setupInProgressMetadata: async () => null,
}));

vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: async () => ({
    name: "Test Alpine Club",
    lodgeName: LODGE_NAME,
    hutLeaderLabel: "Hut Leader",
    lodgeCapacity: 20,
  }),
  getCachedDefaultLodgeCapacity: async () => 47,
}));

// The forms fetch on mount; nothing here asserts on their contents.
vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ ok: true, json: async () => ({}) })),
);

/**
 * A lodge name carrying markup a club could plausibly type, and which a sanitiser
 * has never seen — `lodgeName` is a free-text club identity field, not page HTML.
 */
const LODGE_NAME = 'Test Lodge <img src=x onerror="alert(1)">';

import BookingRequestsPage from "@/app/(website-dynamic)/booking-requests/page";
import SchoolBookingsPage from "@/app/(website-dynamic)/school-bookings/page";

/**
 * What each page does when its `PageContent` row is missing or unpublished
 * (#2818 decisions 1 and 6).
 *
 * This is not an edge case: it is the state every deployment is in between
 * upgrading the code and running the backfill migration, and the state a club
 * lands in if the row is ever hidden. The page must still render its form — the
 * feature cannot depend on a CMS row existing — and, crucially, the composed
 * fallback header must render as TEXT.
 *
 * That last point is the whole of decision 6. The fallback interpolates
 * `lodgeName`, which no sanitiser has touched, and the original code passed it to
 * `dangerouslySetInnerHTML` under a comment claiming it was "sanitised on read".
 * The comment described the OTHER branch.
 */
describe("the form pages render without a PageContent row (#2818)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublishedPageContentByPath.mockResolvedValue(null);
    mocks.buildEmbeddedBody.mockResolvedValue([]);
  });

  it.each([
    ["booking requests", BookingRequestsPage, "Request a stay"],
    ["school bookings", SchoolBookingsPage, "For schools & groups"],
  ])(
    "renders the bare %s form and its default heading",
    async (_label, Page, caption) => {
      const { container } = render(await Page());

      expect(container.textContent).toContain(caption);
      // The form itself, not just the chrome: each renders a submit control.
      expect(container.querySelector("form, input, button")).not.toBeNull();
    },
  );

  it.each([
    ["booking requests", BookingRequestsPage],
    ["school bookings", SchoolBookingsPage],
  ])(
    "escapes the composed %s fallback rather than parsing it as HTML",
    async (_label, Page) => {
      const { container } = render(await Page());

      // The dangerous half of the club-set value must appear as visible TEXT...
      expect(container.textContent).toContain("<img src=x");
      // ...as ESCAPED markup in the serialised DOM, never as a live element.
      // Asserting on the escaped form rather than on the absence of the string
      // `onerror=` matters: those characters legitimately survive INSIDE the
      // escaped text, and it is the `&lt;` around them that makes them inert.
      expect(container.innerHTML).toContain("&lt;img src=x");
      expect(container.innerHTML).not.toContain("<img");
      expect(container.querySelector("img")).toBeNull();
    },
  );

  it.each([
    ["booking requests", BookingRequestsPage],
    ["school bookings", SchoolBookingsPage],
  ])(
    "still uses the HTML sink for a genuine stored %s header",
    async (_label, Page) => {
      // The other branch must keep working: stored `headerText` is admin HTML,
      // sanitised on write and again on read, and clubs format it.
      mocks.getPublishedPageContentByPath.mockResolvedValue({
        slug: "x",
        caption: "Cap",
        menuTitle: "",
        title: "Title",
        headerText: "<p>Real <strong>stored</strong> copy.</p>",
        path: "/x",
        sortOrder: 1,
        contentHtml: "",
        published: true,
      });

      const { container } = render(await Page());

      expect(container.querySelector("strong")?.textContent).toBe("stored");
    },
  );

  it.each([
    ["booking requests", BookingRequestsPage],
    ["school bookings", SchoolBookingsPage],
  ])(
    "does not reach the fallback for a %s row whose header is only whitespace",
    async (_label, Page) => {
      // A blanked header is not a request to render raw HTML — it is an empty
      // field, so the composed sentence takes over, escaped.
      mocks.getPublishedPageContentByPath.mockResolvedValue({
        slug: "x",
        caption: "Cap",
        menuTitle: "",
        title: "Title",
        headerText: "   ",
        path: "/x",
        sortOrder: 1,
        contentHtml: "",
        published: true,
      });

      const { container } = render(await Page());

      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toContain("<img src=x");
    },
  );
});

describe("the built-in dynamic page allowlist stays honest (#2818 decision 2)", () => {
  it("names only slugs a real per-request route serves", () => {
    // A slug on this list may carry a nav link, so an entry with no route behind
    // it is a link to a 404. Checked against the census the render-mode gate
    // keeps equal to the route tree.
    for (const slug of BUILT_IN_DYNAMIC_PAGE_SLUGS) {
      expect(
        PER_REQUEST_WEBSITE_ROUTES as readonly string[],
        `${slug} must be served by a (website-dynamic) route`,
      ).toContain(`/${slug}`);
    }
  });

  it("names only slugs that have a seeded PageContent row", () => {
    // The menu entry comes from a row, so a slug with no row could never be
    // listed and being on the list would be misleading.
    const seeded = new Set(starterPageContent.map((page) => page.slug));
    for (const slug of BUILT_IN_DYNAMIC_PAGE_SLUGS) {
      expect(seeded, `${slug} must have a starter row`).toContain(slug);
    }
  });

  it("seeds every allowlisted page unlisted, so advertising stays opt-in", () => {
    for (const slug of BUILT_IN_DYNAMIC_PAGE_SLUGS) {
      const page = starterPageContent.find((entry) => entry.slug === slug);
      expect(page!.menuTitle, `${slug} must seed an empty menu title`).toBe("");
    }
  });

  it("is not empty, so the assertions above are not vacuous", () => {
    expect(BUILT_IN_DYNAMIC_PAGE_SLUGS.size).toBeGreaterThan(0);
  });
});
