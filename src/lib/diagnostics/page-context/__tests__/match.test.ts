/**
 * MATCHING A LIVE PATHNAME TO A REGISTERED ROUTE (AID-7, #2378).
 *
 * The security property this file protects is stated in `registry.ts`: "The client
 * picks the ID; the SERVER picks the KIND — which is why a member id sent on a booking
 * route can only ever fail to find a booking, never read a member." The matcher is what
 * keeps that true once a browser is involved, so the cases below are the ways a
 * too-generous match would hand a client the choice of record kind.
 */

import { describe, expect, it } from "vitest";

import { matchDiagnosticsPageRoute } from "../match";
import { DIAGNOSTICS_PAGE_CONTEXT_ROUTES } from "../registry";

/** A registered route that takes a record, discovered rather than hard-coded. */
const recordRoute = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.find(
  (route) => route.recordKind !== null && route.pathname.includes("["),
);
/** A registered route that takes none. */
const staticRoute = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.find(
  (route) => route.recordKind === null && !route.pathname.includes("["),
);

describe("the registry offers both shapes, so the cases below are not vacuous", () => {
  it("has at least one record route and one static route", () => {
    expect(recordRoute).toBeDefined();
    expect(staticRoute).toBeDefined();
  });
});

describe("matching is exact (#2378)", () => {
  it("matches a static route and reports no record", () => {
    const matched = matchDiagnosticsPageRoute(staticRoute!.pathname);
    expect(matched?.route.key).toBe(staticRoute!.key);
    expect(matched?.recordId).toBeUndefined();
  });

  it("fills the dynamic segment with the id and picks the SERVER's kind", () => {
    const live = recordRoute!.pathname.replace(/\[[^\]]+\]/, "clx0123456789abcdefgh");
    const matched = matchDiagnosticsPageRoute(live);
    expect(matched?.route.key).toBe(recordRoute!.key);
    expect(matched?.recordId).toBe("clx0123456789abcdefgh");
    // The kind came from the registry row, not from anything in the URL.
    expect(matched?.route.recordKind).toBe(recordRoute!.recordKind);
  });

  it("refuses a PREFIX rather than inheriting a parent route's context", () => {
    // `getDiagnosticsPageContextRoute` refuses prefix matching because "every one of
    // those is a way for an unlisted page to acquire a context it was never reviewed
    // for". A deeper path must not match its parent.
    expect(
      matchDiagnosticsPageRoute(`${staticRoute!.pathname}/something/else`),
    ).toBeNull();
  });

  it("never resolves an EMPTY dynamic segment into a record", () => {
    // `/admin/members/[id]` with the id removed is `/admin/members/`, which is the
    // members LIST — and matching it there is correct. What must never happen is the
    // detail route matching with an empty or invented id, because that id would seed
    // the consent ledger. So the assertion is about the record, not about null.
    const live = recordRoute!.pathname.replace(/\[[^\]]+\]/, "");
    const matched = matchDiagnosticsPageRoute(live);
    expect(matched?.route.key).not.toBe(recordRoute!.key);
    expect(matched?.recordId).toBeUndefined();
  });

  it("refuses an unregistered admin page", () => {
    expect(matchDiagnosticsPageRoute("/admin/definitely-not-registered")).toBeNull();
  });

  it("refuses a query string or a fragment rather than trimming it", () => {
    // Trimming would be friendlier and wrong: `?tab=payments` is view state that
    // belongs in the selector's allowlisted `tab` field, where the registry checks it
    // against that route's declared tabs.
    expect(matchDiagnosticsPageRoute(`${staticRoute!.pathname}?tab=payments`)).toBeNull();
    expect(matchDiagnosticsPageRoute(`${staticRoute!.pathname}#section`)).toBeNull();
  });

  it("refuses anything that is not an absolute path", () => {
    for (const value of ["", "admin/bookings", "https://evil.example/admin"]) {
      expect(matchDiagnosticsPageRoute(value)).toBeNull();
    }
  });

  it("never returns a record id for a route that takes none", () => {
    // The direction that matters: a static route reporting a record id would seed the
    // consent ledger with a record the page never named.
    for (const route of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      if (route.recordKind !== null) continue;
      const matched = matchDiagnosticsPageRoute(route.pathname);
      expect(matched?.recordId).toBeUndefined();
    }
  });

  it("every registered route matches its own canonical pathname", () => {
    // A census over the whole registry: a row whose pathname this matcher cannot
    // resolve is a page whose context is unreachable from a browser, which would look
    // exactly like "diagnostics found nothing" to an operator.
    for (const route of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      const live = route.pathname.replace(/\[[^\]]+\]/g, "clx0123456789abcdefgh");
      const matched = matchDiagnosticsPageRoute(live);
      expect(matched, `${route.key} (${route.pathname}) did not match`).not.toBeNull();
      expect(matched!.route.key).toBe(route.key);
    }
  });
});
