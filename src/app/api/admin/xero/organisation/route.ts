import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroConnectedOrganisation } from "@/lib/xero-organisation";

/**
 * GET /api/admin/xero/organisation
 * Returns the connected Xero organisation's NAME (for the setup wizard's
 * right-org confirmation, #2080), its accounting financial year-end month
 * (1-12), and its deep-link SHORT CODE (#2261), or null for each if Xero is
 * not connected. Cached in-process. Pass ?refresh=1 to bypass the cache.
 *
 * `readFailure` (#2394) says WHY those values are null when the read failed —
 * `disconnected` / `rate_limited` / `unavailable`, plus which Xero limit and any
 * Retry-After. Without it a null name is ambiguous ("Xero has no name for you"
 * vs "we never got to ask"), and the setup wizard hung on
 * "Confirming the organisation name…" indefinitely after one transient failure.
 * Admin-only disclosure, like the lock-date guard's `reason`; this route is
 * already behind `requireAdmin` and the finance area. Callers that only want
 * the values (the deep-link short code, the lockout panel) ignore the field.
 *
 * The short code lives here rather than on `/api/admin/xero/status` on purpose:
 * status is a pure token-row read that every admin surface gating on Xero hits
 * (`useXeroStatus`), and it must stay free of live Xero calls. This route
 * already makes exactly the `getOrganisations` call the short code rides on,
 * behind the in-process cache (12 hours on success, one minute on failure) that
 * bounds it for every caller of this route — the setup wizard, the Xero Sync
 * page's deep links, and the subscription-lockout settings panel.
 */
export async function GET(request?: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const forceRefresh = request?.nextUrl.searchParams.get("refresh") === "1";
  const { name, financialYearEndMonth, shortCode, readFailure } =
    await getXeroConnectedOrganisation(forceRefresh);

  return NextResponse.json({
    name,
    financialYearEndMonth,
    shortCode,
    // Always present (null on success) so the client never has to guess whether
    // an absent key means "succeeded" or "old server".
    readFailure: readFailure ?? null,
  });
}
