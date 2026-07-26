"use client"

import { ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { buildXeroDashboardUrl } from "@/lib/xero-links"
import type { XeroStatus } from "./types"

/**
 * How much the "Go to Xero" link can promise, derived from the connection
 * status. It never gates whether the link renders — Xero's own sign-in page is
 * a valid destination in every state — only its label and explanation.
 */
export type XeroLinkState = "connected" | "needsReentry" | "disconnected"

export function xeroLinkState(status: XeroStatus | null): XeroLinkState {
  if (status?.connected) return "connected"
  if (status?.needsReentry) return "needsReentry"
  return "disconnected"
}

const LABELS: Record<XeroLinkState, string> = {
  connected: "Go to Xero",
  needsReentry: "Log in to Xero",
  disconnected: "Log in to Xero",
}

function describe(state: XeroLinkState, shortCode: string | null): string {
  if (state === "connected") {
    return shortCode
      ? "Opens this club's Xero organisation in a new tab."
      : "Opens Xero in a new tab. The club organisation's short code could not be read, so Xero lands you in whichever organisation you last used."
  }
  if (state === "needsReentry") {
    return "Opens Xero in a new tab. This only signs you in to Xero — reconnect Xero here to restore syncing."
  }
  return "Opens Xero in a new tab. Xero is not connected to this site, so this is a plain Xero sign-in."
}

/**
 * "Go to Xero" — jump straight into Xero from the admin page where a problem
 * was spotted (#2261).
 *
 * Always a live link. With the organisation short code it routes through Xero's
 * organisation-login redirect and lands on THIS club's dashboard; without it
 * (Xero disconnected, tokens needing re-entry, or the org read failed) it falls
 * back to the generic go.xero.com dashboard path, which resolves for a
 * signed-in Xero user and prompts a Xero login otherwise. There is deliberately
 * no disabled state: a disabled button would be the one outcome that helps
 * nobody, and the stored tenant GUID is not usable in a Xero URL, so there is
 * no "more precise" link to wait for.
 */
export function GoToXeroButton({
  state,
  shortCode,
  className,
}: {
  state: XeroLinkState
  shortCode: string | null
  className?: string
}) {
  return (
    <Button asChild variant="outline" size="sm" className={className}>
      <a
        href={buildXeroDashboardUrl({ shortCode })}
        target="_blank"
        rel="noopener noreferrer"
        title={describe(state, shortCode)}
      >
        <ExternalLink aria-hidden />
        {LABELS[state]}
      </a>
    </Button>
  )
}
