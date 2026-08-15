// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const reload = vi.hoisted(() => vi.fn())

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [],
    loading: false,
    failed: true,
    forbidden: false,
    reload,
  }),
}))

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}))

import { LodgeInstructionsPanel } from "@/components/admin/lodge-instructions-panel"
import { AdultMemberHostingSection } from "../adult-member-hosting-section"
import { BookingPeriodsSection } from "../booking-periods-section"
import { DefaultCancellationPolicySection } from "../default-cancellation-policy-section"
import { MinimumNightStaySection } from "../minimum-night-stay-section"

const CASES: Array<[string, ReactElement]> = [
  ["default cancellation", <DefaultCancellationPolicySection />],
  ["minimum stay", <MinimumNightStaySection />],
  ["booking periods", <BookingPeriodsSection />],
  ["adult member hosting", <AdultMemberHostingSection />],
  ["lodge instructions", <LodgeInstructionsPanel />],
]

const POLICY_ACTION =
  /^(?:Edit|Save|Remove|Create override|Add Period|Add Policy|Delete|Activate|Deactivate)/i

describe("booking-policy scope resolution (#2701, #2887)", () => {
  beforeEach(() => {
    reload.mockReset()
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it.each(CASES)(
    "%s makes lodge-list failure a transport and action boundary",
    async (_name, element) => {
      const fetchMock = vi.mocked(fetch)
      render(element)

      expect(
        await screen.findByText("The lodge list could not be loaded"),
      ).toBeInTheDocument()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(
        screen.queryByRole("button", { name: POLICY_ACTION }),
      ).not.toBeInTheDocument()
    },
  )
})
