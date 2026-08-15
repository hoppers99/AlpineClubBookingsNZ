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
