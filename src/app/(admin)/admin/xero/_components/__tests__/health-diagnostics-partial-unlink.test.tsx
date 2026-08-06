// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { HealthAndDiagnosticsPanels } from "../health-diagnostics-panel"

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

const mismatchResponse = {
  cacheReady: true,
  lastRefreshedAt: "2026-08-07T00:00:00.000Z",
  count: 1,
  mismatches: [
    {
      memberId: "member-1",
      memberName: "Riley Chen",
      memberEmail: "riley@example.test",
      active: true,
      xeroContactId: "xero-contact-wrong",
      xeroContactName: "Different Person",
      xeroContactEmail: "different@example.test",
      reasons: ["Name does not match"],
    },
  ],
}

const healthResponse = {
  unlinkedMembers: { count: 0, href: "/admin/members" },
  failedOperations: { count: 0, legacyCount: 0 },
  pendingOperations: { count: 0 },
  lastMembershipRefresh: {
    at: null,
    lastCronStatus: null,
    lastCronStartedAt: null,
  },
  missingInvoices: { count: 0 },
  contactGroupMismatches: { count: 0, cacheReady: true },
  contactLinkMismatches: { count: 0, cacheReady: true },
  apiBudget: {
    status: "healthy",
    usagePercent: 0,
    totalCalls: 0,
    failedCalls: 0,
  },
}

describe("Xero health diagnostics partial unlink recovery (#2597)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    })
  })

  it("removes the proven unlink from the retry surface and keeps focused recovery through refresh", async () => {
    let linkReads = 0
    let resolveHealth: ((response: Response) => void) | undefined
    let resolveLinks: ((response: Response) => void) | undefined

    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (
        url === "/api/admin/xero/contact-link-mismatches?limit=200" &&
        !init?.method
      ) {
        linkReads += 1
        if (linkReads === 1) {
          return Promise.resolve(
            new Response(JSON.stringify(mismatchResponse), { status: 200 }),
          )
        }
        return new Promise<Response>((resolve) => {
          resolveLinks = resolve
        })
      }
      if (
        url === "/api/admin/members/member-1/xero-unlink" &&
        init?.method === "POST"
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: "XERO_PARTIAL_SUCCESS",
              error: "private cleanup detail",
              recoveryKind: "CONTACT_UNLINKED",
              xeroContactUnlinked: true,
              xeroLinkMayHaveChanged: true,
              subscriptionCleanupPending: true,
              xeroPostProcessingPending: true,
            }),
            { status: 409 },
          ),
        )
      }
      if (url === "/api/admin/xero/health") {
        return new Promise<Response>((resolve) => {
          resolveHealth = resolve
        })
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    }) as typeof fetch

    render(
      <HealthAndDiagnosticsPanels
        connected
        shortCode={null}
        currentXeroPath="/admin/xero"
        healthOpen={false}
        contactGroupMismatchesOpen={false}
        contactLinkMismatchesOpen
        onToggle={vi.fn()}
        onMessage={vi.fn()}
        onRefreshOperations={vi.fn()}
        refreshToken={0}
        scrollToSection={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Unlink" }))

    const alert = document.getElementById("xero-contact-link-error")
    await waitFor(() => expect(alert).toHaveTextContent(/Refreshing Xero diagnostics now/i))
    expect(alert).toHaveTextContent(/link was removed/i)
    expect(alert).not.toHaveTextContent("private cleanup detail")
    expect(document.activeElement).toBe(alert)
    expect(screen.queryByRole("button", { name: "Unlink" })).not.toBeInTheDocument()

    await act(async () => {
      resolveHealth?.(new Response(JSON.stringify(healthResponse), { status: 200 }))
      resolveLinks?.(
        new Response(
          JSON.stringify({
            ...mismatchResponse,
            count: 0,
            mismatches: [],
          }),
          { status: 200 },
        ),
      )
    })

    await waitFor(() => expect(alert).toHaveTextContent(/Diagnostics were refreshed/i))
    expect(alert).toBe(document.getElementById("xero-contact-link-error"))
    expect(screen.queryByRole("button", { name: "Unlink" })).not.toBeInTheDocument()
  })
})
