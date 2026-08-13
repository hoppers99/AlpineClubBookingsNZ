import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { starterPageContent } from "../../../prisma/starter-page-content";

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
 * after the CMS-driven links. #2813 deleted it so the navigation is entirely the
 * club's to arrange — which is right, and which would silently have removed the
 * Contact link from every deployment, because the contact row has always seeded
 * an empty `menuTitle`.
 *
 * So the seed now carries the label and a backfill repairs deployed rows. The
 * risk this suite exists to pin is that the DATA and the DELETION drift apart
 * again: nothing else fails if `starterPageContent` loses that value, and the
 * symptom is a missing link on a live site rather than a red build.
 *
 * The nav is derived from the seed rather than from a hand-written expectation,
 * so a page added to the seed with a menu title is covered the day it lands.
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

describe("a seeded deployment's public navigation", () => {
  it("shows Contact, which the deleted hard-coded link used to provide", async () => {
    mocks.pageContentFindMany.mockResolvedValue(seededRows());

    const pages = await listWebsiteMenuPages();

    const contact = pages.find((page) => page.slug === "contact");
    expect(contact, "Contact must appear in a seeded club's nav").toBeDefined();
    expect(contact!.menuTitle).toBe("Contact");
    expect(contact!.path).toBe("/contact");
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

  it("no longer needs a hard-coded Contact entry in the header", () => {
    // The deletion half of the same decision. A re-added static link would show
    // Contact TWICE on a seeded site now that the row supplies it.
    const header = readFileSync(
      join(process.cwd(), "src", "components", "website-header.tsx"),
      "utf8",
    );

    expect(header).not.toContain("staticNavLinks");
    expect(header).not.toMatch(/href:\s*["']\/contact["']/);
  });
});

