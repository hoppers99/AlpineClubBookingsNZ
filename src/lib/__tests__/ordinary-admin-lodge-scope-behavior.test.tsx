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
  /*
    #2887 review (F1): this surface is club-wide BY CONSTRUCTION — it pins
    `selectedLodgeId` to its own `explicitAllLodgesValue` and never asks for a
    per-lodge answer. Its content therefore does not depend on the lodge list,
    and a failed/forbidden/empty list must NOT blank it.

    This flag exists because the negative cases below previously applied to all
    ten editors and so pinned the regression as correct: `GET /api/admin/lodges`
    needs `lodge:view`, `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` have no `lodge`
    entry, and their 403 is permanent — so /admin/promo-codes (in the sidebar)
    and /admin/work-parties were permanently blank for both presets.
  */
  clubWide?: true
}> = [
  { name: "seasons", render: () => <SeasonsPage />, action: /^edit window$/i },
  { name: "chores", render: () => <ChoresPage />, action: /add chore|create chore|update chore/i },
  { name: "lockers", render: () => <LockersPage />, action: /^create locker$/i },
  { name: "hut fees", render: () => <HutFeesSection canEdit />, action: /add season|save season/i },
  { name: "roster", render: () => <RosterPage />, action: /generate roster|save roster|confirm roster/i },
  { name: "hut leaders", render: () => <HutLeadersPage />, action: /^confirm assignment$/i },
  {
    name: "rooms and beds",
    render: () => <RoomsBedsManager permissionMatrix={PERMISSION_MATRIX} />,
    action: /add room|bulk create|import rooms/i,
  },
  { name: "lodge capacity", render: () => <LodgeCapacityCard />, action: /^save$/i },
  { name: "work parties", render: () => <AdminWorkPartiesPage />, action: /^new event$/i, clubWide: true },
  {
    name: "promo codes",
    render: () => <PromoCodesPageClient permissionMatrix={PERMISSION_MATRIX} />,
    action: /^add promo code$/i,
    clubWide: true,
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

  const cases = EDITORS.filter((editor) => !editor.clubWide).flatMap((editor) =>
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

  const clubWideCases = EDITORS.filter((editor) => editor.clubWide).flatMap((editor) =>
    UNSETTLED_STATES.filter((scope) => scope.name !== "delayed loading").map((scope) => ({
      editorName: editor.name,
      stateName: scope.name,
      render: editor.render,
      action: editor.action,
      state: scope.state,
    })),
  )

  it.each(clubWideCases)(
    "$editorName still works with no usable lodge list, because it never needed one — scope is $stateName",
    async ({ render: renderEditor, action, state }) => {
      /*
        The counterpart to the negative cases above, and the reason they are no
        longer applied to these two editors.

        `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` hold no `lodge` permission, so
        `/api/admin/lodges` 403s for them forever. These surfaces are club-wide
        by construction, so that 403 tells them nothing they needed to know —
        and blanking them turned a permission they DO have (finance/membership)
        into a page they cannot use. "delayed loading" is excluded because
        "not yet" is a real transient state that resolves on its own.
      */
      lodgeOptions = { ...state, reload: vi.fn() }
      // The shapes these two pages actually parse; a bare [] makes them throw
      // on load, which would fail this case for a reason that is not the gate.
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const json = async () => {
          if (url.includes("/api/admin/work-parties")) return { events: [] }
          if (url.includes("/api/admin/promo-codes")) return []
          if (url.includes("/api/admin/membership-types")) return { membershipTypes: [] }
          if (url.includes("/api/admin/age-tier-settings")) return { settings: [] }
          return []
        }
        return { ok: true, status: 200, json } as Response
      }))

      render(
        <ClubIdentityProvider value={clubIdentity}>
          {renderEditor()}
        </ClubIdentityProvider>,
      )

      expect(await screen.findByRole("button", { name: action })).toBeInTheDocument()
      expect(fetch).toHaveBeenCalled()
    },
  )

  it.each(EDITORS)("$name exposes its real action after a concrete lodge settles", async ({ render: renderEditor, action }) => {
    lodgeOptions = {
      lodges: LODGES,
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = async () => {
        if (url.includes("/api/admin/seasons")) {
          return [{
            id: "season-1",
            name: "Winter",
            type: "WINTER",
            startDate: "2026-08-01",
            endDate: "2026-09-01",
            active: true,
            flatWholeLodgeNightCents: null,
            membershipTypeRates: [],
          }]
        }
        if (url.includes("/api/admin/chores")) return []
        if (url.includes("/api/admin/lockers")) return { lockers: [], members: [] }
        if (url.includes("/api/admin/roster/")) {
          return { date: "2026-08-01", assignments: [], availableGuests: [], status: "DRAFT" }
        }
        if (url.includes("/api/admin/roster/status")) return { statuses: [] }
        if (url.includes("/api/admin/hut-leaders")) return { assignments: [], members: [] }
        if (url.includes("/api/admin/bed-allocation/rooms")) {
          return {
            rooms: [],
            capacity: {
              capacity: 30,
              source: "capacity_override",
              bedAllocationEnabled: true,
              activeBedCount: 0,
              fallbackCapacity: 30,
            },
            canImportFromConfig: false,
            configBeds: [],
          }
        }
        if (url.includes("/api/admin/work-parties")) return { events: [] }
        if (url.includes("/api/admin/promo-codes")) return []
        if (url.includes("/api/admin/membership-types")) return { membershipTypes: [] }
        if (url.includes("/api/admin/age-tier-settings")) return { settings: [] }
        return {
          assignments: [],
          unassignedDates: [],
          nights: [],
          members: [],
          capacity: 30,
          hutLeaderLookaheadDays: 14,
          schoolGroupSoftCap: 12,
          clubConfigCapacity: 30,
        }
      }
      return { ok: true, status: 200, json } as Response
    }))

    render(
      <ClubIdentityProvider value={clubIdentity}>
        {renderEditor()}
      </ClubIdentityProvider>,
    )

    expect(await screen.findByRole("button", { name: action })).toBeInTheDocument()
  })
})
