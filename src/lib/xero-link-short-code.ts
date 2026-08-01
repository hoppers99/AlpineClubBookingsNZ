/**
 * The organisation short code for SERVER-built Xero deep links (#2314).
 *
 * Client surfaces get the short code from the `useXeroOrgShortCode` hook, which
 * reads `/api/admin/xero/organisation`. Anything built on the server — a list
 * route's response, a stored `xeroObjectUrl` being rendered, an admin alert
 * email — has no hook, so it calls this instead. This is the server-side twin
 * of that hook, and the one place a producer should reach for the short code.
 *
 * Cost: `getXeroConnectedOrganisation` holds the whole connected-organisation
 * summary in-process for 12 hours on success and 60 seconds on failure, and is
 * single-flight, so a warm cache costs nothing and a cold one costs at most one
 * `getOrganisations` call per server process per TTL — shared with the setup
 * wizard, the financial-year read and the lockout panel, which all read the same
 * summary. That is what made the owner's decision on #2314 ("resolve the short
 * code server-side in every producer") affordable on list endpoints an admin
 * polls, not just on write paths that already call Xero.
 *
 * Never throws and never blocks a link. `getXeroConnectedOrganisation` already
 * swallows its own failures and degrades to nulls; the catch here is belt and
 * braces for a caller that must not be taken down by a decoration. A null short
 * code means "build the generic `go.xero.com` link" — live, just not
 * organisation-scoped — never "hide the link".
 *
 * Server-only: it reaches the Xero API client and the token store. Client
 * components must keep using `useXeroOrgShortCode`.
 */

import logger from "@/lib/logger";
import { getXeroConnectedOrganisation } from "@/lib/xero-organisation";

export interface XeroOrgShortCodeOptions {
  /**
   * Confirm the organisation with Xero before naming it, and name none unless
   * that confirmation succeeded (#2314 review).
   *
   * For a SCREEN the cache is right: it re-renders, so a short code that goes
   * stale corrects itself on the next load, and the 12-hour TTL is what keeps
   * polled list endpoints free. An EMAIL cannot re-render. Whatever it is
   * stamped with is what a bookkeeper clicks days later, and because
   * `/organisationlogin/default.aspx?shortcode=…` actively SWITCHES the
   * reader's Xero session, a stale one is worse than no short code at all — it
   * moves them out of the club's books rather than leaving them where they
   * were.
   *
   * The cache is per process and its invalidation bus
   * (`xero-organisation-cache-bus.ts`) only reaches the process that handled
   * the connect/disconnect, so a cron or worker process that did not can hold
   * the PREVIOUS organisation's short code for up to the 12-hour TTL after a
   * reconnect. This option closes that window for the one surface that cannot
   * take it back: it forces the read (skipping both the positive and the
   * negative cache) and returns null when the read failed, rather than the
   * cached summary the failure path falls back to.
   *
   * Affordable because it is bounded by the senders, not by traffic: the
   * repeated-failure alert is deduplicated against `EmailLog` for the whole
   * window, the manual-settlement conflict is throttled by a cross-instance
   * `AlertCooldown` claim, and the reconciliation report is a nightly cron with
   * ONE read for the whole report. The forced read takes no retry and cannot
   * arm the process-global transient breaker, so at worst an alert spends one
   * extra `getOrganisations` call and then degrades to the generic link.
   */
  confirmLive?: boolean;
}

export async function getXeroOrgShortCode(
  options?: XeroOrgShortCodeOptions,
): Promise<string | null> {
  try {
    const summary = await getXeroConnectedOrganisation(
      options?.confirmLive === true,
    );
    // A failed read degrades to the LAST KNOWN summary by design, so it can
    // hand back the very organisation this option exists to stop naming.
    // "Could not confirm" must mean "name none" here, not "reuse the old one".
    if (options?.confirmLive && summary.readFailure) return null;
    return summary.shortCode;
  } catch (err) {
    logger.warn(
      { err },
      "Failed to resolve the Xero organisation short code for a deep link; falling back to the generic link",
    );
    return null;
  }
}
