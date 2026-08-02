/**
 * AI Diagnostics — the page-context ROUTE REGISTRY (AID-4, epic #2369, #2373).
 *
 * This table is the whole allowlist. A client selector names a `key` in it or is
 * rejected; nothing about a page is accepted from the client except which of
 * these rows it is on, one opaque record id, and tokens this row explicitly
 * permits.
 *
 * FAIL-CLOSED BY CONSTRUCTION. Every token allowlist defaults to EMPTY, and an
 * empty allowlist means the field is REFUSED for that route — not "anything
 * goes". Adding a page therefore starts from "no tabs, no steps, no statuses, no
 * error codes, no filters, no record" and widens one field at a time, which is
 * the opposite of the flat Page help string this replaces.
 *
 * AUTHORIZATION (ADR-002). `requiredAreas` is a CONJUNCTION: the caller needs
 * `view` on every listed area, re-read fresh from the database on every
 * resolution. It is never the union, and it may never be weaker than the admin
 * route lattice's own requirement for `pathname` — pinned by
 * `registry.test.ts`, which resolves each `pathname` through
 * `getAdminRouteRequirement` and asserts the lattice's area is present here.
 *
 * The registry is intentionally SMALL. A page belongs here when an operator
 * plausibly asks "why is this page showing me this?", not merely because it
 * exists; every row is a place personal data could be re-read, so each one is a
 * deliberate decision.
 */

import type { AdminPermissionArea } from "@/lib/admin-permissions";

import type { DiagnosticsRecordKind } from "./types";

/**
 * The generic, operator-visible failure codes a page may report. Closed, small,
 * and deliberately transport-level rather than domain-level: these are the words
 * an admin actually repeats back ("it said Forbidden"), and a domain-specific
 * vocabulary would drift the moment a feature renamed one of its errors.
 */
export const DIAGNOSTICS_PAGE_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not-found",
  "conflict",
  "validation-failed",
  "rate-limited",
  "timeout",
  "server-error",
  "network-error",
] as const;

/**
 * Booking lifecycle statuses, mirrored from the `BookingStatus` Prisma enum.
 * Held as a literal (rather than imported from `@prisma/client`) so this module
 * stays free of the generated client and can be read from a client component;
 * `registry.test.ts` asserts it still equals the enum, so it cannot drift.
 */
const BOOKING_STATUS_TOKENS = [
  "draft",
  "pending",
  "payment-pending",
  "confirmed",
  "paid",
  "bumped",
  "cancelled",
  "completed",
  "waitlisted",
  "waitlist-offered",
  "awaiting-review",
] as const;

/** Payment statuses, mirrored from the `PaymentStatus` Prisma enum (as above). */
const PAYMENT_STATUS_TOKENS = [
  "pending",
  "processing",
  "succeeded",
  "failed",
  "refunded",
  "partially-refunded",
] as const;

/** Stuck-state severities, mirrored from `StuckStateSeverity`. */
const STUCK_STATE_SEVERITY_TOKENS = ["critical", "warning", "info"] as const;

export interface DiagnosticsPageContextRoute {
  /** Stable registry key. The ONLY route identifier a client may send. */
  key: string;
  /**
   * The canonical admin pathname this row describes, `[id]`-style segments
   * included. Server-owned: it is echoed into the evidence for citation and
   * checked against the admin route lattice, never parsed from client input.
   */
  pathname: string;
  /** Plain-English page name, for the evidence block and the UI. */
  label: string;
  /** Admin areas required at `view`, ALL of them (AND). Never empty. */
  requiredAreas: readonly AdminPermissionArea[];
  /**
   * The record kind this page's `recordId` selects, or `null` when the page
   * takes no record. The client picks the ID; the SERVER picks the KIND — which
   * is why a member id sent on a booking route can only ever fail to find a
   * booking, never read a member.
   */
  recordKind: DiagnosticsRecordKind | null;
  tabs: readonly string[];
  steps: readonly string[];
  statuses: readonly string[];
  errorCodes: readonly string[];
  filterKeys: readonly string[];
}

const EMPTY: readonly string[] = [];

