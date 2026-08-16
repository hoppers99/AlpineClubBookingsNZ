import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope"

const LODGE_EDITORS = [
  "src/app/(admin)/admin/seasons/page.tsx",
  "src/app/(admin)/admin/chores/page.tsx",
  "src/app/(admin)/admin/lockers/page.tsx",
  "src/app/(admin)/admin/fees/_components/hut-fees-section.tsx",
  "src/app/(admin)/admin/roster/page.tsx",
  "src/app/(admin)/admin/hut-leaders/page.tsx",
  "src/components/admin/rooms-beds-manager.tsx",
  "src/components/admin/lodge-capacity-card.tsx",
] as const

const ALL_LODGES_EDITORS = [
  "src/app/(admin)/admin/work-parties/page.tsx",
  "src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx",
] as const

const ALL_EDITORS = [...LODGE_EDITORS, ...ALL_LODGES_EDITORS]
const LODGES = [
  { id: "lodge-1", name: "Lodge One" },
  { id: "lodge-2", name: "Lodge Two" },
]

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
}

describe("ordinary admin editors share one settled lodge-scope gate (#2701, #2887)", () => {
  it.each(ALL_EDITORS)("%s adopts the total scope model and shared status", (file) => {
    const body = source(file)
    expect(body).toContain("deriveSettledLodgeOptionScope({")
    expect(body).toContain("<LodgeScopeStatusNotice")
    expect(body).toContain("lodgeScopeReady")
    expect(body).not.toContain("lodgeScopeUnresolved")
    expect(body).not.toContain("<LodgeOptionsUnavailableNotice")
  })

  it.each(LODGE_EDITORS)("%s transports only a validated lodge id", (file) => {
    const body = source(file)
    expect(body).toContain('lodgeScope.kind === "lodge"')
    expect(body).toContain("scopedLodgeId")
  })

  it.each(ALL_LODGES_EDITORS)("%s represents club-wide as an explicit state", (file) => {
    const body = source(file)
    expect(body).toContain("explicitAllLodgesValue:")
    expect(body).toContain('lodgeScope.kind === "all"')
  })

  /*
    #2887: the two cases below are properties of the SHARED DERIVATION, and
    their names now say so.

    They used to be `it.each(ALL_EDITORS)` named "<file> sends no downstream
    request…", which promised per-file proof they do not deliver: neither one
    imports or renders an editor. They build a gate inline from
    `deriveSettledLodgeOptionScope` and assert their own re-implementation, so
    deleting a production guard leaves them green. (The second did not even
    take the file parameter.) The behaviour IS covered, properly, against the
    real components in `ordinary-admin-lodge-scope-behavior.test.tsx` — the
    honesty fix is to stop claiming it twice, and to pin the link to that file
    so a new editor cannot join the list with no behavioural coverage.
  */
  it("the shared scope gate opens for no unsettled state", () => {
    const clubWide = false
    const request = vi.fn()
    const action = vi.fn()
    const tryDownstream = (state: {
      lodges: typeof LODGES
      selectedLodgeId: string | null
      loading: boolean
      failed: boolean
      forbidden: boolean
    }) => {
      const scope = deriveSettledLodgeOptionScope({
        ...state,
        explicitAllLodgesValue: clubWide ? "__all_lodges__" : undefined,
      })
      const ready = clubWide ? scope.kind === "all" : scope.kind === "lodge"
      if (!ready) return
      request(scope)
      action(scope)
    }

    for (const state of [
      { lodges: LODGES, selectedLodgeId: "lodge-2", loading: true, failed: false, forbidden: false },
      { lodges: LODGES, selectedLodgeId: "lodge-2", loading: false, failed: true, forbidden: false },
      { lodges: LODGES, selectedLodgeId: "lodge-2", loading: false, failed: false, forbidden: true },
      { lodges: [], selectedLodgeId: "lodge-2", loading: false, failed: false, forbidden: false },
    ]) {
      tryDownstream(state)
    }

    expect(request).not.toHaveBeenCalled()
    expect(action).not.toHaveBeenCalled()
    void clubWide
  })

  it("every editor on this list has real behavioural coverage (#2887)", () => {
    // The list above is a source-shape census; it cannot prove behaviour. This
    // is the link that stops a new editor being added here — and so LOOKING
    // covered — while nothing ever renders it. The negative and positive
    // per-editor cases live in the behaviour suite.
    const behaviour = source(
      "src/lib/__tests__/ordinary-admin-lodge-scope-behavior.test.tsx",
    )
    for (const file of ALL_EDITORS) {
      const specifier = `@/${file.replace(/^src\//, "").replace(/\.tsx?$/, "")}`
      expect(
        behaviour,
        `${file} is on the scope-contract list but the behaviour suite never imports it`,
      ).toContain(specifier)
    }
  })

  it("the shared gate keeps a deep link inert, then uses that exact lodge after retry", () => {
    const request = vi.fn()
    const deepLinkLodgeId = "lodge-2"
    const tryRequest = (loading: boolean, failed: boolean) => {
      const scope = deriveSettledLodgeOptionScope({
        lodges: LODGES,
        selectedLodgeId: deepLinkLodgeId,
        loading,
        failed,
        forbidden: false,
      })
      if (scope.kind === "lodge") request(scope.lodgeId)
    }

    tryRequest(true, false)
    tryRequest(false, true)
    expect(request).not.toHaveBeenCalled()

    tryRequest(false, false)
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(deepLinkLodgeId)
  })
})
