import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublishedPageContentByPath: vi.fn(),
  setupInProgressMetadata: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/page-content-html", () => ({
  getPublishedPageContentByPath: mocks.getPublishedPageContentByPath,
  pageContentHtmlToPlainText: (html: string) => html.replace(/<[^>]*>/g, ""),
}));

vi.mock("@/lib/website-setup-metadata", () => ({
  setupInProgressMetadata: mocks.setupInProgressMetadata,
}));

vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: async () => ({
    name: "Test Alpine Club",
    lodgeName: "Test Lodge",
  }),
  getCachedDefaultLodgeCapacity: async () => 47,
}));

import { metadata as bookingRequestsLayoutMetadata } from "@/app/(website-dynamic)/booking-requests/layout";
import { metadata as schoolBookingsLayoutMetadata } from "@/app/(website-dynamic)/school-bookings/layout";
import { metadata as respondMetadata } from "@/app/(website-dynamic)/booking-requests/respond/[token]/page";
import { metadata as verifyMetadata } from "@/app/(website-dynamic)/booking-requests/verify/[token]/page";
import { metadata as schoolConfirmMetadata } from "@/app/(website-dynamic)/school-bookings/confirm/[token]/page";
import { generateMetadata as bookingRequestsMetadata } from "@/app/(website-dynamic)/booking-requests/page";
import { generateMetadata as schoolBookingsMetadata } from "@/app/(website-dynamic)/school-bookings/page";

/**
 * Two rules about what a search engine may index here, and they are one rule
 * seen from two sides (#2421, #2818 decision 1).
 *
 * The TOKENISED confirmation flows carry one-time secure links and must NEVER be
 * indexed, in any configuration. That is declared on each sub-tree's layout so a
 * route added later inherits it, and restated on each token page.
 *
 * The BARE form pages are indexable only when the club has opted in by giving
 * the page a menu title — the same field that puts it in the navigation, so the
 * nav and the robots tag can never disagree. The seeded value is empty, so every
 * deployment stays unlisted until somebody chooses otherwise.
 *
 * `public/robots.txt` must NOT disallow either prefix, and that half is what
 * someone is most likely to re-add as a "hardening" tidy-up. A disallowed crawler
 * never fetches the page, so it never sees the noindex, and it can still list a
 * bare token URL found in a shared link. Allowing the crawl and answering with
 * noindex is what actually removes a token page from an index.
 */

const NOINDEX = { index: false, follow: false };
const INDEXABLE = { index: true, follow: true };

/** A published PageContent row for the page under test. */
function publishedRow(menuTitle: string) {
  return {
    slug: "booking-requests",
    caption: "Request a stay",
    menuTitle,
    title: "Booking Requests",
    headerText: "<p>Seeded copy.</p>",
    path: "/booking-requests",
    sortOrder: 28,
    contentHtml: "{{booking-requests}}",
    published: true,
  };
}

describe("tokenised links stay out of search engines in every configuration (#2421)", () => {
  it("declares noindex on both token sub-trees and on every token page", () => {
    expect(bookingRequestsLayoutMetadata.robots).toEqual(NOINDEX);
    expect(schoolBookingsLayoutMetadata.robots).toEqual(NOINDEX);
    expect(respondMetadata.robots).toEqual(NOINDEX);
    expect(verifyMetadata.robots).toEqual(NOINDEX);
    expect(schoolConfirmMetadata.robots).toEqual(NOINDEX);
  });

  it("does not disallow either path in robots.txt, which would hide the noindex", () => {
    const robots = readFileSync(
      join(process.cwd(), "public", "robots.txt"),
      "utf8",
    );
    expect(robots).not.toContain("booking-requests");
    expect(robots).not.toContain("school-bookings");
  });
});

describe("the bare form pages are indexable only when the club opts in (#2818 decision 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setupInProgressMetadata.mockResolvedValue(null);
  });

  it.each([
    ["booking requests", bookingRequestsMetadata],
    ["school bookings", schoolBookingsMetadata],
  ])("keeps %s noindex while the menu title is empty", async (_label, generate) => {
    mocks.getPublishedPageContentByPath.mockResolvedValue(publishedRow(""));

    await expect(generate()).resolves.toMatchObject({ robots: NOINDEX });
  });

  it.each([
    ["booking requests", bookingRequestsMetadata],
    ["school bookings", schoolBookingsMetadata],
  ])("makes %s indexable once a menu title is set", async (_label, generate) => {
    mocks.getPublishedPageContentByPath.mockResolvedValue(
      publishedRow("Request a stay"),
    );

    await expect(generate()).resolves.toMatchObject({ robots: INDEXABLE });
  });

  it.each([
    ["booking requests", bookingRequestsMetadata],
    ["school bookings", schoolBookingsMetadata],
  ])(
    "treats a whitespace-only menu title on %s as no opt-in, matching the nav filter",
    async (_label, generate) => {
      // `listWebsiteMenuPages` trims before testing for emptiness. If these two
      // disagreed, a page could be indexable and yet absent from the navigation —
      // exactly the split the single-signal design exists to prevent.
      mocks.getPublishedPageContentByPath.mockResolvedValue(publishedRow("   "));

      await expect(generate()).resolves.toMatchObject({ robots: NOINDEX });
    },
  );

  it.each([
    ["booking requests", bookingRequestsMetadata],
    ["school bookings", schoolBookingsMetadata],
  ])(
    "keeps %s noindex when the row is missing or unpublished",
    async (_label, generate) => {
      // `getPublishedPageContentByPath` returns null for both. Nothing has asked
      // for the page to be advertised, so the closed answer is the right one —
      // and this is the state a deployment is in before the backfill runs.
      mocks.getPublishedPageContentByPath.mockResolvedValue(null);

      await expect(generate()).resolves.toMatchObject({ robots: NOINDEX });
    },
  );

  it("does not stamp robots at all while setup is incomplete", async () => {
    // Pre-setup the holding screen owns the head (#2420 F1), and it must not be
    // overridden by a lookup that has not happened.
    const holding = { title: "Site setup in progress" };
    mocks.setupInProgressMetadata.mockResolvedValue(holding);

    await expect(bookingRequestsMetadata()).resolves.toBe(holding);
    expect(mocks.getPublishedPageContentByPath).not.toHaveBeenCalled();
  });
});
