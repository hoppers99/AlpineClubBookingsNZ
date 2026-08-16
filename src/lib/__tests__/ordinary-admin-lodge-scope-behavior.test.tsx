// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import type { ReactElement } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminPermissionMatrix } from "@/lib/admin-permissions"

type LodgeOptionState = {
  lodges: Array<{ id: string; name: string }>
  loading: boolean
  failed: boolean
  forbidden: boolean
  reload: () => void
}

const LODGES = [
  { id: "lodge-1", name: "Lodge One" },
  { id: "lodge-2", name: "Lodge Two" },
]

let lodgeOptions: LodgeOptionState

vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/lodge-select")>()
  return {
    ...actual,
    initialLodgeIdFromLocation: () => "lodge-2",
    useLodgeOptions: () => lodgeOptions,
    LodgeSelect: () => <div data-testid="lodge-select" />,
  }
})

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
}))

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "view",
          support: "view",
        },
      },
    },
    status: "authenticated",
  }),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/test",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => false), confirmDialog: null }),
}))

import SeasonsPage from "@/app/(admin)/admin/seasons/page"
import ChoresPage from "@/app/(admin)/admin/chores/page"
import LockersPage from "@/app/(admin)/admin/lockers/page"
import { HutFeesSection } from "@/app/(admin)/admin/fees/_components/hut-fees-section"
import RosterPage from "@/app/(admin)/admin/roster/page"
import HutLeadersPage from "@/app/(admin)/admin/hut-leaders/page"
import { RoomsBedsManager } from "@/components/admin/rooms-beds-manager"
import { LodgeCapacityCard } from "@/components/admin/lodge-capacity-card"
import AdminWorkPartiesPage from "@/app/(admin)/admin/work-parties/page"
import { PromoCodesPageClient } from "@/app/(admin)/admin/promo-codes/promo-codes-page-client"
import { ClubIdentityProvider } from "@/components/club-identity-provider"
import { clubIdentity } from "@/config/club-identity"

const PERMISSION_MATRIX: AdminPermissionMatrix = {
  overview: "view",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "view",
  support: "view",
}

const EDITORS: Array<{
  name: string
  render: () => ReactElement
  action: RegExp
}> = [
  { name: "seasons", render: () => <SeasonsPage />, action: /save changes|delete|deactivate/i },
  { name: "chores", render: () => <ChoresPage />, action: /add chore|create chore|update chore/i },
  { name: "lockers", render: () => <LockersPage />, action: /add locker|bulk create|save locker/i },
  { name: "hut fees", render: () => <HutFeesSection canEdit />, action: /add season|save season/i },
  { name: "roster", render: () => <RosterPage />, action: /generate roster|save roster|confirm roster/i },
  { name: "hut leaders", render: () => <HutLeadersPage />, action: /assign hut leader|save assignment/i },
  {
    name: "rooms and beds",
    render: () => <RoomsBedsManager permissionMatrix={PERMISSION_MATRIX} />,
    action: /add room|bulk create|import rooms/i,
  },
  { name: "lodge capacity", render: () => <LodgeCapacityCard />, action: /edit capacity|save capacity/i },
  { name: "work parties", render: () => <AdminWorkPartiesPage />, action: /add work party|save event/i },
  {
    name: "promo codes",
    render: () => <PromoCodesPageClient permissionMatrix={PERMISSION_MATRIX} />,
    action: /new promo code|create promo code|save promo code/i,
  },
]

const UNSETTLED_STATES = [
  {
    name: "delayed loading",
    state: { lodges: LODGES, loading: true, failed: false, forbidden: false },
  },
  {
    name: "failed",
    state: { lodges: LODGES, loading: false, failed: true, forbidden: false },
  },
  {
    name: "forbidden",
    state: { lodges: LODGES, loading: false, failed: false, forbidden: true },
  },
  {
    name: "successful empty",
    state: { lodges: [], loading: false, failed: false, forbidden: false },
  },
] as const

describe("ordinary admin editors fail closed until lodge scope settles (#2701, #2887)", () => {
  beforeEach(() => {
    lodgeOptions = {
      lodges: LODGES,
      loading: true,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("An unsettled lodge scope attempted a downstream request")
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const cases = EDITORS.flatMap((editor) =>
    UNSETTLED_STATES.map((scope) => ({
      editorName: editor.name,
      stateName: scope.name,
      render: editor.render,
      action: editor.action,
      state: scope.state,
    })),
  )

  it.each(cases)("$editorName sends no downstream GET and exposes no action while scope is $stateName", async ({ render: renderEditor, action, state }) => {
    lodgeOptions = { ...state, reload: vi.fn() }
    render(
      <ClubIdentityProvider value={clubIdentity}>
        {renderEditor()}
      </ClubIdentityProvider>,
    )

    await act(async () => {})

    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: action })).not.toBeInTheDocument()
  })
})
