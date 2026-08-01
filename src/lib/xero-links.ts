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
 * Without a short code it uses the session-scoped classic path `/Reports/`,
 * which resolves against the user's currently logged-in organisation. The
 * new-app path `/app/reports` 404s: the new app requires the org short code in
 * the URL (`/app/!{shortCode}/…`), which is not the same identifier as the
 * tenant GUID we store — hence the shared organisation read rather than a guess.
 *
 * The finance dashboard's two "Open Xero reports" source notes DO pass the
 * short code (#2314): it is the club's most valuable Xero link and its readers
 * are the multi-organisation treasurers the rule exists for, and
 * `getXeroOrgShortCode`'s shared 12-hour cache means resolving it costs at most
 * one organisation read per server process per TTL, not one per page load.
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
 * The `redirecturl` inside an organisation-login URL, but only when it is safe
 * to rebuild a link from (#2314 review).
 *
 * `applyXeroOrgShortCode` and `stripXeroOrgShortCode` are the one chokepoint
 * for the shape of a STORED `xeroObjectUrl`, and both of them take a value out
 * of an existing URL's query string and hand it back to `buildXeroUrl`, which
 * concatenates it onto the origin or re-wraps it as a redirect target. Only a
 * root-relative path may make that trip:
 *
 * - a value with no leading `/` would be pasted onto the origin
 *   (`https://go.xero.comContacts/...`), producing a dead link;
 * - a leading `//` (or `/\`, which browsers normalise to `//`) is
 *   PROTOCOL-RELATIVE, so re-wrapping it would hand Xero's organisation-login
 *   redirect an off-site target — an open redirect wearing a Xero URL.
 *
 * Nothing in the tree can write either shape today: every stored URL comes from
 * the builders above, whose paths are literals. This is the chokepoint holding
 * its own contract rather than a live defect, and both callers treat a refusal
 * the same way they treat a missing `redirecturl` — the URL is left exactly as
 * found, because re-wrapping a malformed link only buries the problem deeper.
 */
function readRebuildableRedirect(query: string): string | null {
  const redirect = new URLSearchParams(query).get("redirecturl");
  if (!redirect || !redirect.startsWith("/")) return null;
  const second = redirect[1];
  if (second === "/" || second === "\\") return null;
  return redirect;
}

/**
 * Strip any organisation from a Xero URL, leaving the generic form (#2314).
 *
 * This is what makes "stored URLs stay organisation-agnostic" an invariant of
 * the two `xeroObjectUrl` columns rather than a rule every one of the ~50 call
 * sites that builds one has to remember: the two write funnels in
 * `xero-sync.ts` (`upsertXeroObjectLink` and `completeXeroSyncOperation`) and
 * the four direct writers that cannot use them all pass the value through here
 * on the way in, and `xero-object-url-write-guard.test.ts` fails CI on a writer
 * that does not. Applying it there also normalises a legacy row that already
 * carries a short code the next time that row is written, so the columns
 * converge on the invariant instead of only holding it going forward.
 *
 * A URL that is not an organisation-scoped Xero link comes back untouched.
 */
export function stripXeroOrgShortCode(url: string): string;
export function stripXeroOrgShortCode(
  url: string | null | undefined
): string | null;
export function stripXeroOrgShortCode(
  url: string | null | undefined
): string | null {
  if (!url) return url ?? null;
  if (!url.startsWith(`${XERO_ORIGIN}${ORGANISATION_LOGIN_PATH}?`)) return url;

  const redirect = readRebuildableRedirect(url.slice(url.indexOf("?") + 1));
  // An organisation-login URL with nothing usable to redirect to is left alone
  // rather than turned into a worse guess.
  return redirect ? buildXeroUrl(redirect) : url;
}

/**
 * Point an ALREADY-BUILT Xero URL at the club's organisation, or at no
 * organisation at all when we cannot name one (#2314).
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
 * - A URL on any other host is returned untouched. This never invents a Xero
 *   link out of something that was not one.
 * - A URL that ALREADY routes through the organisation-login redirect is
 *   re-pointed at the short code passed in. That self-heals a row written
 *   before this rule existed (or under a previous organisation) instead of
 *   leaving it aimed at books the club no longer owns.
 * - **No short code → the organisation is STRIPPED, not left as found.** This
 *   is the half of "reads neutralise a stale code" that has to hold in the
 *   worst state, not just the good one: a null short code means Xero is
 *   disconnected, mid-reconnect, or its organisation read failed — precisely
 *   when a stored code is most likely to name books the club no longer owns.
 *   Passing it through would render that organisation; stripping it degrades to
 *   the generic `go.xero.com` link, which is live and resolves against whatever
 *   organisation the admin's session already has. Degrading is never a dead
 *   link, and it is never someone else's books.
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
  if (!options?.shortCode) return stripXeroOrgShortCode(url);
  if (!url.startsWith(`${XERO_ORIGIN}/`)) return url;

  let path = url.slice(XERO_ORIGIN.length);

  if (path.startsWith(`${ORGANISATION_LOGIN_PATH}?`)) {
    const redirect = readRebuildableRedirect(path.slice(path.indexOf("?") + 1));
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
