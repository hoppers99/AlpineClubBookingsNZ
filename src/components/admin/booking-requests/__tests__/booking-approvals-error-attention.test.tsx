// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BookingApprovalsPanel } from "../booking-approvals-panel"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))

const booking = {
  id: "booking-1",
  checkIn: "2026-08-10",
  checkOut: "2026-08-12",
  status: "AWAITING_REVIEW",
  finalPriceCents: 12000,
  memberReviewJustification: "No adult host is available.",
  adminReviewStatus: "PENDING",
  adminReviewNotes: null,
  adminReviewedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  noEmails: false,
  member: {
    id: "member-1",
    firstName: "Riley",
    lastName: "Chen",
    email: "riley@example.org",
  },
  adminReviewedBy: null,
  guests: [
    {
      id: "guest-1",
      firstName: "Riley",
      lastName: "Chen",
      ageTier: "YOUTH",
      isMember: true,
    },
  ],
}

describe("BookingApprovalsPanel action error attention (#2597)", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    })
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [booking] }),
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      })
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it("keeps the alert mounted and focuses a decision failure", async () => {
    render(<BookingApprovalsPanel />)

    const alert = document.getElementById("booking-approvals-error")
    expect(alert).toHaveAttribute("role", "alert")
    expect(alert).toBeEmptyDOMElement()
    expect(alert).toHaveClass("sr-only")

    fireEvent.click(
      await screen.findByRole("button", { name: "Reject and cancel" }),
    )

    await waitFor(() =>
      expect(alert).toHaveTextContent(/add admin notes before rejecting/i),
    )
    expect(document.activeElement).toBe(alert)
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    })
  })
})
