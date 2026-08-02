/**
 * AI Diagnostics — selector parsing and route-scoped allowlisting (AID-4, #2373).
 *
 * Three layers, all fail-closed:
 *
 *  0. RESERVED KEYS — `__proto__` and friends, refused here because zod's
 *     `record` cannot see them (it drops them silently, which is a partial
 *     rejection and therefore a contract breach — see `RESERVED_KEYS`).
 *  1. STRUCTURAL — `diagnosticsPageSelectorSchema` (strict zod): known keys
 *     only, bounded lengths, tight character classes, no control characters.
 *  2. ROUTE-SCOPED — this module: the route must be registered, and every token
 *     must be in THAT route's allowlist. An empty allowlist refuses the field
 *     outright, so a page that declares no tabs can never be sent one.
 *
 * Rejection is total, never partial. A selector carrying one bad token does not
 * quietly lose that token and proceed — it is refused, and the caller reports
 * `invalid_selector`. Silently repairing malformed input is how a bypass gets
 * built: the client learns which fields are dropped and which survive.
 *
 * NOTHING IS ECHOED. Issues are stable machine codes naming the FIELD, never the
 * value, so a rejected selector cannot use the error path as an output channel
 * (into a log, an audit row, or an operator's screen).
 */

import {
  DIAGNOSTICS_PAGE_CONTEXT_BOUNDS,
  diagnosticsPageSelectorSchema,
  type DiagnosticsPageSelector,
} from "./types";
import {
  getDiagnosticsPageContextRoute,
  type DiagnosticsPageContextRoute,
} from "./registry";

/**
 * Machine codes for a rejected selector. `<field>_not_allowed` means the value
 * failed the ROUTE's allowlist (including the "route allows none of these"
 * case); `malformed` means it failed the structural schema.
 */
export type DiagnosticsSelectorIssue =
  | "malformed"
  | "unknown_route"
  | "record_not_allowed"
  | "tab_not_allowed"
  | "step_not_allowed"
  | "status_not_allowed"
  | "error_code_not_allowed"
  | "filter_not_allowed";

export type ParsedDiagnosticsPageSelector =
  | {
      ok: true;
      selector: DiagnosticsPageSelector;
      route: DiagnosticsPageContextRoute;
    }
  | { ok: false; issues: DiagnosticsSelectorIssue[] };

/**
 * Keys that must never travel, in the selector or in `filters`. `__proto__` is
 * the load-bearing one: zod's `record` never surfaces it to the key schema, and
 * assigning it onto the fresh output object is a setter no-op, so it DISAPPEARS
 * instead of being refused — the one filter key a client could send to a route
 * that allowlists no filters at all and still be accepted. There is no
 * prototype pollution today (values are strings and nothing reads the
 * prototype), but "rejection is total, never partial" is the contract this
 * module exists to hold, so the key is refused explicitly rather than lost.
 */
const RESERVED_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
];

/**
 * Own-property scan of the RAW input, before the schema runs — the only place
 * `__proto__` is still visible. `Object.getOwnPropertyNames` is deliberate:
 * `JSON.parse` defines `__proto__` as an ordinary own property, and this must see
 * it whether or not it is enumerable.
 */
function hasReservedKey(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  if (Object.getOwnPropertyNames(input).some((k) => RESERVED_KEYS.includes(k))) {
    return true;
  }
  const filters = (input as { filters?: unknown }).filters;
  if (typeof filters !== "object" || filters === null) return false;
  return Object.getOwnPropertyNames(filters).some((k) =>
    RESERVED_KEYS.includes(k),
  );
}

/**
 * A token is accepted only when the route's allowlist for that field contains
 * it. An EMPTY allowlist accepts nothing — the field is not supported on this
 * page, which is a rejection rather than a pass-through.
 */
function allows(allowlist: readonly string[], value: string | undefined) {
  if (value === undefined) return true;
  return allowlist.includes(value);
}

/**
 * Validate an untrusted selector structurally, then against its route's own
 * allowlists. Returns the route alongside the selector so callers never re-look
 * it up (and so cannot accidentally resolve a DIFFERENT route than the one that
 * was validated).
 */
export function parseDiagnosticsPageSelector(
  input: unknown,
): ParsedDiagnosticsPageSelector {
  // Layer 0: the keys the schema structurally cannot refuse for itself. Same
  // outcome as any other structural failure, and no value is echoed.
  if (hasReservedKey(input)) return { ok: false, issues: ["malformed"] };

  const structural = diagnosticsPageSelectorSchema.safeParse(input);
  if (!structural.success) return { ok: false, issues: ["malformed"] };

  const selector = structural.data;
  const route = getDiagnosticsPageContextRoute(selector.routeKey);
  if (!route) return { ok: false, issues: ["unknown_route"] };

  const issues: DiagnosticsSelectorIssue[] = [];

  // A record id is meaningful only where the SERVER declared a record kind for
  // this page. Sending one to a page that takes no record is a rejection, not a
  // no-op: it is the shape an operator-selects-a-record probe would take.
  if (selector.recordId !== undefined && route.recordKind === null) {
    issues.push("record_not_allowed");
  }

  if (!allows(route.tabs, selector.tab)) issues.push("tab_not_allowed");
  if (!allows(route.steps, selector.step)) issues.push("step_not_allowed");
  if (!allows(route.statuses, selector.status)) {
    issues.push("status_not_allowed");
  }
  if (!allows(route.errorCodes, selector.errorCode)) {
    issues.push("error_code_not_allowed");
  }

  const filterKeys = Object.keys(selector.filters ?? {});
  if (
    filterKeys.length > DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.maxFilters ||
    filterKeys.some((key) => !route.filterKeys.includes(key))
  ) {
    issues.push("filter_not_allowed");
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, selector, route };
}