function route(
  input: Omit<
    DiagnosticsPageContextRoute,
    "tabs" | "steps" | "statuses" | "errorCodes" | "filterKeys"
  > &
    Partial<
      Pick<
        DiagnosticsPageContextRoute,
        "tabs" | "steps" | "statuses" | "errorCodes" | "filterKeys"
      >
    >,
): DiagnosticsPageContextRoute {
  return {
    tabs: EMPTY,
    steps: EMPTY,
    statuses: EMPTY,
    errorCodes: EMPTY,
    filterKeys: EMPTY,
    ...input,
  };
}

const ROUTES: readonly DiagnosticsPageContextRoute[] = [
  route({
    key: "admin.dashboard",
    pathname: "/admin/dashboard",
    label: "Admin dashboard",
    requiredAreas: ["overview"],
    recordKind: null,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
  route({
    key: "admin.bookings",
    pathname: "/admin/bookings",
    label: "Bookings list",
    requiredAreas: ["bookings"],
    recordKind: "booking",
    statuses: BOOKING_STATUS_TOKENS,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    filterKeys: ["lodgeId", "status", "from", "to", "search"],
  }),
  route({
    key: "admin.booking-approvals",
    pathname: "/admin/booking-approvals",
    label: "Booking approvals queue",
    requiredAreas: ["bookings"],
    recordKind: "booking",
    statuses: BOOKING_STATUS_TOKENS,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
  route({
    key: "admin.waitlist",
    pathname: "/admin/waitlist",
    label: "Waitlist",
    requiredAreas: ["bookings"],
    recordKind: "booking",
    statuses: BOOKING_STATUS_TOKENS,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    filterKeys: ["lodgeId"],
  }),
  route({
    // The one genuinely cross-area row: bed allocation reads the bookings being
    // placed AND the lodge's own room/bed structure, so it needs `view` on both
    // (ADR-002 §3 — AND, never OR).
    key: "admin.bed-allocation",
    pathname: "/admin/bed-allocation",
    label: "Bed allocation",
    requiredAreas: ["bookings", "lodge"],
    recordKind: null,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    filterKeys: ["lodgeId", "date"],
  }),
  route({
    key: "admin.members",
    pathname: "/admin/members",
    label: "Members list",
    requiredAreas: ["membership"],
    recordKind: "member",
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    filterKeys: ["search", "ageTier"],
  }),
  route({
    key: "admin.member-detail",
    pathname: "/admin/members/[id]",
    label: "Member detail",
    requiredAreas: ["membership"],
    recordKind: "member",
    tabs: ["bookings", "xero-activity", "audit-log"],
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
  route({
    key: "admin.payments",
    pathname: "/admin/payments",
    label: "Payments",
    requiredAreas: ["finance"],
    recordKind: "payment",
    statuses: PAYMENT_STATUS_TOKENS,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    filterKeys: ["source", "status", "from", "to"],
  }),
  route({
    key: "admin.stuck-states",
    pathname: "/admin/stuck-states",
    label: "Stuck states dashboard",
    requiredAreas: ["support"],
    recordKind: null,
    statuses: STUCK_STATE_SEVERITY_TOKENS,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    filterKeys: ["domain"],
  }),
  route({
    key: "admin.setup",
    pathname: "/admin/setup",
    label: "Guided setup",
    requiredAreas: ["support"],
    recordKind: null,
    steps: [
      "foundations",
      "booking-rules",
      "cancellation",
      "finance",
      "integrations",
    ],
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
  route({
    key: "admin.health",
    pathname: "/admin/health",
    label: "System health",
    requiredAreas: ["support"],
    recordKind: null,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
];

const ROUTES_BY_KEY: ReadonlyMap<string, DiagnosticsPageContextRoute> = new Map(
  ROUTES.map((entry) => [entry.key, entry]),
);

/** Every registered route, in declaration order. */
export const DIAGNOSTICS_PAGE_CONTEXT_ROUTES = ROUTES;

/**
 * Look a route up by its key. Returns `undefined` for anything not registered —
 * there is no prefix matching, no normalisation, and no fallback route, because
 * every one of those is a way for an unlisted page to acquire a context it was
 * never reviewed for.
 */
export function getDiagnosticsPageContextRoute(
  key: string,
): DiagnosticsPageContextRoute | undefined {
  return ROUTES_BY_KEY.get(key);
}
