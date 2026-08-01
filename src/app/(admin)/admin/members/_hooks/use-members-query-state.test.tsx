// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useMembersQueryState } from "./use-members-query-state"

const navigation = vi.hoisted(() => ({
  currentSearch: "",
  replace: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.currentSearch),
}))

function Harness() {
  const state = useMembersQueryState()
  return (
    <>
      <output data-testid="state">
        {JSON.stringify({
          search: state.search,
          page: state.page,
          sortBy: state.sortBy,
          sortDir: state.sortDir,
          filters: state.filters,
        })}
      </output>
      <button type="button" onClick={state.resetDataset}>Reset members</button>
    </>
  )
}

describe("useMembersQueryState Reset", () => {
  beforeEach(() => {
    navigation.replace.mockReset()
    navigation.currentSearch = ""
  })

  it("resets search, filters, sort, and page while preserving unknown URL keys", async () => {
    navigation.currentSearch =
      "futureContext=keep&q=Aroha&role=ADMIN&sortBy=email&sortDir=desc&page=3"

    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Reset members" }))

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId("state").textContent ?? "{}")
      expect(state.search).toBe("")
      expect(state.page).toBe(1)
      expect(state.sortBy).toBe("name")
      expect(state.sortDir).toBe("asc")
      expect(Object.values(state.filters)).toEqual(Array(10).fill(""))
    })

    await waitFor(() => {
      const path = navigation.replace.mock.calls.at(-1)?.[0] as string
      const url = new URL(path, "http://localhost")
      expect(url.searchParams.get("futureContext")).toBe("keep")
      for (const key of ["q", "role", "sortBy", "sortDir", "page"]) {
        expect(url.searchParams.has(key)).toBe(false)
      }
    })
  })
})
