import { describe, expect, it } from "vitest";
import {
  buildAnalyticsPageLocation,
  isAnalyticsEligiblePath,
  sanitiseAnalyticsReferrer,
} from "@/lib/analytics-route-policy";
import {
  FIXED_NONCE_WEBSITE_ROUTES,
  NON_WEBSITE_ROOT_SEGMENTS,
  PER_REQUEST_WEBSITE_ROUTES,
} from "@/lib/public-website-paths";

/**
 * The safe-route and URL policy of owner decision section 7 (#2573), pinned in BOTH
 * directions as that section requires: excluded pages must not load or call Google
 * Analytics, and an eligible page view must carry no query string and no fragment.
 *
 * The policy is enforcement, not documentation, so these assertions are the contract:
 * a change that widened `isAnalyticsEligiblePath` onto an admin route, a token route
 * or an identifier-shaped address would fail here rather than ship a leak.
 */

describe("analytics route policy — eligible addresses", () => {
  it("admits the ordinary public website pages", () => {
    for (const path of ["/", "/contact", "/join", "/join/apply"]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(true);
    }
  });

  it("admits admin-authored CMS page slugs, nested ones included", () => {
    for (const path of [
      "/about",
      "/about-the-club",
      "/trips/2026",
      "/lodges/pinnacle-ridge/photos",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(true);
    }
  });

  it("ignores one trailing slash rather than refusing the address", () => {
    expect(isAnalyticsEligiblePath("/contact/")).toBe(true);
    expect(buildAnalyticsPageLocation("https://club.test", "/contact/")).toBe(
      "https://club.test/contact",
    );
  });

  it("keeps every fixed-nonce website route eligible", () => {
    // Derived from the route census rather than typed out again: a sixth approved
    // public route should become analytics-eligible the day it is added, without
    // anyone remembering to edit a second list.
    for (const route of FIXED_NONCE_WEBSITE_ROUTES) {
      if (route.includes("[")) continue;
      expect(isAnalyticsEligiblePath(route), route).toBe(true);
    }
  });
});

describe("analytics route policy — the owner's exclusion list", () => {
  it("refuses admin routes", () => {
    for (const path of [
      "/admin",
      "/admin/integrations",
      "/admin/members/abc123",
      "/admin/bookings",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(false);
    }
  });

  it("refuses authenticated member and dashboard routes", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/bookings",
      "/bookings/cm123abc",
      "/profile",
      "/calendar",
      "/book",
      "/notices",
      "/nominations",
      "/induction",
      "/lodge-instructions",
      "/finance",
      "/lodge/history",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(false);
    }
  });

  it("refuses login, recovery, verification and invitation routes", () => {
    for (const path of [
      "/login",
      "/login/verify",
      "/register",
      "/forgot-password",
      "/reset-password",
      "/change-password",
      "/verify-email",
      "/confirm-email-change",
      "/family-invite/tok_abc123",
      "/membership-cancellation/tok_abc123",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(false);
    }
  });

  it("refuses token-bearing, PIN-bearing and payment callback routes", () => {
    for (const path of [
      "/pay/tok_abc123",
      "/chores/tok_abc123",
      "/booking-requests/respond/tok_abc123",
      "/booking-requests/verify/tok_abc123",
      "/school-bookings/confirm/tok_abc123",
      // The three (website-dynamic) pages: a PIN-gated page and two code/token ones.
      "/hut-leader-instructions",
      "/join/AB12CD",
      "/join/verify/tok_abc123",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(false);
    }
  });

  it("refuses every non-website root segment, derived from the route census", () => {
    // The belt for the same reason the predicate is derived rather than hand-written:
    // a route group added later is excluded the day it is added.
    for (const segment of NON_WEBSITE_ROOT_SEGMENTS) {
      expect(isAnalyticsEligiblePath(`/${segment}`), segment).toBe(false);
      expect(isAnalyticsEligiblePath(`/${segment}/anything`), segment).toBe(
        false,
      );
    }
  });

  it("refuses every per-request website route", () => {
    for (const route of PER_REQUEST_WEBSITE_ROUTES) {
      const path = route.replace(/\[[^\]]+\]/g, "sample");
      expect(isAnalyticsEligiblePath(path), path).toBe(false);
    }
  });
});

describe("analytics route policy — credential-shaped addresses the catch-all claims", () => {
  /*
    The catch-all claims every URL no other route matches, so gate 1 alone would admit
    addresses that carry an opaque identifier. Gate 2 is what refuses them, and these
    are the shapes it exists for.
  */
  it("refuses an opaque identifier segment", () => {
    for (const path of [
      "/reset/AbCdEf0123456789xyz",
      "/ABC123XYZ",
      "/user_12345",
      "/page.php",
      "/some%2Fencoded",
      "/UPPERCASE",
      "/a/b/c/d/e",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(false);
    }
  });

  it("refuses a LOWERCASE opaque identifier, which the slug pattern alone admits", () => {
    // The gap the identifier heuristic closes: a lowercase hex token, a cuid and a
    // base32 code are all valid lowercase-alphanumeric slug segments, so without it
    // the catch-all's 404 for one of these addresses would report the identifier to
    // Google verbatim.
    for (const path of [
      "/t/9f8e7d6c5b4a39281706",
      "/cm5x9q2ab000108l3f4g5h6i",
      "/9f8e7d6c5b4a39281706",
      "/pages/a1b2c3d4e5f6a7b8",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(false);
    }
  });

  it("refuses a HYPHENATED opaque identifier, UUIDs included", () => {
    // The hole this closes: the first cut exempted any segment containing a hyphen,
    // so a canonical UUID — the most common token format there is — matched the slug
    // pattern chunk for chunk and was reported to Google verbatim. Inserting three
    // hyphens into a hex token defeated the check outright.
    for (const path of [
      "/s/550e8400-e29b-41d4-a716-446655440000",
      "/550e8400-e29b-41d4-a716-446655440000",
      "/t/9f8e7d6c-5b4a-3928-1706",
      "/pages/a1b2c3d4-e5f6-a7b8",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(false);
      expect(buildAnalyticsPageLocation("https://club.test", path), path).toBeNull();
    }
  });

  it("refuses a long pure-digit segment, which carries no letter to notice", () => {
    expect(isAnalyticsEligiblePath("/b/123456789012345678")).toBe(false);
    expect(isAnalyticsEligiblePath("/1234567")).toBe(false);
    // …while a year, a decade or a room number is still a title.
    expect(isAnalyticsEligiblePath("/2026")).toBe(true);
    expect(isAnalyticsEligiblePath("/trips/1926")).toBe(true);
  });

  it("does not refuse a real page slug that merely contains a digit", () => {
    // Hyphenated words, short segments and digit-free words are all unaffected —
    // including the ones the tightened identifier test has to walk past: a
    // hyphen-joined title is long, mixes letters and digits, and must stay eligible.
    for (const path of [
      "/trips/2026",
      "/trips-2026",
      "/annual-general-meeting",
      "/accommodation",
      "/lodge-2-photos",
      "/notice-2026-agm",
      "/agm-2026-notes-v2",
      "/winter-programme-2026",
      "/pinnacle-ridge-lodge-2026-season",
      "/e2e-test-page",
      "/covid19-update",
      "/top-10-trips-2026",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(true);
    }
  });

  /*
    The two ACCEPTED costs of gate 2, pinned as deliberate rather than left to be
    rediscovered as bugs. Both are named in the module docblock and in the operator
    troubleshooting row in `docs/guides/integrations.md`, which is the only place a
    club is told why one of its pages reports no views — so if either of these flips,
    that documentation has gone stale and this should say so.
  */
  it("loses page views for the two slug shapes the policy deliberately refuses", () => {
    // Condition 3: one long unhyphenated word mixing letters and digits reads as an
    // opaque identifier, and nothing structural tells it from a token.
    expect(isAnalyticsEligiblePath("/newsletter2026")).toBe(false);
    // A whole-segment credential word, even as a club's real page title.
    expect(isAnalyticsEligiblePath("/verify")).toBe(false);
    // Hyphenate the first and it comes back, which is the fix the operator guide gives.
    expect(isAnalyticsEligiblePath("/newsletter-2026")).toBe(true);
  });

  it("refuses credential-flavoured whole segments", () => {
    for (const path of [
      "/verify/abc123",
      "/invite/abc123",
      "/token/abc123",
      "/pin/1234",
      "/callback/google",
      "/oauth/return",
      "/recovery",
      "/secret",
      "/session",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(false);
    }
  });

  it("does not refuse an ordinary page whose title merely contains such a word", () => {
    // Whole-segment matching only, so a real CMS page is not collateral damage.
    // `/verify-your-booking` is here because the module docblock cites it as still
    // eligible: it previously claimed the opposite, which was wrong, and the claim
    // is only worth making if something pins it.
    for (const path of [
      "/overview",
      "/verification-of-membership",
      "/verify-your-booking",
      "/pinnacle-ridge",
      "/code-of-conduct",
      "/returns-policy",
    ]) {
      expect(isAnalyticsEligiblePath(path), path).toBe(true);
    }
  });

  it("refuses an over-long segment, which is an identifier rather than a title", () => {
    expect(isAnalyticsEligiblePath(`/${"a".repeat(61)}`)).toBe(false);
    expect(isAnalyticsEligiblePath(`/${"a".repeat(60)}`)).toBe(true);
  });

  it("fails closed on a value that is not a pathname at all", () => {
    for (const value of [
      "",
      "contact",
      "https://club.test/contact",
      "/contact?utm_source=news",
      "/contact#section",
      "//evil.test/contact",
    ]) {
      expect(isAnalyticsEligiblePath(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("buildAnalyticsPageLocation", () => {
  it("sends origin and pathname only", () => {
    expect(buildAnalyticsPageLocation("https://club.test", "/contact")).toBe(
      "https://club.test/contact",
    );
    expect(buildAnalyticsPageLocation("https://club.test/", "/")).toBe(
      "https://club.test/",
    );
  });

  it("cannot be handed a query string or a fragment", () => {
    // The eligibility gate refuses the whole value rather than stripping it, so a
    // caller that passed a full URL gets `null` and sends nothing.
    expect(
      buildAnalyticsPageLocation("https://club.test", "/contact?token=abc"),
    ).toBeNull();
    expect(
      buildAnalyticsPageLocation("https://club.test", "/contact#pin-1234"),
    ).toBeNull();
  });

  it("returns null for every excluded address, so eligibility cannot be forgotten", () => {
    for (const path of [
      "/admin/members/abc123",
      "/pay/tok_abc123",
      "/dashboard",
      "/join/verify/tok_abc123",
    ]) {
      expect(
        buildAnalyticsPageLocation("https://club.test", path),
        path,
      ).toBeNull();
    }
  });
});

describe("sanitiseAnalyticsReferrer", () => {
  const origin = "https://club.test";

  it("sends nothing when there is no usable referrer", () => {
    expect(sanitiseAnalyticsReferrer("", origin)).toBeNull();
    expect(sanitiseAnalyticsReferrer(null, origin)).toBeNull();
    expect(sanitiseAnalyticsReferrer(undefined, origin)).toBeNull();
    expect(sanitiseAnalyticsReferrer("not a url", origin)).toBeNull();
  });

  it("keeps origin and pathname for an eligible same-origin referrer", () => {
    expect(
      sanitiseAnalyticsReferrer(`${origin}/about?utm=x#frag`, origin),
    ).toBe(`${origin}/about`);
  });

  it("reduces an EXCLUDED same-origin referrer to the origin", () => {
    // This is the leak the function exists to close: a visitor who lands on a
    // payment token page and clicks through would otherwise hand Google the token.
    for (const path of [
      "/pay/tok_secret123",
      "/reset-password?token=abc123",
      "/admin/members/mem_123",
      "/join/verify/tok_secret123",
      "/dashboard",
    ]) {
      expect(sanitiseAnalyticsReferrer(`${origin}${path}`, origin), path).toBe(
        origin,
      );
    }
  });

  it("reduces a cross-origin referrer to its origin", () => {
    expect(
      sanitiseAnalyticsReferrer(
        "https://www.google.com/search?q=alpine+club&uid=12345",
        origin,
      ),
    ).toBe("https://www.google.com");
  });
});
