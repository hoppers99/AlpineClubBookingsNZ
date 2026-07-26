"use client"

import { useEffect, useState } from "react"

/** What the page knows about the connected organisation's deep-link short code. */
export interface XeroOrgShortCodeState {
  /**
   * The short code, or null when there is none to show — not connected, still
   * loading, or the read failed. Callers then build the generic go.xero.com
   * link, so a null here degrades the link, it never removes it.
   */
  shortCode: string | null
  /**
   * True while the read is in flight. `shortCode: null` means "unknown" while
   * this is true and "unavailable" only once it is false — the difference
   * between a link that cannot yet promise the club's organisation and one that
   * never will, which is what the button's explanation must not get wrong.
   */
  loading: boolean
}

/**
 * The connected Xero organisation's short code, for the page's "Go to Xero"
 * deep links (#2261).
 *
 * Read from `/api/admin/xero/organisation`, deliberately NOT from
 * `/api/admin/xero/status`: status is a pure token-row read that every admin
 * surface gating on Xero hits (`useXeroStatus`), so hanging a live
 * `getOrganisations` call off it would spend Xero API budget on pages that only
 * ask "is Xero connected?". The organisation route already makes that call —
 * this page is one of several callers, alongside the setup wizard's org
 * confirmation and the subscription-lockout settings panel — and caches it
 * in-process, so those callers share at most one live Xero call per server
 * process per 12 hours (or, while the read is FAILING, per minute: see the
 * negative cache in `xero-organisation.ts`).
 *
 * The fetch is skipped entirely while `connected` is false, matching the setup
 * wizard's rule that the org read only runs when there is a connection to read.
 *
 * Note that this DOES run on mount, unlike the click-only connection probe on
 * `/api/admin/xero/status?probe=1`, whose rule is specific to that probe (an
 * uncached live call, so it has to stay behind a button). The server-side cache
 * is what bounds the cost here: an uncached read is the only one that reaches
 * Xero, and it happens at most once per server process per 12 hours — or per 60
 * seconds while the read is failing — not once per mount. That trade was made
 * deliberately, so that the header button points at the right organisation on
 * the admin's first click; see "Deep links into Xero" in
 * `docs/xero/ARCHITECTURE.md`.
 */
export function useXeroOrgShortCode(connected: boolean): XeroOrgShortCodeState {
  // Start in the loading state when the hook mounts already connected: the very
  // first paint must not claim the short code is unavailable.
  const [state, setState] = useState<XeroOrgShortCodeState>({
    shortCode: null,
    loading: connected,
  })

  // The Xero Sync page mounts before its connection status has loaded, so
  // `connected` flips false -> true one render later. Reset here, during
  // render (React's "adjust state when a prop changes" pattern), rather than
  // in the effect below: an effect runs after that render has been committed,
  // so the button would show one frame of "the short code could not be read"
  // before the read it is waiting for had even started (#2261).
  const [connectedAtLastReset, setConnectedAtLastReset] = useState(connected)
  if (connectedAtLastReset !== connected) {
    setConnectedAtLastReset(connected)
    setState({ shortCode: null, loading: connected })
  }

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/admin/xero/organisation", {
          credentials: "same-origin",
        })
        if (cancelled) return
        if (!res.ok) {
          setState({ shortCode: null, loading: false })
          return
        }
        const data = (await res.json()) as { shortCode?: string | null }
        if (cancelled) return
        setState({
          shortCode:
            typeof data.shortCode === "string" && data.shortCode
              ? data.shortCode
              : null,
          loading: false,
        })
      } catch {
        // Leave the short code unset: the link falls back to generic Xero.
        if (!cancelled) setState({ shortCode: null, loading: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connected])

  return state
}
