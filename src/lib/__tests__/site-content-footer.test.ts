import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  siteContentFindMany: vi.fn(),
  resolveTextTokens: vi.fn(async (html: string) => html),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { siteContent: { findMany: mocks.siteContentFindMany } },
}));

// Token resolution has its own suite (page-content-embeds.test.ts); here it is
// an identity so these assertions read the stored-vs-starter decision only.
vi.mock("@/lib/page-content-embeds", () => ({
  resolveTextTokens: mocks.resolveTextTokens,
}));

import { getSiteFooterContent } from "@/lib/site-content";
import { starterSiteContent } from "../../../prisma/starter-site-content";

const starterByKey = new Map(
  starterSiteContent.map((section) => [section.key, section.contentHtml]),
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTextTokens.mockImplementation(async (html: string) => html);
});

describe("getSiteFooterContent affiliations on a fresh install (#2490)", () => {
  it("returns no affiliations for the rows a fresh seed writes", async () => {
    // Exactly what prisma/seed.ts creates on a fresh install.
    mocks.siteContentFindMany.mockResolvedValue(
      starterSiteContent.map((section) => ({
        key: section.key,
        contentHtml: section.contentHtml,
      })),
    );

    const footer = await getSiteFooterContent();

    expect(footer.affiliationsHtml).toBe("");
    expect(footer.blurbHtml).not.toBe("");
    expect(footer.quickLinksHtml).not.toBe("");
    // Nothing to resolve tokens in, so the empty section short-circuits before
    // sanitising or token resolution — it can never emit a bare heading.
    expect(mocks.resolveTextTokens).not.toHaveBeenCalledWith(
      expect.stringContaining("Affiliations"),
    );
  });

  it("returns no affiliations when the row is missing entirely", async () => {
    // Pre-backfill environments fall back to the starter default, which is now
    // itself empty — so both the seeded and the unseeded path render nothing.
    mocks.siteContentFindMany.mockResolvedValue([]);

    const footer = await getSiteFooterContent();

    expect(starterByKey.get("FOOTER_AFFILIATIONS")).toBe("");
    expect(footer.affiliationsHtml).toBe("");
  });

  it("renders affiliations a club has written for itself", async () => {
    mocks.siteContentFindMany.mockResolvedValue([
      {
        key: "FOOTER_AFFILIATIONS",
        contentHtml:
          '<h3>Affiliations</h3><ul><li><a href="https://example.org/">Our Association</a></li></ul>',
      },
    ]);

    const footer = await getSiteFooterContent();

    expect(footer.affiliationsHtml).toContain("Our Association");
  });

  it("ships no club-specific affiliation in the starter footer", async () => {
    mocks.siteContentFindMany.mockResolvedValue([]);

    const footer = await getSiteFooterContent();
    const rendered = [
      footer.blurbHtml,
      footer.quickLinksHtml,
      footer.affiliationsHtml,
    ].join("");

    expect(rendered).not.toMatch(/RMCA|Ruapehu|Federated Mountain Clubs/i);
  });
});
