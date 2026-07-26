"use client"

import { useEffect, useState } from "react"

/**
 * The connected Xero organisation's short code, for the page's "Go to Xero"
 * deep links (#2261). Null while loading, when Xero is not connected, and
 * whenever the read fails — callers then build the generic go.xero.com link,
 * so a null here degrades the link, it never removes it.
 *
 * Read from `/api/admin/xero/organisation`, deliberately NOT from
 * `/api/admin/xero/status`: status is a pure token-row read that every admin
 * surface gating on Xero hits (`useXeroStatus`), so hanging a live
 * `getOrganisations` call off it would spend Xero API budget on pages that only
 * ask "is Xero connected?". The organisation route already makes that call and
 * caches it in-process for 12 hours, so at most one live Xero call per server
 * process per 12 hours backs every deep link here.
 *
 * The fetch is skipped entirely while `connected` is false, matching the setup
 * wizard's rule that the org read only runs when there is a connection to read.
 */
export function useXeroOrgShortCode(connected: boolean): string | null {
  const [shortCode, setShortCode] = useState<string | null>(null)

  useEffect(() => {
    if (!connected) {
      setShortCode(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/admin/xero/organisation", {
          credentials: "same-origin",
        })
        if (!res.ok) return
        const data = (await res.json()) as { shortCode?: string | null }
        if (cancelled) return
        setShortCode(
          typeof data.shortCode === "string" && data.shortCode ? data.shortCode : null,
        )
      } catch {
        // Leave the short code unset: the link falls back to generic Xero.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connected])

  return shortCode
}
