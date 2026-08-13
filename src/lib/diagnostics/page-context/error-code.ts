/**
 * AI Diagnostics — HTTP status to the registry's operator-visible error code
 * (#2816, review finding 13 Aug 2026).
 *
 * WHY A PAGE NEEDS THIS AT ALL. A list page publishes the filters it APPLIED, and
 * a failed load has applied nothing — there is no list on screen to be filtered.
 * Publishing `{}` there would be a lie of a subtler kind than publishing the
 * address: `{}` asserts "I applied no filters", so a model asked "why is this
 * payment not here?" reads a page that is showing nothing because of an outage and
 * confidently blames the activity window. Publishing the error code says "I have no
 * list, and here is why", which is the answer.
 *
 * Every registry row allowlists the whole `DIAGNOSTICS_PAGE_ERROR_CODES` set, so a
 * code from here always survives the route's allowlist filter.
 *
 * NO RUNTIME IMPORT OF THE REGISTRY. The type is imported type-only, so a client
 * page can call this without pulling the route table into its bundle.
 */

import type { DiagnosticsPageErrorCode } from "./registry";

/**
 * The code for a response the page could not use. The mapping is deliberately
 * coarse and transport-level, matching the registry's own reasoning that these are
 * "the words an admin actually repeats back". Anything unrecognised lands on
 * `server-error` rather than being dropped: a page that failed to load must never
 * publish silence.
 */
export function diagnosticsPageErrorCodeForStatus(
  status: number,
): DiagnosticsPageErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "validation-failed";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 408:
    case 504:
      return "timeout";
    case 429:
      return "rate-limited";
    default:
      return "server-error";
  }
}

/** The code for a request that never produced a response at all. */
export const DIAGNOSTICS_PAGE_NETWORK_ERROR_CODE =
  "network-error" satisfies DiagnosticsPageErrorCode;
