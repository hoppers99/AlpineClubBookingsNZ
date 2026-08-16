// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { useEffect, type ReactElement } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminPermissionMatrix } from "@/lib/admin-permissions"

type LodgeOptionState = {
  lodges: ReadonlyArray<{ id: string; name: string }>
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
    LodgeSelect: ({ lodges, value, onChange }: {
      lodges: ReadonlyArray<{ id: string; name: string }>
      value: string | null
      onChange: (value: string | null) => void
    }) => {
      useEffect(() => {
        if (!value && lodges[0]) onChange(lodges[0].id)
      }, [lodges, onChange, value])
      return <div data-testid="lodge-select" />
    },
  }
})

// The contract under test is whether the page exposes its action surface at
// all. A small form double makes that boundary observable without re-testing
// the hut-leader form's own date/member workflow here.
vi.mock("@/app/(admin)/admin/hut-leaders/_components/assignment-form", () => ({
  AssignmentForm: () => <button>Confirm assignment</button>,
}))

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>()),
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
  { name: "hut leaders", render: () => <HutLeadersPage />, action: /^confirm assignment$/i },
  {
    name: "rooms and beds",
    render: () => <RoomsBedsManager permissionMatrix={PERMISSION_MATRIX} />,
    action: /add room|bulk create|import rooms/i,
  },
  { name: "lodge capacity", render: () => <LodgeCapacityCard />, action: /^save$/i },
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

  it.each([
    {
      name: "lodge capacity",
      render: () => <LodgeCapacityCard />,
      action: /^save$/i,
    },
    {
      name: "hut leaders",
      render: () => <HutLeadersPage />,
      action: /^confirm assignment$/i,
    },
  ])("$name exposes its real action after a concrete lodge settles", async ({ render: renderEditor, action }) => {
    lodgeOptions = {
      lodges: LODGES,
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        assignments: [],
        unassignedDates: [],
        nights: [],
        members: [],
        capacity: 30,
        hutLeaderLookaheadDays: 14,
        schoolGroupSoftCap: 12,
        clubConfigCapacity: 30,
      }),
    })))

    render(
      <ClubIdentityProvider value={clubIdentity}>
        {renderEditor()}
      </ClubIdentityProvider>,
    )

    expect(await screen.findByRole("button", { name: action })).toBeInTheDocument()
  })
})
