// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The global 404 must never throw (#2356 review).
 *
 * `src/app/not-found.tsx` is the LAST boundary in the render. A throw inside it
 * escalates to the nearest error boundary and turns a 404 into a 500 — on URL
 * shapes that used to be served from a static file and so could not fail at
 * all. Since #2356 it renders per-request, which means it now performs three
 * live reads (the `/404` CMS page, the embed resolution for its body, and the
 * cached club identity), any of which can throw when the database is
 * unreachable or an embed reference is broken.
 *
 * `loadNotFoundContent()` wraps ALL THREE in one `try`, not just the page
 * lookup. These cases pin that: each one fails a version of the page where the
 * guard is narrowed back to the lookup alone, or removed entirely. The control
 * case below stops the whole file from passing vacuously on a page that always
 * renders the fallback.
 */

const mocks = vi.hoisted(() => ({
  getPage: vi.fn(),
  buildBody: vi.fn(),
  clubIdentity: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/page-content-html", () => ({
  getSanitizedPageContentByPath: mocks.getPage,
  pageContentHtmlToPlainText: () => "",
}));
vi.mock("@/lib/page-content-embeds", () => ({
  buildEmbeddedBody: mocks.buildBody,
}));
vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: mocks.clubIdentity,
}));
vi.mock("@/lib/auth-redirect", () => ({
  buildBookingLoginPath: () => "/login",
}));
vi.mock("@/components/website/embedded-page-content-parts", () => ({
  EmbeddedPageContentParts: () => null,
}));

import NotFoundPage from "@/app/not-found";

const page = {
  id: "page-1",
  slug: "404",
  caption: "Lost",
  menuTitle: "404",
  title: "We could not find that page",
  headerText: "<p>Header</p>",
  path: "/404",
  sortOrder: 1,
  contentHtml: "{{photo-gallery}}",
  published: true,
};

const clubIdentity = {
  name: "Club Name",
  socialLinks: {},
  publicUrl: "https://club.example.org",
};

/** The hardcoded fallback branch, which needs no database at all. */
async function expectHardcodedFallback() {
  render(await NotFoundPage());
  expect(screen.getByText("404")).toBeTruthy();
  expect(screen.getByText("Page Not Found")).toBeTruthy();
  // ...and specifically NOT the database-backed branch.
  expect(screen.queryByText("We could not find that page")).toBeNull();
}

describe("global 404 degrades instead of throwing", () => {
  beforeEach(() => {
    mocks.getPage.mockResolvedValue(page);
    mocks.buildBody.mockResolvedValue([]);
    mocks.clubIdentity.mockResolvedValue(clubIdentity);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the CMS 404 when every read succeeds (control)", async () => {
    render(await NotFoundPage());
    expect(screen.getByText("We could not find that page")).toBeTruthy();
    expect(screen.queryByText("Page Not Found")).toBeNull();
  });

  it("falls back when the /404 page lookup throws", async () => {
    mocks.getPage.mockRejectedValue(new Error("database unreachable"));
    await expectHardcodedFallback();
  });

  it("falls back when embed resolution throws", async () => {
    // Guarded only because the `try` wraps `buildEmbeddedBody()` too: a broken
    // gallery/form/calendar reference inside the admin-authored /404 body must
    // not turn the 404 into a 500.
    mocks.buildBody.mockRejectedValue(new Error("embed target missing"));
    await expectHardcodedFallback();
  });

  it("falls back when the club identity read throws", async () => {
    // Guarded only because the `try` wraps `getCachedClubIdentity()` too.
    mocks.clubIdentity.mockRejectedValue(new Error("config read failed"));
    await expectHardcodedFallback();
  });

  it("falls back when there is no /404 page record", async () => {
    mocks.getPage.mockResolvedValue(null);
    await expectHardcodedFallback();
  });
});
