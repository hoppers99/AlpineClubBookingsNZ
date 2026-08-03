import { describe, expect, it } from "vitest";
import {
  FIXED_NONCE_WEBSITE_ROUTES,
  isCmsServablePageSlug,
  isFixedNonceWebsitePath,
  isPublicWebsitePath,
  PER_REQUEST_WEBSITE_ROUTES,
} from "@/lib/public-website-paths";

/**
 * The predicate SPLIT the owner's 3 Aug 2026 narrowing required (#2352 D1).
 *
 * One `isPublicWebsitePath()` used to answer three different questions, which was
 * safe only while the fixed per-release CSP nonce covered the whole `(website)`
 * group. The narrowing broke that: the nonce now covers exactly five approved
 * addresses, while the pre-setup holding screen must still stand in for the WHOLE
 * public website. So the questions were separated, and this file is what stops them
 * being quietly rejoined:
 *
 *  • {@link isPublicWebsitePath} — the #2420 setup gate's question. BOTH public
 *    route groups.
 *  • {@link isFixedNonceWebsitePath} — the nonce question. The five approved
 *    `(website)` routes only.
 *  • {@link isCmsServablePageSlug} — the CMS catch-all's territory, which has to be
 *    the same set as the second, because a page the catch-all STORES carries one
 *    frozen nonce for the rest of the release.
 *
 * The addresses that matter are the ones where two of the three answers differ, and
 * each case below is one of them.
 */

/** The three pages that moved to `(website-dynamic)` in the narrowing. */
const MOVED_ADDRESSES = [
  "/hut-leader-instructions",
  "/join/ABC123",
  "/join/verify/token-xyz",
];

describe("the setup gate's question is unchanged by the narrowing", () => {
  it.each(MOVED_ADDRESSES)("still claims %s as a public website address", (path) => {
    // The regression the split exists to prevent. Narrowing the SHARED predicate
    // would have been the small change, and it would have silently taken the
    // pre-setup 503 holding screen off these three — i.e. changed what an
    // unlaunched club exposes to the internet, as a side effect of a CSP decision.
    expect(isPublicWebsitePath(path)).toBe(true);
  });

  it.each(["/dashboard", "/admin/site-style", "/login", "/robots.txt", "/logo.png"])(
    "still leaves %s outside the public website",
    (path) => {
      expect(isPublicWebsitePath(path)).toBe(false);
    },
  );
});

describe("the fixed nonce covers exactly the five approved routes", () => {
  it.each([
    "/",
    "/contact",
    "/join",
    "/join/apply",
    // Everything the `[...slug]` CMS catch-all serves is inside the set, because
    // the catch-all is one of the five and its pages are the ones that get stored.
    "/about",
    "/trips/2026",
    "/definitely-missing",
  ])("claims %s", (path) => {
    expect(isFixedNonceWebsitePath(path)).toBe(true);
  });

  it.each(MOVED_ADDRESSES)("refuses %s, which is now per-request", (path) => {
    expect(isFixedNonceWebsitePath(path)).toBe(false);
  });

  it.each(["/dashboard", "/dashboard/nope", "/admin", "/login", "/asset-not-found"])(
    "refuses %s",
    (path) => {
      expect(isFixedNonceWebsitePath(path)).toBe(false);
    },
  );

  it("keeps /join/apply with the five even though /join/[code] matches its shape", () => {
    // Next serves the static route in preference to the dynamic one, so the address
    // really is served by `(website)/join/apply` and really does carry the fixed
    // nonce. A segment-count match alone would have handed it to `/join/[code]` and
    // given the wrong answer for one of the owner's own five.
    expect(isFixedNonceWebsitePath("/join/apply")).toBe(true);
    expect(isFixedNonceWebsitePath("/join/anything-else")).toBe(false);
  });

  it("treats /join/verify as the group-code page, matching the route table", () => {
    // `/join/verify` is two segments, so `(website-dynamic)/join/[code]` claims it
    // with `code = "verify"` — the token page is three. Per-request is the right
    // answer for the same reason the route is.
    expect(isFixedNonceWebsitePath("/join/verify")).toBe(false);
  });

  it.each(["/hut-leader-instructions/extra", "/join/deeper/still/again"])(
    "claims %s, because no per-request route claims it and the catch-all does",
    (path) => {
      // The per-request patterns are fixed-length, so a deeper address falls to the
      // CMS catch-all — and anything the catch-all can store must be inside the
      // fixed-nonce set or its inline scripts are refused for every later visitor.
      expect(isFixedNonceWebsitePath(path)).toBe(true);
    },
  );

  it("ignores a trailing slash and respects case, exactly as the route table does", () => {
    expect(isFixedNonceWebsitePath("/join/ABC123/")).toBe(false);
    expect(isFixedNonceWebsitePath("/contact/")).toBe(true);
    // Next's route table is case-sensitive, so `/Join/ABC123` is NOT the group-join
    // page: nothing claims it, the catch-all serves it, and it carries the nonce a
    // stored page would be stored with.
    expect(isFixedNonceWebsitePath("/Join/ABC123")).toBe(true);
  });

  it("is a strict subset of the setup gate's set", () => {
    // The invariant that makes the split coherent rather than two overlapping
    // lists: every fixed-nonce address is a public-website address, and the three
    // moved ones are the difference.
    for (const path of [
      "/",
      "/contact",
      "/join",
      "/join/apply",
      "/about",
      ...MOVED_ADDRESSES,
    ]) {
      expect(isPublicWebsitePath(path)).toBe(true);
    }
    for (const path of ["/dashboard/nope", "/admin/typo"]) {
      expect(isPublicWebsitePath(path)).toBe(false);
      expect(isFixedNonceWebsitePath(path)).toBe(false);
    }
  });
});

