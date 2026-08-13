import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { starterPageContent } from "../../../prisma/starter-page-content";
import { buildWebsiteNavLinks } from "@/lib/website-nav";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  pageContentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { pageContent: { findMany: mocks.pageContentFindMany } },
}));

import { listWebsiteMenuPages } from "@/lib/page-content-html";

/**
 * What a freshly seeded club's public navigation contains (#2818 decision 5).
 *
 * The header used to append a hard-coded `{ href: "/contact", label: "Contact" }`
 * after the CMS-driven links, unconditionally. #2813 replaced that with a code
 * FALLBACK: `buildWebsiteNavLinks` appends Contact only when no CMS entry already
 * points at `/contact` (deduped by href). The contact row keeps its seeded empty
 * `menuTitle`, so there is no data migration — the fallback is the whole
 * mechanism.
 *
 * The risk this suite pins is twofold: that Contact silently vanishes (the
 * fallback stops firing), and that it doubles up when a club opts its Contact
 * page into the CMS menu (the dedupe stops working) — the latent duplicate this
 * change also fixed on `main`.
 */

/** The seeded rows as `listWebsiteMenuPages` reads them from the database. */
function seededRows() {
  return starterPageContent.map((page) => ({
    slug: page.slug,
    caption: page.caption,
    menuTitle: page.menuTitle,
    title: page.title,
    path: page.path,
    sortOrder: page.sortOrder,
  }));
}

/** The full header nav for the seeded rows: CMS menu entries + code fallbacks. */
async function seededNav() {
  const dynamic = (await listWebsiteMenuPages()).map((page) => ({
    href: page.path,
    label: page.menuTitle.trim(),
  }));
  return buildWebsiteNavLinks(dynamic);
}

describe("a seeded deployment's public navigation", () => {
  it("shows Contact exactly once, supplied by the code fallback", async () => {
    // The seeded contact row carries an EMPTY menu title, so it is not in the CMS
    // menu; `buildWebsiteNavLinks` is what puts Contact in the nav.
    mocks.pageContentFindMany.mockResolvedValue(seededRows());

    const contactLinks = (await seededNav()).filter(
      (link) => link.href === "/contact",
    );

    expect(
      contactLinks,
      "Contact must appear exactly once in a seeded club's nav",
    ).toHaveLength(1);
    expect(contactLinks[0]!.label).toBe("Contact");

    // And it does NOT come from the CMS menu list — that is the fallback's job.
    const menuSlugs = (await listWebsiteMenuPages()).map((page) => page.slug);
    expect(menuSlugs).not.toContain("contact");
  });

  it("does not duplicate Contact when a club opts it into the CMS menu", async () => {
    // A club that types a menu title for its Contact page gets a CMS-driven
    // entry; the fallback must then step aside so the link shows once, not twice.
    mocks.pageContentFindMany.mockResolvedValue(
      seededRows().map((row) =>
        row.slug === "contact" ? { ...row, menuTitle: "Kōrero mai" } : row,
      ),
    );

    const contactLinks = (await seededNav()).filter(
      (link) => link.href === "/contact",
    );

    expect(contactLinks).toHaveLength(1);
    // The club's own label wins — the fallback did not fire.
    expect(contactLinks[0]!.label).toBe("Kōrero mai");
  });

  it("shows every seeded page that carries a menu title, and only those", async () => {
    mocks.pageContentFindMany.mockResolvedValue(seededRows());

    const pages = await listWebsiteMenuPages();

    expect(pages.map((page) => page.slug).sort()).toEqual(
      starterPageContent
        .filter((page) => page.menuTitle.trim().length > 0)
        .map((page) => page.slug)
        .sort(),
    );
  });

  it("does NOT show the two form pages, because advertising them is opt-in", async () => {
    // The same seed, the same call: the pages exist and are published, and they
    // stay out of the nav purely because their seeded menu title is empty
    // (#2818 decision 1). If someone later gives them a seeded label, this fails
    // — which is the point, since that would opt every club in at once.
    mocks.pageContentFindMany.mockResolvedValue(seededRows());

    const slugs = (await listWebsiteMenuPages()).map((page) => page.slug);

    expect(slugs).not.toContain("booking-requests");
    expect(slugs).not.toContain("school-bookings");
  });

  it("no longer hard-codes an unconditional Contact entry in the header", () => {
    // Contact now comes from `buildWebsiteNavLinks`, which the header delegates
    // to. A re-added static `{ href: "/contact" }` in the header would show
    // Contact twice the moment a club opts its Contact page into the CMS menu.
    const header = readFileSync(
      join(process.cwd(), "src", "components", "website-header.tsx"),
      "utf8",
    );

    expect(header).not.toContain("staticNavLinks");
    expect(header).not.toMatch(/href:\s*["']\/contact["']/);
    expect(header).toContain("buildWebsiteNavLinks");
  });
});
