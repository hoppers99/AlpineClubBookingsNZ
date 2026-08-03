import { describe, expect, it } from "vitest";
import {
  isReservedPageSlug,
  isValidPageSlug,
  SYSTEM_PAGE_SLUGS,
} from "@/lib/page-content";
import {
  isCmsServablePageSlug,
  isPublicWebsitePath,
  NON_WEBSITE_ROOT_SEGMENTS,
} from "@/lib/public-website-paths";

/**
 * The invariant slice 1 needs and did not have (#2352 slice-1 review, F1).
 *
 * `src/proxy.ts` hands the FIXED per-release CSP nonce to exactly the addresses
 * `isPublicWebsitePath()` claims. `(website)/[...slug]` — the one route that fills
 * the full-route ISR store — claims every URL no other route claims, which is a
 * WIDER set. A page served in the difference is stored with a per-request nonce
 * frozen into its inline scripts and then handed to every later visitor under a
 * policy naming a different one: nothing on the page executes and it never
 * hydrates, permanently, for everybody.
 *
 * So the property is: **every slug the admin write accepts is inside the
 * fixed-nonce set, and every slug outside it is refused twice** — once at the write
 * and once in the catch-all's own loader, which is what covers a row created before
 * the rule existed.
 */
describe("CMS page territory matches the fixed-nonce set (#2352 F1)", () => {
  /**
   * The live shapes, and why each one was reachable before the fix:
   *  • `pay`, `chores`, `family-invite`, `membership-cancellation` — those
   *    `(public)` directories hold only `[token]/`, so nothing claimed the bare
   *    path and it fell through to the catch-all;
   *  • the multi-segment forms — `PAGE_SLUG_PATTERN` allows slashes and
   *    CONFIGURATION.md documents that shape (`trips/2026`), and no route claims a
   *    second segment under those prefixes.
   */
  const refusedSlugs = [
    "pay",
    "chores",
    "family-invite",
    "membership-cancellation",
    "calendar/2026",
    "notices/summer",
    "profile/help",
    "lodge/history",
    "finance/reports",
    "bookings/archive",
    "display/foyer",
    "dashboard/welcome",
    "admin/notes",
  ];

  const acceptedSlugs = [
    "about",
    "trip-reports",
    "trips/2026",
    "accommodation",
    "committee",
    "join/apply",
    "404",
  ];

  it.each(refusedSlugs)("refuses %s at the admin write", (slug) => {
    expect(isValidPageSlug(slug), "the slug is otherwise well-formed").toBe(true);
    expect(isReservedPageSlug(slug)).toBe(true);
    expect(isCmsServablePageSlug(slug)).toBe(false);
  });

  it.each(acceptedSlugs)("still accepts %s", (slug) => {
    expect(isValidPageSlug(slug)).toBe(true);
    expect(isReservedPageSlug(slug)).toBe(false);
    expect(isCmsServablePageSlug(slug)).toBe(true);
  });

  it("refuses every root segment that belongs to another route group", () => {
    // Driven off the set itself rather than a copy, so a segment added for a new
    // route group is covered the day it lands.
    for (const segment of NON_WEBSITE_ROOT_SEGMENTS) {
      expect(isReservedPageSlug(segment), segment).toBe(true);
      expect(isReservedPageSlug(`${segment}/child`), segment).toBe(true);
    }
  });

  it("never accepts a slug outside the fixed-nonce set", () => {
    // The property itself, stated over the two functions the admin write actually
    // calls. A slug that passes both is a page that will be STORED, so it has to be
    // an address the proxy gives the fixed nonce to.
    const candidates = [
      ...refusedSlugs,
      ...acceptedSlugs,
      ...NON_WEBSITE_ROOT_SEGMENTS,
      ...[...SYSTEM_PAGE_SLUGS.keys()],
      "logout",
      "trips/2026/spring",
    ];

    for (const slug of candidates) {
      if (!isValidPageSlug(slug) || isReservedPageSlug(slug)) continue;
      expect(isPublicWebsitePath(`/${slug}`), slug).toBe(true);
    }
  });

  it("keeps the seeded system pages publishable", () => {
    // A regression here would be worse than the bug: `home` and `404` are seeded
    // rows the product requires, so a rule that refused them would break setup.
    for (const slug of SYSTEM_PAGE_SLUGS.keys()) {
      expect(isReservedPageSlug(slug), slug).toBe(false);
    }
  });

  it("only looks at the FIRST segment for the route-group rule", () => {
    // `/trips/pay` has root segment `trips`, so it is an ordinary public-website
    // address and is stored normally. Narrowing this to the first segment is not a
    // shortcut — it is what the classifier itself looks at.
    expect(isCmsServablePageSlug("trips/pay")).toBe(true);
    // The long-standing reserved-name rule still applies in every position, so the
    // nine application prefixes stay refused wherever they appear.
    expect(isReservedPageSlug("trips/admin")).toBe(true);
  });
});
