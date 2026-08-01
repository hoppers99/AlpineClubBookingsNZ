// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useDebouncedMemberSearch } from "../use-debounced-member-search"

/*
  #2264 — coverage for the `onResponse` seam and the `active` flag added when
  the dependant-link dialog folded its hand-rolled debounce into this hook.

  The dependant search consumes two signals the endpoint returns BESIDE the
  rows (`dependentLinkIneligible` and `dependentLinkSearchMatchedNobody`,
  #2254). Neither can be recovered from `members`, because the caller filters
  those client-side, so these tests pin the contract the dialog now depends on:
  the whole body is handed over, only for a response that is still current, and
  the caller can tell an inactive search from an empty one.
*/

function mockFetch(payload: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    json: async () => payload,
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const MEMBERS_PAYLOAD = {
  members: [{ id: "m1" }, { id: "m2" }],
  total: 5,
  dependentLinkIneligible: [{ id: "m9", reason: "Already has two parents" }],
  dependentLinkSearchMatchedNobody: false,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("useDebouncedMemberSearch — onResponse (#2264)", () => {
  it("hands the caller the whole response body, not just the rows", async () => {
    mockFetch(MEMBERS_PAYLOAD)
    const onResponse = vi.fn()

    const { result } = renderHook(() =>
      useDebouncedMemberSearch<{ id: string }>({
        query: "smith",
        onResponse,
      }),
    )

    await waitFor(() => expect(onResponse).toHaveBeenCalledTimes(1))
    expect(onResponse).toHaveBeenCalledWith(MEMBERS_PAYLOAD)
    // The rows still arrive through `results`, unchanged by the new seam.
    await waitFor(() => expect(result.current.results).toHaveLength(2))
  })

  it("fires alongside onResults, once per successful response", async () => {
    mockFetch(MEMBERS_PAYLOAD)
    const onResponse = vi.fn()
    const onResults = vi.fn()

    renderHook(() =>
      useDebouncedMemberSearch<{ id: string }>({
        query: "smith",
        onResponse,
        onResults,
      }),
    )

    await waitFor(() => expect(onResults).toHaveBeenCalledTimes(1))
    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(onResults).toHaveBeenCalledWith(MEMBERS_PAYLOAD.members)
  })

  it("never fires for a query too short to search", async () => {
    const fetchMock = mockFetch(MEMBERS_PAYLOAD)
    const onResponse = vi.fn()

    renderHook(() =>
      useDebouncedMemberSearch<{ id: string }>({ query: "s", onResponse }),
    )

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onResponse).not.toHaveBeenCalled()
  })

  it("never fires while the search is disabled", async () => {
    const fetchMock = mockFetch(MEMBERS_PAYLOAD)
    const onResponse = vi.fn()

    renderHook(() =>
      useDebouncedMemberSearch<{ id: string }>({
        query: "smith",
        enabled: false,
        onResponse,
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onResponse).not.toHaveBeenCalled()
  })

  it("does not fire for a failed response", async () => {
    mockFetch({ error: "Search exploded" }, false)
    const onResponse = vi.fn()

    const { result } = renderHook(() =>
      useDebouncedMemberSearch<{ id: string }>({
        query: "smith",
        onResponse,
      }),
    )

    await waitFor(() => expect(result.current.error).toBe("Search exploded"))
    expect(onResponse).not.toHaveBeenCalled()
  })

  it("does not fire after the consumer unmounts", async () => {
    mockFetch(MEMBERS_PAYLOAD)
    const onResponse = vi.fn()

    const { unmount } = renderHook(() =>
      useDebouncedMemberSearch<{ id: string }>({
        query: "smith",
        onResponse,
      }),
    )

    unmount()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(onResponse).not.toHaveBeenCalled()
  })
})

describe("useDebouncedMemberSearch — active (#2264)", () => {
  it("is false while the query is too short and true once it searches", async () => {
    mockFetch(MEMBERS_PAYLOAD)

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) =>
        useDebouncedMemberSearch<{ id: string }>({ query }),
      { initialProps: { query: "s" } },
    )

    expect(result.current.active).toBe(false)

    rerender({ query: "smith" })
    expect(result.current.active).toBe(true)
  })

  it("is false when the caller disables the search, however long the query", () => {
    mockFetch(MEMBERS_PAYLOAD)

    const { result } = renderHook(() =>
      useDebouncedMemberSearch<{ id: string }>({
        query: "smith",
        enabled: false,
      }),
    )

    expect(result.current.active).toBe(false)
  })

  it("lets a caller mask state it kept from a previous search", async () => {
    // The dependant dialog keeps the #2254 signals in its own state and masks
    // them with `active`; this is that contract in miniature.
    mockFetch(MEMBERS_PAYLOAD)
    let latest: unknown = null

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) =>
        useDebouncedMemberSearch<{ id: string }>({
          query,
          onResponse: (payload) => {
            latest = payload
          },
        }),
      { initialProps: { query: "smith" } },
    )

    await waitFor(() => expect(latest).not.toBeNull())
    expect(result.current.active).toBe(true)

    // Clearing the box makes the search inactive: the caller's retained
    // payload is still in hand, but `active` tells it not to render it.
    rerender({ query: "" })
    expect(result.current.active).toBe(false)
    expect(result.current.results).toEqual([])
  })
})
