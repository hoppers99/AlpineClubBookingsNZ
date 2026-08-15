// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const reload = vi.hoisted(() => vi.fn())
const lodgeOptions = vi.hoisted(() => ({
  loading: false,
  failed: true,
  forbidden: false,
}))

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [],
    ...lodgeOptions,
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

const CASES: Array<[string, () => ReactElement]> = [
  ["default cancellation", () => <DefaultCancellationPolicySection />],
  ["minimum stay", () => <MinimumNightStaySection />],
  ["booking periods", () => <BookingPeriodsSection />],
  ["adult member hosting", () => <AdultMemberHostingSection />],
  ["lodge instructions", () => <LodgeInstructionsPanel />],
]

const POLICY_ACTION =
  /^(?:Edit|Save|Remove|Create override|Add Period|Add Policy|Delete|Activate|Deactivate)/i

describe("booking-policy scope resolution (#2701, #2887)", () => {
  beforeEach(() => {
    reload.mockReset()
    lodgeOptions.loading = false
    lodgeOptions.failed = true
    lodgeOptions.forbidden = false
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it.each(CASES)(
    "%s makes lodge-list failure a transport and action boundary",
    async (_name, createElement) => {
      const fetchMock = vi.mocked(fetch)
      render(createElement())

      expect(
        await screen.findByText("The lodge list could not be loaded"),
      ).toBeInTheDocument()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(
        screen.queryByRole("button", { name: POLICY_ACTION }),
      ).not.toBeInTheDocument()
    },
  )

  it.each(CASES)(
    "%s sends no policy request while lodge options are still resolving",
    (_name, createElement) => {
      lodgeOptions.loading = true
      lodgeOptions.failed = false
      const fetchMock = vi.mocked(fetch)
      render(createElement())

      expect(
        screen.queryByText("The lodge list could not be loaded"),
      ).not.toBeInTheDocument()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(
        screen.queryByRole("button", { name: POLICY_ACTION }),
      ).not.toBeInTheDocument()
    },
  )
})
