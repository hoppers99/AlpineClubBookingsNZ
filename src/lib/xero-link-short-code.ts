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

export async function getXeroOrgShortCode(): Promise<string | null> {
  try {
    const { shortCode } = await getXeroConnectedOrganisation();
    return shortCode;
  } catch (err) {
    logger.warn(
      { err },
      "Failed to resolve the Xero organisation short code for a deep link; falling back to the generic link",
    );
    return null;
  }
}
