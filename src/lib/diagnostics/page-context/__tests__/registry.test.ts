/**
 * AID-4 (#2373) — registry CONTRACT tests.
 *
 * These are drift guards, not behaviour tests. Each one pins a property that,
 * if it broke, would silently widen what the Diagnostics page context can read:
 * a row gated below the admin route lattice, a duplicate key, an unbounded
 * allowlist, or a status vocabulary that no longer matches the database.
 */

import { BookingStatus, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ADMIN_PERMISSION_AREAS,
  getAdminRouteRequirement,
} from "@/lib/admin-permissions";

import {
  DIAGNOSTICS_PAGE_CONTEXT_ROUTES,
  DIAGNOSTICS_PAGE_ERROR_CODES,
  getDiagnosticsPageContextRoute,
} from "../registry";
import {
  DIAGNOSTICS_PAGE_CONTEXT_BOUNDS,
  DIAGNOSTICS_RECORD_KINDS,
} from "../types";

const AREA_KEYS = ADMIN_PERMISSION_AREAS.map((area) => area.key);

/** `/admin/members/[id]` -> a concrete path the route lattice can resolve. */
function concretePath(pathname: string): string {
  return pathname.replace(/\[[^\]]+\]/g, "sample-id");
}

describe("registry shape", () => {
  it("registers at least one route and no duplicate keys or pathnames", () => {
    expect(DIAGNOSTICS_PAGE_CONTEXT_ROUTES.length).toBeGreaterThan(0);
    const keys = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.map((r) => r.key);
    const paths = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.map((r) => r.pathname);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("looks a route up by exact key only — no prefix or fallback matching", () => {
    const first = DIAGNOSTICS_PAGE_CONTEXT_ROUTES[0];
    expect(getDiagnosticsPageContextRoute(first.key)).toBe(first);
    expect(getDiagnosticsPageContextRoute(`${first.key}x`)).toBeUndefined();
    expect(
      getDiagnosticsPageContextRoute(first.key.slice(0, -1)),
    ).toBeUndefined();
    expect(getDiagnosticsPageContextRoute("")).toBeUndefined();
    expect(getDiagnosticsPageContextRoute("__proto__")).toBeUndefined();
  });

  it("gives every route a non-empty area list drawn from the real lattice", () => {
    for (const entry of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      expect(entry.requiredAreas.length).toBeGreaterThan(0);
      for (const area of entry.requiredAreas) {
        expect(AREA_KEYS).toContain(area);
      }
      expect(new Set(entry.requiredAreas).size).toBe(
        entry.requiredAreas.length,
      );
    }
  });

  it("declares only server-owned record kinds", () => {
    for (const entry of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      if (entry.recordKind !== null) {
        expect(DIAGNOSTICS_RECORD_KINDS).toContain(entry.recordKind);
      }
    }
  });

  it("keeps every route key and token inside the selector's own bounds", () => {
    for (const entry of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      expect(entry.key.length).toBeLessThanOrEqual(
        DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.routeKeyMaxChars,
      );
      expect(entry.key).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
      for (const token of [
        ...entry.tabs,
        ...entry.steps,
        ...entry.statuses,
        ...entry.errorCodes,
      ]) {
        expect(token.length).toBeLessThanOrEqual(
          DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.tokenMaxChars,
        );
        expect(token).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      }
      for (const key of entry.filterKeys) {
        expect(key.length).toBeLessThanOrEqual(
          DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.filterKeyMaxChars,
        );
        expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
      }
      expect(entry.filterKeys.length).toBeLessThanOrEqual(
        DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.maxFilters,
      );
    }
  });
});

describe("no route is gated below the admin route lattice", () => {
  // The property that matters: page context can never be a side channel around
  // the permission the admin UI itself enforces for the same page.
  it.each(DIAGNOSTICS_PAGE_CONTEXT_ROUTES.map((r) => [r.key, r] as const))(
    "%s requires the lattice's own area for its pathname",
    (_key, entry) => {
      const requirement = getAdminRouteRequirement(
        concretePath(entry.pathname),
        "GET",
      );
      expect(requirement).not.toBeNull();
      expect(requirement?.level).toBe("view");
      expect(entry.requiredAreas).toContain(requirement?.area);
    },
  );
});

describe("status vocabularies track the database", () => {
  const tokenize = (value: string) => value.toLowerCase().replace(/_/g, "-");

  it("uses exactly the BookingStatus enum wherever booking statuses appear", () => {
    const expected = Object.values(BookingStatus).map(tokenize).sort();
    const bookingRoutes = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.filter(
      (entry) => entry.recordKind === "booking" && entry.statuses.length > 0,
    );
    expect(bookingRoutes.length).toBeGreaterThan(0);
    for (const entry of bookingRoutes) {
      expect([...entry.statuses].sort()).toEqual(expected);
    }
  });

  it("uses exactly the PaymentStatus enum wherever payment statuses appear", () => {
    const expected = Object.values(PaymentStatus).map(tokenize).sort();
    const paymentRoutes = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.filter(
      (entry) => entry.recordKind === "payment" && entry.statuses.length > 0,
    );
    expect(paymentRoutes.length).toBeGreaterThan(0);
    for (const entry of paymentRoutes) {
      expect([...entry.statuses].sort()).toEqual(expected);
    }
  });
});

describe("cross-area coverage", () => {
  it("keeps at least one genuinely cross-area (AND) route registered", () => {
    // Bed allocation reads bookings AND the lodge's own bed structure. If this
    // ever drops to zero the AND path stops being exercised by anything real.
    const crossArea = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.filter(
      (entry) => entry.requiredAreas.length > 1,
    );
    expect(crossArea.length).toBeGreaterThan(0);
  });
});

describe("error codes", () => {
  it("shares one closed, transport-level vocabulary", () => {
    expect(new Set(DIAGNOSTICS_PAGE_ERROR_CODES).size).toBe(
      DIAGNOSTICS_PAGE_ERROR_CODES.length,
    );
    for (const entry of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      for (const code of entry.errorCodes) {
        expect(DIAGNOSTICS_PAGE_ERROR_CODES).toContain(code);
      }
    }
  });
});
