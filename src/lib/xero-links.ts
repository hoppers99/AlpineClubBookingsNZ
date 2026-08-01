interface XeroUrlOptions {
  shortCode?: string | null;
}

/** The one place the Xero web-app host is spelled (see xero-links-guard). */
const XERO_ORIGIN = "https://go.xero.com";

/** Xero's organisation-switching redirect, the only short-code-aware entry. */
const ORGANISATION_LOGIN_PATH = "/organisationlogin/default.aspx";

function buildXeroUrl(path: string, options?: XeroUrlOptions): string {
  if (options?.shortCode) {
    const shortCode = encodeURIComponent(options.shortCode);
    const redirect = encodeURIComponent(path);
    return `${XERO_ORIGIN}${ORGANISATION_LOGIN_PATH}?shortcode=${shortCode}&redirecturl=${redirect}`;
  }

  return `${XERO_ORIGIN}${path}`;
}

export function buildXeroContactUrl(
  contactId: string,
  options?: XeroUrlOptions
): string {
  return buildXeroUrl(`/Contacts/View/${encodeURIComponent(contactId)}`, options);
}

export function buildXeroInvoiceUrl(
  invoiceId: string,
  options?: XeroUrlOptions
): string {
  return buildXeroUrl(
    `/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(invoiceId)}`,
    options
  );
}

export function buildXeroCreditNoteUrl(
  creditNoteId: string,
  options?: XeroUrlOptions
): string {
  return buildXeroUrl(
    `/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=${encodeURIComponent(creditNoteId)}`,
    options
  );
}

/**
 * Xero's report centre ("Accounting → Reports" in the web app). Specific
 * report runs (Profit and Loss, Balance Sheet) need a per-organisation report
 * GUID or the org short code, neither of which we store, so dashboard "open
 * in Xero" links land on the hub — both reports are one click away.
 *
 * Uses the session-scoped classic path `/Reports/`, which resolves against the
 * user's currently logged-in organisation. The new-app path `/app/reports`
 * 404s: the new app requires the org short code in the URL
 * (`/app/!{shortCode}/…`), and the finance dashboard deliberately avoids the
 * live Xero call that fetching the short code would need on every page load.
 */
export function buildXeroReportsUrl(options?: XeroUrlOptions): string {
  return buildXeroUrl("/Reports/", options);
}

/**
 * The connected organisation's Xero dashboard — the target of the single
 * "Go to Xero" button in the admin Xero Sync page's header (#2261).
 *
 * With the organisation SHORT CODE the link routes through Xero's
 * organisation-login redirect, which switches the signed-in Xero session to
 * THIS club's organisation before landing on the dashboard, so an admin who
 * belongs to several Xero organisations arrives in the right one. Without it —
 * Xero not connected, or the organisation read failed — it degrades to the
 * session-scoped classic path, which resolves against whichever organisation
 * the admin is already signed in to and prompts a Xero login otherwise.
 *
 * Both forms are live URLs: this link is never dead, only less precise. The
 * short code is never guessed from the tenant GUID we store — the GUID is not
 * usable in a Xero URL at all (see the note on buildXeroReportsUrl).
 */
export function buildXeroDashboardUrl(options?: XeroUrlOptions): string {
  return buildXeroUrl("/Dashboard/", options);
}

/**
 * Point an ALREADY-BUILT generic Xero URL at a specific organisation (#2314).
 *
 * The builders above take the short code up front, which suits a caller that
 * holds the object's id. Two callers do not: a stored `xeroObjectUrl` (on
 * `XeroObjectLink` / `XeroSyncOperation`) and an emailed link assembled from
 * one. The owner's decision on #2314 keeps those stored URLs deliberately
 * **organisation-agnostic** — a short code baked into a row is wrong the moment
 * the club reconnects to a different Xero organisation — and applies the short
 * code at RENDER time instead. This is the function that does that.
 *
 * Rules, in the order they matter:
 *
 * - No short code, or nothing to rewrite → the URL is returned untouched. A
 *   generic `go.xero.com` link is live; it just may prompt a multi-organisation
 *   admin to pick. Degrading is never a dead link.
 * - A URL on any other host is returned untouched. This never invents a Xero
 *   link out of something that was not one.
 * - A URL that ALREADY routes through the organisation-login redirect is
 *   re-pointed at the short code passed in. That self-heals a row written
 *   before this rule existed (or under a previous organisation) instead of
 *   leaving it aimed at books the club no longer owns.
 *
 * The rewrite is exact: `applyXeroOrgShortCode(buildXeroContactUrl(id), opts)`
 * and `buildXeroContactUrl(id, opts)` produce byte-identical URLs, which is
 * what lets a producer mix stored and freshly built URLs in one expression.
 */
export function applyXeroOrgShortCode(
  url: string,
  options?: XeroUrlOptions
): string;
export function applyXeroOrgShortCode(
  url: string | null | undefined,
  options?: XeroUrlOptions
): string | null;
export function applyXeroOrgShortCode(
  url: string | null | undefined,
  options?: XeroUrlOptions
): string | null {
  if (!url) return url ?? null;
  if (!options?.shortCode) return url;
  if (!url.startsWith(`${XERO_ORIGIN}/`)) return url;

  let path = url.slice(XERO_ORIGIN.length);

  if (path.startsWith(`${ORGANISATION_LOGIN_PATH}?`)) {
    const redirect = new URLSearchParams(
      path.slice(path.indexOf("?") + 1)
    ).get("redirecturl");
    // A malformed organisation-login URL with nothing to redirect to is left
    // exactly as found: re-wrapping it would only bury the problem deeper.
    if (!redirect) return url;
    path = redirect;
  }

  return buildXeroUrl(path, options);
}

export function buildXeroObjectUrl(
  objectType: string,
  objectId: string,
  options?: XeroUrlOptions
): string | null {
  switch (objectType) {
    case "CONTACT":
      return buildXeroContactUrl(objectId, options);
    case "INVOICE":
    case "SUBSCRIPTION":
      return buildXeroInvoiceUrl(objectId, options);
    case "CREDIT_NOTE":
    case "CREDITNOTE":
      return buildXeroCreditNoteUrl(objectId, options);
    default:
      return null;
  }
}
