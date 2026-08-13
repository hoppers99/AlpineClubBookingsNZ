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

/**
 * The five routes #2818 moved into `(website-dynamic)` — the two CMS-backed form
 * pages and their tokenised confirmation flows.
 *
 * They joined for a different reason from the three above. Nothing about them
 * needed a per-request nonce structurally: both bare pages are database-backed
 * built-ins that would have suited the fixed-nonce group. They are here because
 * D1's census is an owner decision pinned at five addresses, so widening it is a
 * CSP decision rather than a routing convenience, and because these are the two
 * pages where an anonymous visitor enters the most personal information.
 */
const FORM_PAGE_ADDRESSES = [
  "/booking-requests",
  "/booking-requests/respond/token-xyz",
  "/booking-requests/verify/token-xyz",
  "/school-bookings",
  "/school-bookings/confirm/token-xyz",
];

describe("the setup gate's question is unchanged by the narrowing", () => {
  it.each([...MOVED_ADDRESSES, ...FORM_PAGE_ADDRESSES])(
    "still claims %s as a public website address",
    (path) => {
    // The regression the split exists to prevent. Narrowing the SHARED predicate
    // would have been the small change, and it would have silently taken the
    // pre-setup 503 holding screen off these three — i.e. changed what an
    // unlaunched club exposes to the internet, as a side effect of a CSP decision.
    //
    // For the form pages' TOKEN flows this is also the accepted consequence
    // recorded as #2818 decision 11: pre-setup, an emailed verify/respond/confirm
    // link answers the holding screen rather than the confirmation page, exactly
    // as `/join/verify/[token]` always has. Not carved out — a club that has not
    // finished setup has not sent those emails.
      expect(isPublicWebsitePath(path)).toBe(true);
    },
  );

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

  it("record the eight per-request routes and nothing else", () => {
    // Spelled out for the same reason the fixed-nonce list is: this census is
    // what the runtime SUBTRACTS, so an entry silently lost here hands the fixed,
    // publicly readable nonce to a page that is never stored — and, for the two
    // form pages, would put them back in the CSP census the owner pinned at five.
    expect([...PER_REQUEST_WEBSITE_ROUTES].sort()).toEqual([
      "/booking-requests",
      "/booking-requests/respond/[token]",
      "/booking-requests/verify/[token]",
      "/hut-leader-instructions",
      "/join/[code]",
      "/join/verify/[token]",
      "/school-bookings",
      "/school-bookings/confirm/[token]",
    ]);
  });

  it.each(FORM_PAGE_ADDRESSES)(
    "keeps %s out of the fixed-nonce set and out of the catch-all's territory",
    (path) => {
      // Both halves matter. The first is the CSP decision; the second is what
      // stops an admin creating a CMS page at an address a real route serves —
      // and it is why the public MENU needed its own, wider question
      // (`isBuiltInDynamicPageSlug`) rather than this one.
      expect(isFixedNonceWebsitePath(path)).toBe(false);
      expect(isCmsServablePageSlug(path.replace(/^\//, ""))).toBe(false);
    },
  );

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

/**
 * Percent-encoded addresses, with every expected answer written out LITERALLY.
 *
 * The slice-1 security re-review reported the raw comparison as a high-severity
 * bypass: percent-encode one character of a member address and it stops matching the
 * deny list, so — the argument went — the per-request pages and the member pages
 * would be served under the publicly readable release nonce. The premise is that Next
 * resolves routes from the DECODED path. It does not, and the fix that premise
 * implies would have handed `/join/appl%79` (really the `/join/[code]` page) the fixed
 * nonce, which is the regression rather than the repair.
 *
 * Measured on a container build of this branch (`next start`, next 16.2.12), read off
 * the ISR headers because the catch-all is the only route in either public group that
 * sets `x-nextjs-cache` / `x-nextjs-prerender`. The framework source that explains it
 * is cited in `src/lib/public-website-paths.ts`:
 *
 *     /hut-leader-instructions   200, no ISR headers -> the (website-dynamic) page
 *     /hut-leader-instruction%73 404, ISR headers    -> the CATCH-ALL
 *     /dashboar%64               404, ISR headers    -> the catch-all, not /dashboard
 *     /logi%6E                   404, ISR headers    -> the catch-all, not /login
 *     /join/apply                200, no ISR headers -> the static route
 *     /join/appl%79              404, no ISR headers -> /join/[code], as /join/ANY
 *     /join/verif%79/tok         404, ISR headers    -> the catch-all
 *     /robots%2Etxt              200                 -> the real FILE, served decoded
 *
 * The answers are spelled out as constants rather than derived from the predicate,
 * because a case that asks the predicate what it thinks cannot catch the predicate
 * disagreeing with the route table — which was exactly the gap the review found in
 * the csp-proxy matrix.
 */
describe("percent-encoded addresses are answered as Next answers them", () => {
  it.each([
    // An encoded static route is claimed by NOTHING but the catch-all, so it is
    // catch-all territory and takes the nonce a document stored there needs.
    ["/hut-leader-instruction%73", true, true],
    ["/hut%2Dleader%2Dinstructions", true, true],
    ["/logi%6E", true, true],
    ["/dashboar%64", true, true],
    ["/admi%6E/site-style", true, true],
    // A dynamic route matches its regex against the RAW path, so this one really is
    // the group-join page. Decoding first would have made it fixed-nonce — a
    // genuinely per-request page under the publicly readable value.
    ["/join/appl%79", true, false],
    // ...and the mirror image: an encoded LITERAL segment stops the token route
    // matching, so the catch-all serves it and fixed is right.
    ["/join/verif%79/tok", true, true],
    // `%2F` never invents a segment boundary, here or in Next: one segment, so no
    // fixed-length per-request pattern can claim it.
    ["/join%2Fverify%2Ftok", true, true],
    // The one measured divergence, and it is inert: a static FILE has an `fsPath`
    // and Next does serve it from the decoded path, so `/robots%2Etxt` returns the
    // real file while this classifier still claims the address. The only effect is
    // that a URL nothing emits is answered with the 503 holding screen while setup
    // is incomplete; after setup the answer only picks a nonce for a response that
    // carries no document. Recorded in the module header rather than chased.
    ["/robots%2Etxt", true, true],
    ["/gallery%2Epng", true, true],
  ] as const)(
    "%s -> public %s, fixed nonce %s",
    (path, expectedPublic, expectedFixed) => {
      expect(isPublicWebsitePath(path)).toBe(expectedPublic);
      expect(isFixedNonceWebsitePath(path)).toBe(expectedFixed);
    },
  );

  it("keeps the canonical forms of those addresses where they were", () => {
    // The other half of the pairing: the encoded shapes above must not be read as
    // "encoding does not matter". `/join/apply` is one of the owner's five and
    // `/hut-leader-instructions` is per-request, and both stay that way.
    expect(isFixedNonceWebsitePath("/join/apply")).toBe(true);
    expect(isFixedNonceWebsitePath("/hut-leader-instructions")).toBe(false);
    expect(isPublicWebsitePath("/dashboard")).toBe(false);
    expect(isPublicWebsitePath("/robots.txt")).toBe(false);
    expect(isPublicWebsitePath("/gallery.png")).toBe(false);
  });

  it("does not throw on a malformed escape, and treats it as the literal it is", () => {
    // `decodeURIComponent("%zz")` throws, and Next swallows that and keeps the raw
    // path. Nothing here decodes, so there is nothing to throw — this case exists so
    // that a future decoding attempt cannot land without handling it.
    expect(isFixedNonceWebsitePath("/about%zz")).toBe(true);
    expect(isPublicWebsitePath("/dashboard%zz")).toBe(true);
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
