/**
 * AID-4 (#2373) — the pure authorization predicates.
 *
 * `resolve.test.ts` covers these through the real resolution path; this file
 * pins the two edges that path cannot reach, because the registry forbids them:
 * an EMPTY required-area list (which must deny, not admit everyone) and the
 * exact AND semantics across an arbitrary set of areas.
 */

import { describe, expect, it } from "vitest";

import type {
  AdminPermissionArea,
  AdminPermissionMatrix,
} from "@/lib/admin-permissions";

import { hasAllAreaViews, missingAreaViews } from "../authorize";

function matrix(
  overrides: Partial<AdminPermissionMatrix> = {},
): AdminPermissionMatrix {
  return {
    overview: "none",
    bookings: "none",
    membership: "none",
    finance: "none",
    lodge: "none",
    content: "none",
    support: "none",
    ...overrides,
  };
}

describe("hasAllAreaViews", () => {
  it("denies an EMPTY area list — never admits everyone by default", () => {
    // A route that required nothing would be a route anyone may read. This is
    // the fail-closed default the registry contract also forbids.
    expect(hasAllAreaViews(matrix({ finance: "edit" }), [])).toBe(false);
  });

  it("requires every listed area, not any of them", () => {
    const areas: AdminPermissionArea[] = ["bookings", "lodge"];
    expect(hasAllAreaViews(matrix({ bookings: "view" }), areas)).toBe(false);
    expect(hasAllAreaViews(matrix({ lodge: "view" }), areas)).toBe(false);
    expect(
      hasAllAreaViews(matrix({ bookings: "view", lodge: "view" }), areas),
    ).toBe(true);
  });

  it("accepts edit as satisfying a view requirement", () => {
    expect(hasAllAreaViews(matrix({ finance: "edit" }), ["finance"])).toBe(
      true,
    );
  });

  it("ignores levels held on areas the route did not ask for", () => {
    expect(
      hasAllAreaViews(matrix({ overview: "edit", content: "edit" }), [
        "finance",
      ]),
    ).toBe(false);
  });
});

describe("missingAreaViews", () => {
  it("lists only the unmet areas, in the route's own order", () => {
    expect(
      missingAreaViews(matrix({ lodge: "view" }), [
        "bookings",
        "lodge",
        "finance",
      ]),
    ).toEqual(["bookings", "finance"]);
  });

  it("is empty when every area is held", () => {
    expect(
      missingAreaViews(matrix({ support: "view" }), ["support"]),
    ).toEqual([]);
  });
});
