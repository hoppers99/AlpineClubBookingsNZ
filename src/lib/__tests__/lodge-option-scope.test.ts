import { describe, expect, it } from "vitest"
import {
  deriveSettledLodgeOptionScope,
  settledLodgeId,
} from "@/lib/lodge-option-scope"

const LODGES = [
  { id: "lodge-1", name: "Lodge One" },
  { id: "lodge-2", name: "Lodge Two" },
]

describe("settled lodge option scope (#2701, #2887)", () => {
  it.each([
    ["loading", { loading: true, failed: false, forbidden: false }],
    ["failed", { loading: false, failed: true, forbidden: false }],
    ["forbidden", { loading: false, failed: false, forbidden: true }],
  ] as const)("represents %s before considering a deep-link lodge", (kind, state) => {
    const scope = deriveSettledLodgeOptionScope({
      lodges: LODGES,
      selectedLodgeId: "lodge-2",
      ...state,
    })
    expect(scope).toEqual({ kind })
    expect(settledLodgeId(scope)).toBeNull()
  })

  it("distinguishes a successful empty response", () => {
    expect(
      deriveSettledLodgeOptionScope({
        lodges: [],
        selectedLodgeId: null,
        loading: false,
        failed: false,
        forbidden: false,
      }),
    ).toEqual({ kind: "empty" })
  })

  it("settles only a lodge present in the successful response", () => {
    const scope = deriveSettledLodgeOptionScope({
      lodges: LODGES,
      selectedLodgeId: "lodge-2",
      loading: false,
      failed: false,
      forbidden: false,
    })
    expect(scope).toEqual({
      kind: "lodge",
      lodgeId: "lodge-2",
      lodgeName: "Lodge Two",
    })
    expect(settledLodgeId(scope)).toBe("lodge-2")
  })

  it("keeps null and a stale deep link unsettled until the selector normalises", () => {
    for (const selectedLodgeId of [null, "lodge-gone"]) {
      expect(
        deriveSettledLodgeOptionScope({
          lodges: LODGES,
          selectedLodgeId,
          loading: false,
          failed: false,
          forbidden: false,
        }),
      ).toEqual({ kind: "loading" })
    }
  })

  /*
    #221 review, finding 1 (MED-LOW): a club whose one and only lodge is
    closed, reached with no `?lodgeId=` naming it, used to settle as
    `{ kind: "loading" }` forever — `LodgeSelect` counts only OPEN lodges for
    its sole-lodge/first-lodge rules (ADR-002), so with zero open lodges it
    calls no `onChange` and nothing ever moves `selectedLodgeId` off `null`.
    `LodgeScopeStatusNotice` read that as "still loading" and said so
    indefinitely, when the pre-#221 behaviour was the honest "No active
    lodges" empty state. These pin the terminal `"closed"` state that replaced
    it, and that the two cases which must NOT change — a named closed lodge,
    and a mixed open/closed list with nothing named — really do not change.
  */
  describe("a configuration list with a closed lodge and no match (#221 review, finding 1)", () => {
    it("settles terminally instead of loading forever when every lodge is closed", () => {
      /*
        MUTATION PROBE: revert the fallback to unconditional `{ kind:
        "loading" }` and this fails — the exact regression finding 1
        describes.
      */
      const scope = deriveSettledLodgeOptionScope({
        lodges: [{ id: "lodge-2", name: "New Lodge", active: false }],
        selectedLodgeId: null,
        loading: false,
        failed: false,
        forbidden: false,
      })
      expect(scope).toEqual({ kind: "closed" })
      expect(settledLodgeId(scope)).toBeNull()
    })

    it("still settles a NAMED closed lodge as `lodge`, unchanged", () => {
      // The ?lodgeId= case: a value that resolves to a closed lodge is
      // deliberate by construction and must keep resolving to it, not to the
      // new terminal state.
      const scope = deriveSettledLodgeOptionScope({
        lodges: [{ id: "lodge-2", name: "New Lodge", active: false }],
        selectedLodgeId: "lodge-2",
        loading: false,
        failed: false,
        forbidden: false,
      })
      expect(scope).toEqual({
        kind: "lodge",
        lodgeId: "lodge-2",
        lodgeName: "New Lodge",
      })
      expect(settledLodgeId(scope)).toBe("lodge-2")
    })

    it("keeps a mixed open+closed list with nothing named as `loading`, unchanged", () => {
      // At least one OPEN lodge means `LodgeSelect`'s own effect is about to
      // auto-select it and drive a fresh render, so "loading" here is still
      // the honest, transient answer.
      const scope = deriveSettledLodgeOptionScope({
        lodges: [
          { id: "lodge-1", name: "Alpine Lodge", active: true },
          { id: "lodge-2", name: "New Lodge", active: false },
        ],
        selectedLodgeId: null,
        loading: false,
        failed: false,
        forbidden: false,
      })
      expect(scope).toEqual({ kind: "loading" })
    })

    it("treats an absent `active` as open, matching the hook's own contract", () => {
      // A `member`/`admin` scope list never carries `active` at all; absent
      // must read as open here exactly as it does in `lodge-select.tsx`, or
      // every ordinary list would spuriously settle as `closed` instead of
      // `loading` while its default-selection effect is still in flight.
      const scope = deriveSettledLodgeOptionScope({
        lodges: [{ id: "lodge-1", name: "Alpine Lodge" }],
        selectedLodgeId: null,
        loading: false,
        failed: false,
        forbidden: false,
      })
      expect(scope).toEqual({ kind: "loading" })
    })
  })

  it("represents club-wide only through an explicit supported sentinel", () => {
    const scope = deriveSettledLodgeOptionScope({
      lodges: LODGES,
      selectedLodgeId: "__all_lodges__",
      loading: false,
      failed: false,
      forbidden: false,
      explicitAllLodgesValue: "__all_lodges__",
    })
    expect(scope).toEqual({ kind: "all" })
    expect(settledLodgeId(scope)).toBeNull()
  })
})