describe("the two route censuses", () => {
  it("are both non-empty and share no route", () => {
    expect(FIXED_NONCE_WEBSITE_ROUTES.length).toBeGreaterThan(0);
    expect(PER_REQUEST_WEBSITE_ROUTES.length).toBeGreaterThan(0);
    expect(
      FIXED_NONCE_WEBSITE_ROUTES.filter((route) =>
        (PER_REQUEST_WEBSITE_ROUTES as readonly string[]).includes(route),
      ),
    ).toEqual([]);
  });

  it("record the owner's five approved addresses and nothing else", () => {
    // Spelled out rather than derived, because this list IS the owner's decision
    // and a change to it is a change to the CSP. `check-website-render-modes.mjs`
    // holds the other half: the route tree has to agree with it.
    expect([...FIXED_NONCE_WEBSITE_ROUTES].sort()).toEqual([
      "/",
      "/[...slug]",
      "/contact",
      "/join",
      "/join/apply",
    ]);
  });

  it("keeps the per-request patterns to shapes the matcher can express exactly", () => {
    // A catch-all in the per-request census would claim more addresses than a
    // per-segment match can express, and matching fewer would hand the FIXED nonce
    // to a per-request page. The module throws at load on such a pattern; this is
    // the same rule stated where a reader adding a route will see it.
    for (const route of PER_REQUEST_WEBSITE_ROUTES) {
      for (const segment of route.split("/").filter(Boolean)) {
        expect(segment).toMatch(/^(?:[^[\]]+|\[[^.[\]]+\])$/);
      }
    }
  });

  it("classifies every per-request route's own address as per-request", () => {
    // Walks the census itself, so a route added there is covered the day it lands:
    // substitute a plausible value for each dynamic segment and check the runtime
    // answer follows the list.
    for (const route of PER_REQUEST_WEBSITE_ROUTES) {
      const path = route
        .split("/")
        .map((segment) => (segment.startsWith("[") ? "sample-value" : segment))
        .join("/");

      expect(isFixedNonceWebsitePath(path), `${route} -> ${path}`).toBe(false);
      expect(isPublicWebsitePath(path), `${route} -> ${path}`).toBe(true);
    }
  });
});

describe("the CMS catch-all's territory follows the fixed-nonce set", () => {
  it.each(["hut-leader-instructions", "join/ABC123", "join/verify/token-xyz"])(
    "refuses the slug %s, because a real per-request route claims that address",
    (slug) => {
      // Not newly forbidden content — a CMS page at one of these addresses could
      // never have been served, because the route wins. Refusing the slug is what
      // stops an admin creating one and what drops any existing row out of the
      // public menu.
      expect(isCmsServablePageSlug(slug)).toBe(false);
    },
  );

  it("still accepts the same names one segment down", () => {
    // Why rule 2 does this work rather than a reserved WORD: RESERVED_PAGE_SLUGS
    // matches in every segment position, so adding the name there would have
    // refused an address no route claims and the catch-all serves perfectly well.
    expect(isCmsServablePageSlug("trips/hut-leader-instructions")).toBe(true);
    expect(isCmsServablePageSlug("news/join/ABC123")).toBe(true);
  });

  it("accepts the ordinary CMS shapes", () => {
    for (const slug of ["about", "trips/2026", "committee", "accommodation"]) {
      expect(isCmsServablePageSlug(slug)).toBe(true);
    }
  });
});
