// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RosterEditor, type RosterData } from "@/components/admin/roster-editor"

const BASE: RosterData = {
  date: "2026-08-10",
  lodgeId: "lodge-1",
  revision: "revision-1",
  guestCount: 4,
  guests: [
    { id: "older", bookingId: "booking-a", bookingGroupLabel: "Booking for Aroha Bell", firstName: "Aroha", lastName: "Bell", ageTier: "ADULT" },
    { id: "younger", bookingId: "booking-a", bookingGroupLabel: "Booking for Aroha Bell", firstName: "Mika", lastName: "Bell", ageTier: "CHILD" },
    { id: "unknown-a", bookingId: "booking-b", bookingGroupLabel: "Booking for Taylor Chen", firstName: "Alex", lastName: "Chen", ageTier: "ADULT" },
    { id: "unknown-z", bookingId: "booking-b", bookingGroupLabel: "Booking for Taylor Chen", firstName: "Zoe", lastName: "Chen", ageTier: "YOUTH" },
  ],
  assignments: [
    { id: "a-1", choreTemplateId: "kitchen", choreTemplateName: "Kitchen", choreDescription: null, choreSortOrder: 1, bookingGuestId: "older", guestName: "Aroha Bell", guestAgeTier: "ADULT", bookingId: "booking-a", status: "SUGGESTED" },
    { id: "a-2", choreTemplateId: "wood", choreTemplateName: "Firewood", choreDescription: null, choreSortOrder: 2, bookingGuestId: "older", guestName: "Aroha Bell", guestAgeTier: "ADULT", bookingId: "booking-a", status: "SUGGESTED" },
  ],
  templates: [
    { id: "kitchen", name: "Kitchen", description: null, recommendedPeopleMin: 1, recommendedPeopleMax: 3, isEssential: true, ageRestriction: "ANY", conditionalNote: null, minAge: 0, sortOrder: 1, active: true, isDueOnDate: true },
    { id: "wood", name: "Firewood", description: null, recommendedPeopleMin: 1, recommendedPeopleMax: 1, isEssential: false, ageRestriction: "ANY", conditionalNote: null, minAge: 0, sortOrder: 2, active: true, isDueOnDate: true },
    { id: "bathrooms", name: "Bathrooms", description: null, recommendedPeopleMin: 1, recommendedPeopleMax: 1, isEssential: true, ageRestriction: "ANY", conditionalNote: null, minAge: 0, sortOrder: 3, active: true, isDueOnDate: true },
    { id: "weekly", name: "Weekly check", description: null, recommendedPeopleMin: 1, recommendedPeopleMax: 1, isEssential: false, ageRestriction: "ANY", conditionalNote: null, minAge: 0, sortOrder: 4, active: true, isDueOnDate: false },
  ],
  guestHistory: {},
}

function renderEditor(roster: RosterData = BASE) {
  const onRosterUpdate = vi.fn()
  const onDirtyChange = vi.fn()
  const onEditingChange = vi.fn()
  render(
    <RosterEditor
      roster={roster}
      canEdit
      saveUrl="/api/admin/roster/2026-08-10?lodgeId=lodge-1"
      onRosterUpdate={onRosterUpdate}
      onDirtyChange={onDirtyChange}
      onEditingChange={onEditingChange}
    />,
  )
  return { onRosterUpdate, onDirtyChange, onEditingChange }
}

