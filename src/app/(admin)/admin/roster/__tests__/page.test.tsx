// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}))

vi.mock("@/components/lodge-select", () => ({
  initialLodgeIdFromLocation: () => null,
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-1", name: "Lodge One" }, { id: "lodge-2", name: "Lodge Two" }],
    loading: false,
  }),
  LodgeSelect: ({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) => (
    <select aria-label="Lodge" value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">Default lodge</option>
      <option value="lodge-1">Lodge One</option>
      <option value="lodge-2">Lodge Two</option>
    </select>
  ),
}))

vi.mock("@/components/admin/occupancy-calendar", () => ({
  OccupancyCalendar: () => <div data-testid="occupancy-calendar" />,
}))

import RosterPage from "@/app/(admin)/admin/roster/page"

function roster(date = "2026-07-01", guestName = "Aroha Guest") {
  const [firstName, lastName] = guestName.split(" ")
  return {
    date,
    lodgeId: "lodge-1",
    revision: `revision-${date}-${guestName}`,
    guestCount: 2,
    guests: [
      { id: "guest-1", bookingId: "booking-1", bookingGroupLabel: "Booking for Aroha Booker", firstName, lastName, ageTier: "ADULT" },
      { id: "guest-2", bookingId: "booking-2", bookingGroupLabel: "Booking for Mika Booker", firstName: "Mika", lastName: "Guest", ageTier: "YOUTH" },
    ],
    assignments: [{
      id: "assignment-1",
      choreTemplateId: "kitchen",
      choreTemplateName: "Kitchen",
      choreDescription: null,
      choreSortOrder: 1,
      bookingGuestId: "guest-1",
      guestName,
      guestAgeTier: "ADULT",
      bookingId: "booking-1",
      status: "SUGGESTED",
    }],
    templates: [{
      id: "kitchen",
      name: "Kitchen",
      description: null,
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 2,
      isEssential: true,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 1,
      active: true,
      isDueOnDate: true,
    }],
    guestHistory: {},
  }
}

function successfulFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/admin/roster/status")) {
      return new Response(JSON.stringify({ statuses: [] }), { status: 200 })
    }
    if (init?.method === "PUT") {
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }
    return new Response(JSON.stringify(roster()), { status: 200 })
  })
}

async function renderLoaded(fetchMock = successfulFetch()) {
  vi.stubGlobal("fetch", fetchMock)
  render(<RosterPage />)
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit roster" })).toBeTruthy())
  return fetchMock
}

function getRosterCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url, init]) =>
    String(url).startsWith("/api/admin/roster/") &&
    !String(url).includes("/status") &&
    !init?.method,
  )
}

