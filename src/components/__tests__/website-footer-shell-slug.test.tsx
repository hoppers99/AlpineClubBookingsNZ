import { describe, expect, it } from "vitest";
import { pageSlugFromPathname } from "@/components/website-footer-shell";
import { PER_REQUEST_WEBSITE_ROUTES } from "@/lib/public-website-paths";

/**
 * `data-page-slug` must never carry the VALUE of a dynamic URL segment (#2818
 * decision 8).
 *
 * The footer stamps the attribute so an admin's Raw CSS can style a particular
 * page. Attribute selectors read a value one character at a time
 * (`[data-page-slug^="…a"]`), so stamping the raw pathname put every one-time
 * token in the product — booking-request verify and respond, school attendee
 * confirmation, group-join verification — and the group-join CODE into something
 * admin CSS can exfiltrate. The attribute must therefore hold the route SHAPE.
 *
 * Parameterised over the real census rather than over a list typed out here: a
 * token route added to `(website-dynamic)` and forgotten by a hand-written
 * mirror would silently start stamping its token again, and this suite would
 * still be green. `check-website-render-modes.mjs` keeps that census equal to the
 * route tree, so driving off it means a new token route is covered the moment it
 * exists.
 */

/** A value with the shape of a real 64-hex one-time token. */
const TOKEN = "9f3a".repeat(16);

/** The census entries that actually have a value to leak. */
const DYNAMIC_ROUTES = PER_REQUEST_WEBSITE_ROUTES.filter((route) =>
  route.includes("["),
);

/** `/a/[token]` with each dynamic segment filled in with `value`. */
function addressFor(route: string, value: string): string {
  return route
    .split("/")
    .map((segment) => (segment.startsWith("[") ? value : segment))
    .join("/");
}

describe("data-page-slug never contains a dynamic segment's value (#2818)", () => {
  it("covers every dynamic public route, and there is at least one", () => {
    // A parameterised suite that iterates an empty list passes while asserting
    // nothing. This is the guard against the census being renamed out from under
    // it.
    expect(DYNAMIC_ROUTES.length).toBeGreaterThan(0);
  });

  it.each(DYNAMIC_ROUTES)("stamps the route shape for %s", (route) => {
    const slug = pageSlugFromPathname(addressFor(route, TOKEN));

    expect(slug).toBe(route.replace(/^\//, ""));
    expect(slug).not.toContain(TOKEN);
  });

  it.each(DYNAMIC_ROUTES)(
    "leaks no part of the value for %s, even one character",
    (route) => {
      // The exfiltration is prefix-by-prefix, so "does not contain the whole
      // token" is too weak a claim: a slug holding the first character already
      // hands an attacker a working `^=` oracle.
      const slug = pageSlugFromPathname(addressFor(route, TOKEN));

      for (let length = 1; length <= 8; length += 1) {
        expect(slug).not.toContain(TOKEN.slice(0, length));
      }
    },
  );

  it("strips a group JOIN CODE too, not only the 64-hex tokens", () => {
    // `/join/[code]` is the pre-existing exposure this also closes. A short
    // human-typed code is if anything easier to read out character by character.
    expect(pageSlugFromPathname("/join/ABC123")).toBe("join/[code]");
  });

  it("matches raw segments, so a percent-encoded token is not stamped verbatim", () => {
    // The predicates in `public-website-paths.ts` compare raw segments because
    // Next routes raw. Decoding here would let an encoded form miss the shape
    // match and fall through to the raw-pathname branch.
    const encoded = `/join/verify/${TOKEN}%2E`;
    expect(pageSlugFromPathname(encoded)).toBe("join/verify/[token]");
  });

  it("leaves ordinary pages alone, so admin CSS keeps working", () => {
    expect(pageSlugFromPathname("/")).toBe("home");
    expect(pageSlugFromPathname(null)).toBe("home");
    expect(pageSlugFromPathname("/contact")).toBe("contact");
    expect(pageSlugFromPathname("/trips/2026")).toBe("trips/2026");
    // The two bare form pages are static addresses: no segment value, so they
    // are stamped as themselves and remain individually styleable.
    expect(pageSlugFromPathname("/booking-requests")).toBe("booking-requests");
    expect(pageSlugFromPathname("/school-bookings")).toBe("school-bookings");
  });

  it("matches on segment COUNT, exactly as the route table does", () => {
    // `/join/verify` is two segments, so it is not the three-segment
    // `/join/verify/[token]` route — Next serves it from `/join/[code]` with
    // code="verify", and the stamped shape says so. That agreement is the point:
    // the attribute names the route that actually rendered.
    expect(pageSlugFromPathname("/join/verify")).toBe("join/[code]");
    // Four segments match nothing in the census and fall through to the
    // catch-all, which is where the raw path is the honest answer.
    expect(pageSlugFromPathname("/join/verify/a/b")).toBe("join/verify/a/b");
  });
});
