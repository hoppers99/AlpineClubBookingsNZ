import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_GROUP_DYNAMIC_ROUTES,
  pageSlugFromPathname,
} from "@/components/website-footer-shell";
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
const DYNAMIC_ROUTES = [
  ...PER_REQUEST_WEBSITE_ROUTES,
  ...PUBLIC_GROUP_DYNAMIC_ROUTES,
].filter((route) => route.includes("["));

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

  it("strips the PAYMENT token, on the payment page itself (#2827)", () => {
    // The one that matters most, called out on its own so a future edit to the
    // route lists cannot quietly drop it while the parameterised cases above
    // still pass over whatever is left. `/pay/[token]` is where the group-join
    // flow hands the visitor off, and its segment IS the payment bearer
    // credential.
    expect(pageSlugFromPathname(`/pay/${TOKEN}`)).toBe("pay/[token]");
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

/**
 * The anti-rot half of the #2827 census fix.
 *
 * `(website-dynamic)`'s shapes come from a published census that
 * `check-website-render-modes.mjs` keeps equal to the route tree. The `(public)`
 * group has no such census, so its list in `website-footer-shell.tsx` is written
 * by hand — and a hand-written list of "routes whose segment is a secret" rots in
 * the dangerous direction: the day someone adds `(public)/something/[token]` and
 * forgets the list, that token starts being stamped into `data-page-slug` again
 * and nothing fails.
 *
 * So the list is compared against the directory tree on disk instead of trusted.
 */
describe("the (public) dynamic-route list matches the real route tree (#2827)", () => {
  const PUBLIC_GROUP_DIR = path.join(process.cwd(), "src", "app", "(public)");

  /**
   * Every address under `(public)` that a `page.tsx` serves, as a route pattern —
   * Next's own rules: `(group)` directories are not path segments, `[param]` ones
   * are kept verbatim.
   */
  function routesUnder(directory: string, prefix: string): string[] {
    const entries = readdirSync(directory, { withFileTypes: true });
    const here = entries.some((entry) => entry.isFile() && entry.name === "page.tsx")
      ? [prefix === "" ? "/" : prefix]
      : [];

    return entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name !== "__tests__" && entry.name !== "_components")
      .flatMap((entry) =>
        routesUnder(
          path.join(directory, entry.name),
          // A route GROUP contributes no segment, which is exactly why
          // `(public)` itself does not appear in any of these addresses.
          entry.name.startsWith("(") ? prefix : `${prefix}/${entry.name}`,
        ),
      )
      .concat(here);
  }

  const dynamicRoutesOnDisk = routesUnder(PUBLIC_GROUP_DIR, "")
    .filter((route) => route.includes("["))
    .sort();

  it("finds dynamic routes to check, so this suite cannot pass vacuously", () => {
    expect(dynamicRoutesOnDisk.length).toBeGreaterThan(0);
  });

  it("covers every dynamic (public) route, and claims no route that is gone", () => {
    // Equality in both directions on purpose. A missing entry reopens the oracle;
    // a stale entry is a shape claimed for an address nothing serves, which would
    // silently start rewriting a real page's slug if that address were ever reused.
    expect([...PUBLIC_GROUP_DYNAMIC_ROUTES].sort()).toEqual(dynamicRoutesOnDisk);
  });

  it("stamps a shape, never the value, for each of them", () => {
    for (const route of dynamicRoutesOnDisk) {
      const slug = pageSlugFromPathname(addressFor(route, TOKEN));
      expect(slug).toBe(route.replace(/^\//, ""));
      expect(slug).not.toContain(TOKEN.slice(0, 4));
    }
  });
});
