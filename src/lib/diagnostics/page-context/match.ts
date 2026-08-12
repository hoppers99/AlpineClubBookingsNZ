/**
 * AI Diagnostics — MATCH A LIVE ADMIN PATHNAME TO A REGISTERED PAGE-CONTEXT ROUTE
 * (AID-7, #2378).
 *
 * The registry holds CANONICAL pathnames with `[id]`-style segments
 * (`/admin/bookings/[id]`); a browser is on a REAL one (`/admin/bookings/clx…`).
 * Something has to join the two, and #2378 is the first issue with a browser in it.
 *
 * WHY THE SERVER DOES THIS AND NOT THE CLIENT. `registry.ts` states the property this
 * module has to preserve: "The client picks the ID; the SERVER picks the KIND — which
 * is why a member id sent on a booking route can only ever fail to find a booking,
 * never read a member." If the browser chose the `routeKey`, it would be choosing the
 * record KIND, and a member id sent with `routeKey: "member-detail"` from a page the
 * operator never opened would resolve as a member read. So the browser sends the one
 * thing it cannot lie about usefully — the address it is on — and the server derives
 * the rest.
 *
 * IT IS AN EXACT MATCH, DELIBERATELY. `getDiagnosticsPageContextRoute` refuses prefix
 * matching, normalisation and fallbacks because "every one of those is a way for an
 * unlisted page to acquire a context it was never reviewed for". This module keeps that
 * rule: same segment count, literals equal, exactly one dynamic segment filled, or no
 * match at all. An unmatched pathname is not an error — it is a page with no registered
 * context, which the resolver reports honestly.
 *
 * NOTHING HERE READS A DATABASE OR CHECKS A PERMISSION. It turns an address into a
 * selector; `resolveDiagnosticsPageContext` then re-validates that selector, re-reads
 * the caller's authority and re-fetches the record. This module cannot widen anyone's
 * access because nothing downstream trusts its output.
 */

import "server-only";

import {
  DIAGNOSTICS_PAGE_CONTEXT_ROUTES,
  type DiagnosticsPageContextRoute,
} from "./registry";

/** A dynamic segment in a canonical pathname: `[id]`, `[bookingId]`, `[...slug]`. */
const DYNAMIC_SEGMENT = /^\[.+\]$/;

export interface MatchedDiagnosticsRoute {
  route: DiagnosticsPageContextRoute;
  /** The value that filled the route's dynamic segment, when it has one. */
  recordId?: string;
}

function segments(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/**
 * Match one live pathname against the registry.
 *
 * A pathname carrying a query string or a fragment is REFUSED rather than trimmed.
 * Trimming would be friendlier and wrong: `?tab=payments` is view state that belongs
 * in the selector's own allowlisted `tab` field, where the registry checks it against
 * that route's declared tabs. Silently discarding it here would let a client believe it
 * had sent view state that never arrived, and would put this module in the business of
 * parsing addresses — which is where an unlisted page starts acquiring a context.
 */
export function matchDiagnosticsPageRoute(
  pathname: string,
): MatchedDiagnosticsRoute | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  if (pathname.includes("?") || pathname.includes("#")) return null;

  const live = segments(pathname);

  for (const route of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
    const canonical = segments(route.pathname);
    if (canonical.length !== live.length) continue;

    let recordId: string | undefined;
    let matched = true;
    for (let index = 0; index < canonical.length; index += 1) {
      const expected = canonical[index];
      const actual = live[index];
      if (DYNAMIC_SEGMENT.test(expected)) {
        // A dynamic segment is the record id. Only ONE is expected; a route with two
        // would make "which one is the record" a guess, so the second refuses the
        // whole match rather than silently overwriting the first.
        if (recordId !== undefined) {
          matched = false;
          break;
        }
        if (actual.length === 0) {
          matched = false;
          break;
        }
        recordId = actual;
        continue;
      }
      if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    // A route that takes no record must not report one, and a route that takes one
    // must have found it. Either mismatch means this is not the row that describes
    // this address.
    if (route.recordKind === null && recordId !== undefined) continue;
    if (route.recordKind !== null && recordId === undefined) continue;

    return recordId === undefined ? { route } : { route, recordId };
  }

  return null;
}