describe("admin roster page draft transitions", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("prompts before dirty date, lodge, and regenerate changes; decline preserves draft and focus", async () => {
    const fetchMock = await renderLoaded()
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(false)
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const guestSelect = screen.getByRole("combobox", { name: "" }) as HTMLSelectElement
    fireEvent.change(guestSelect, { target: { value: "guest-2" } })

    const date = screen.getByLabelText("Date") as HTMLInputElement
    date.focus()
    fireEvent.change(date, { target: { value: "2026-07-02" } })
    expect(date.value).toBe("2026-07-01")
    expect(date).toBe(document.activeElement)

    const lodge = screen.getByLabelText("Lodge") as HTMLSelectElement
    lodge.focus()
    fireEvent.change(lodge, { target: { value: "lodge-2" } })
    expect(lodge.value).toBe("")
    expect(lodge).toBe(document.activeElement)

    const regenerate = screen.getByRole("button", { name: "Regenerate Roster" })
    regenerate.focus()
    fireEvent.click(regenerate)
    expect(regenerate).toBe(document.activeElement)
    expect((screen.getByRole("combobox", { name: "" }) as HTMLSelectElement).value).toBe("guest-2")
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0)
    expect(confirmMock).toHaveBeenCalledTimes(3)
  })

  it("does not silently reload or remount a dirty editor when Include non-essential chores changes", async () => {
    const fetchMock = await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const guestSelect = screen.getByRole("combobox", { name: "" }) as HTMLSelectElement
    fireEvent.change(guestSelect, { target: { value: "guest-2" } })
    const initialLoads = getRosterCalls(fetchMock).length

    fireEvent.click(screen.getByLabelText("Include non-essential chores"))
    await Promise.resolve()
    expect(getRosterCalls(fetchMock)).toHaveLength(initialLoads)
    expect((screen.getByRole("combobox", { name: "" }) as HTMLSelectElement).value).toBe("guest-2")
    expect(screen.getByRole("button", { name: "Save roster" })).toBeTruthy()
  })

  it("clears the prior keyed roster on load failure, maps transport copy, and retries in place", async () => {
    let rosterLoad = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/admin/roster/status")) {
        return new Response(JSON.stringify({ statuses: [] }), { status: 200 })
      }
      rosterLoad++
      if (rosterLoad === 1) return new Response(JSON.stringify(roster()), { status: 200 })
      if (rosterLoad === 2) throw new TypeError("Failed to fetch")
      return new Response(JSON.stringify(roster("2026-07-02", "Taylor Guest")), { status: 200 })
    })
    await renderLoaded(fetchMock)
    expect(screen.getAllByText("Aroha Guest").length).toBeGreaterThan(0)

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-02" } })
    await waitFor(() => expect(screen.getByText("Roster could not be loaded because the service could not be reached. Try again.")).toBeTruthy())
    expect(screen.queryByText("Aroha Guest")).toBeNull()
    const retry = screen.getByRole("button", { name: "Try again" })
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getAllByText("Taylor Guest").length).toBeGreaterThan(0))
  })

  it("keeps superseded load success and cleanup from repopulating or unblocking the current key", async () => {
    let resolveSecond!: (response: Response) => void
    let resolveThird!: (response: Response) => void
    let rosterLoad = 0
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith("/api/admin/roster/status")) {
        return Promise.resolve(new Response(JSON.stringify({ statuses: [] }), { status: 200 }))
      }
      rosterLoad++
      if (rosterLoad === 1) return Promise.resolve(new Response(JSON.stringify(roster()), { status: 200 }))
      if (rosterLoad === 2) return new Promise<Response>((resolve) => { resolveSecond = resolve })
      return new Promise<Response>((resolve) => { resolveThird = resolve })
    })
    await renderLoaded(fetchMock)

    const date = screen.getByLabelText("Date")
    fireEvent.change(date, { target: { value: "2026-07-02" } })
    await waitFor(() => expect(rosterLoad).toBe(2))
    expect(screen.queryByText("Aroha Guest")).toBeNull()
    fireEvent.change(date, { target: { value: "2026-07-03" } })
    await waitFor(() => expect(rosterLoad).toBe(3))

    resolveSecond(new Response(JSON.stringify(roster("2026-07-02", "Stale Guest")), { status: 200 }))
    await Promise.resolve()
    expect(screen.queryByText("Stale Guest")).toBeNull()
    expect(screen.getByText("Loading roster…")).toBeTruthy()

    resolveThird(new Response(JSON.stringify(roster("2026-07-03", "Current Guest")), { status: 200 }))
    await waitFor(() => expect(screen.getAllByText("Current Guest").length).toBeGreaterThan(0))
    expect(screen.queryByText("Stale Guest")).toBeNull()
  })

  it("maps unreadable action responses to an actionable message without raw JSON errors", async () => {
    const fetchMock = successfulFetch()
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/admin/roster/status")) return new Response(JSON.stringify({ statuses: [] }), { status: 200 })
      if (init?.method === "PUT") return new Response("not-json", { status: 502 })
      return new Response(JSON.stringify(roster()), { status: 200 })
    })
    await renderLoaded(fetchMock)
    vi.spyOn(window, "confirm").mockReturnValue(true)
    fireEvent.click(screen.getByRole("button", { name: "Regenerate Roster" }))
    await waitFor(() => expect(screen.getByText("Regenerating the roster failed because the service returned an unreadable response. Nothing was changed; try again.")).toBeTruthy())
  })
})