describe("RosterEditor staged whole-roster editing", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("loads read-only, saves one changed row without swapping another assignment, and re-seeds from the server", async () => {
    const authoritative = {
      ...BASE,
      revision: "revision-2",
      assignments: BASE.assignments.map((assignment) => assignment.id === "a-1"
        ? { ...assignment, bookingGuestId: "unknown-a", bookingId: "booking-b", guestName: "Alex Chen" }
        : assignment),
    }
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(authoritative), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { onRosterUpdate } = renderEditor()

    expect(screen.queryAllByRole("combobox")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[]
    fireEvent.change(selects[0], { target: { value: "unknown-a" } })
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toEqual({
      action: "save",
      baseRevision: "revision-1",
      acknowledgeCompletedReset: false,
      assignments: [
        { rowKey: "a-1", assignmentId: "a-1", choreTemplateId: "kitchen", bookingGuestId: "unknown-a" },
        { rowKey: "a-2", assignmentId: "a-2", choreTemplateId: "wood", bookingGuestId: "older" },
      ],
    })
    expect(onRosterUpdate).toHaveBeenCalledWith(authoritative)
    expect(screen.getByText(/Roster saved/)).toBeTruthy()
    expect(screen.queryAllByRole("combobox")).toHaveLength(0)
  })

  it("Cancel restores the complete authoritative snapshot without a request", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const first = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    fireEvent.change(first, { target: { value: "younger" } })
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1])
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getAllByText("Aroha Bell").length).toBeGreaterThan(0)
    expect(screen.getByText("Firewood")).toBeTruthy()
  })

  it("keeps Save invalid for an empty new row, explains it beside the dropdown, and focuses that row", () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const kitchen = screen.getByText("Kitchen").closest("div")?.parentElement?.parentElement
    fireEvent.click(within(kitchen as HTMLElement).getByRole("button", { name: "+ Add Person" }))
    const emptySelect = (screen.getAllByRole("combobox") as HTMLSelectElement[]).find((select) => select.value === "")!
    expect(emptySelect).toBe(document.activeElement)
    expect(emptySelect.getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByText("Choose a person before saving this roster.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Save roster" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("does not enter edit mode when the completed-reset warning is declined, then acknowledges and clears only on Save", async () => {
    const completed = {
      ...BASE,
      assignments: [{ ...BASE.assignments[0], status: "COMPLETED" as const }],
    }
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true)
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...completed,
      revision: "revision-2",
      assignments: [{ ...completed.assignments[0], status: "SUGGESTED" as const }],
    }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(completed)

    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    expect(screen.queryAllByRole("combobox")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    expect(screen.getAllByRole("combobox")).toHaveLength(1)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "younger" } })
    expect(screen.getByText(/Cancel leaves completion unchanged/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).acknowledgeCompletedReset).toBe(true)
    expect(confirmMock).toHaveBeenCalledTimes(2)
  })

  it("preserves the draft and focuses actionable global and row failures", async () => {
    const stale = "This roster changed while you were editing. Your changes were not saved. Reload the latest roster and try again."
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "ROSTER_STALE", error: stale }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: "ROSTER_GUEST_INELIGIBLE",
        error: "Roster not saved. This person is no longer eligible for this lodge night. Choose another person or reload the roster.",
        details: { rowKey: "a-1" },
      }), { status: 400 }))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const first = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    fireEvent.change(first, { target: { value: "younger" } })
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(screen.getByText(stale)).toBeTruthy())
    expect(screen.getByText(stale)).toBe(document.activeElement)
    expect(first.value).toBe("younger")

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(first).toBe(document.activeElement))
    expect(first.value).toBe("younger")
    expect(first.getAttribute("aria-describedby")).toBeTruthy()
  })

  it("uses exact permission and network save copy while preserving the draft", async () => {
    const permission = "Roster not saved. Your account no longer has Lodge edit access. Ask a full admin to update it."
    const network = "Roster not saved because the service could not be reached. Your draft is still here; try Save again."
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "ROSTER_SERVICE_UNAVAILABLE", error: "internal detail" }), { status: 500 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const first = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    fireEvent.change(first, { target: { value: "younger" } })

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(screen.getByText(permission)).toBeTruthy())
    expect(screen.getByText(permission)).toBe(document.activeElement)
    expect(first.value).toBe("younger")

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(screen.getByText(network)).toBeTruthy())
    expect(screen.getByText(network)).toBe(document.activeElement)
    expect(first.value).toBe("younger")

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(screen.getByText(network)).toBe(document.activeElement)
    expect(first.value).toBe("younger")
  })

  it("always shows due-chore staffing and booking-grouped zero/one/many guest checks with repeat counts", () => {
    const roster = {
      ...BASE,
      assignments: [
        ...BASE.assignments,
        { ...BASE.assignments[1], id: "a-3" },
        { ...BASE.assignments[0], id: "a-4", bookingGuestId: "younger", guestName: "Mika Bell", guestAgeTier: "CHILD" },
      ],
    }
    renderEditor(roster)
    expect(screen.getByText("Kitchen:").parentElement?.textContent).toBe("Kitchen: 2 assigned — within recommendation 1–3")
    expect(screen.getByText("Firewood:").parentElement?.textContent).toBe("Firewood: 2 assigned — over recommendation 1")
    expect(screen.getByText("Bathrooms:").parentElement?.textContent).toBe("Bathrooms: 0 assigned — under recommendation 1")
    expect(screen.queryByText("Weekly check:")).toBeNull()
    const familyA = screen.getByRole("region", { name: "Booking for Aroha Bell" })
    expect(within(familyA).getByText(/3 assignments: Kitchen, Firewood ×2/)).toBeTruthy()
    expect(within(familyA).getByText(/1 assignment: Kitchen/)).toBeTruthy()
    const familyB = screen.getByRole("region", { name: "Booking for Taylor Chen" })
    expect(within(familyB).getAllByText("No chore assigned")).toHaveLength(2)
  })
})
