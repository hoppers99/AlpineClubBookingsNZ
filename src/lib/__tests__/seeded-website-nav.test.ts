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
 * What a freshly seeded club's public navigation contains.
 *
 * The header used to append a hard-coded `{ href: "/contact", label: "Contact" }`
 * after the CMS-driven links, unconditionally; #2813 briefly replaced that with a
 * dedupe-by-href code fallback. Both are now gone: the code owns no fixture
 * beyond Home, and Contact is treated exactly like every other page — it appears
 * in the nav only when its CMS row carries a menu title.
 *
 * The risk this suite pins is that Contact does not sneak back in as a code
 * fixture (neither the old unconditional hard-code nor the fallback), and that a
 * club which opts its Contact page into the CMS menu gets it exactly once, from
 * its own entry.
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

/** The full header nav for the seeded rows: Home + the CMS menu entries. */
async function seededNav() {
  const dynamic = (await listWebsiteMenuPages()).map((page) => ({
    href: page.path,
    label: page.menuTitle.trim(),
  }));
  return buildWebsiteNavLinks(dynamic);
}

describe("a seeded deployment's public navigation", () => {
  it("does not show Contact until its page is given a menu title", async () => {
    // The seeded contact row carries an EMPTY menu title, so it is not in the CMS
    // menu, and there is no longer a code fallback to synthesise it.
    mocks.pageContentFindMany.mockResolvedValue(seededRows());

    const contactLinks = (await seededNav()).filter(
      (link) => link.href === "/contact",
    );

    expect(
      contactLinks,
      "Contact must not appear until a club opts its page into the CMS menu",
    ).toHaveLength(0);

    const menuSlugs = (await listWebsiteMenuPages()).map((page) => page.slug);
    expect(menuSlugs).not.toContain("contact");
  });

  it("shows Contact exactly once when a club opts it into the CMS menu", async () => {
    // A club that types a menu title for its Contact page gets a CMS-driven
    // entry — the only mechanism now, so it shows once with the club's label.
    mocks.pageContentFindMany.mockResolvedValue(
      seededRows().map((row) =>
        row.slug === "contact" ? { ...row, menuTitle: "Kōrero mai" } : row,
      ),
    );

    const contactLinks = (await seededNav()).filter(
      (link) => link.href === "/contact",
    );

    expect(contactLinks).toHaveLength(1);
    // The club's own label is used verbatim.
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

  it("does not hard-code a Contact entry in the header", () => {
    // The nav comes entirely from `buildWebsiteNavLinks`, which the header
    // delegates to. A re-added static `{ href: "/contact" }` in the header would
    // resurrect the fixture this change removed, showing Contact even for a club
    // that never opted its page into the CMS menu.
    const header = readFileSync(
      join(process.cwd(), "src", "components", "website-header.tsx"),
      "utf8",
    );

    expect(header).not.toContain("staticNavLinks");
    expect(header).not.toMatch(/href:\s*["']\/contact["']/);
    expect(header).toContain("buildWebsiteNavLinks");
  });
});
