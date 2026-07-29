// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingBedAllocationPanel } from "@/components/admin/booking-bed-allocation-panel";

/*
 * The in-booking Bed allocation panel (#2252).
 *
 * The panel is deliberately thin over machinery it does not own, so what these
 * tests pin is the part that IS its own: which slice of the window payload it
 * shows (the dashboard GET does not filter by booking — that is this
 * component's job), what it refuses to render for a held or non-allocatable
 * booking, that Confirm can only ever be a booking-scoped approval, that the
 * member room-request lock is described as the two-way thing it really is, and
 * that a stay too long for one read window is paged with the window labelled
 * rather than silently truncated.
 */

const fetchMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const editAccess = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    warning: vi.fn(),
  },
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  ADMIN_VIEW_ONLY_ACTION_REASON:
    "Your admin role can view this area but cannot make changes.",
  useAdminAreaEditAccess: () => editAccess(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Render dialog contents inline so the SHARED range dialog (#2251) really
// mounts inside the panel and its prefill and warnings can be asserted.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: (props: ComponentProps<"label">) => <label {...props} />,
}));

const rooms = [
  {
    id: "room-1",
    name: "Room One",
    sortOrder: 1,
    active: true,
    beds: [
      { id: "bed-1", name: "Bed One", sortOrder: 1, active: true },
      { id: "bed-2", name: "Bed Two", sortOrder: 2, active: true },
    ],
  },
];

function allocation(overrides: Record<string, unknown> = {}) {
  return {
    id: "alloc-1",
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    guestName: "Ada Guest",
    guestAgeTier: "ADULT",
    roomName: "Room One",
    bedId: "bed-1",
    bedName: "Bed One",
    stayDate: "2026-06-01",
    source: "MANUAL",
    approvedAt: null,
    approvedByName: null,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    range: { fromDate: "2026-06-01", toDate: "2026-06-04" },
    rooms,
    bookings: [
      {
        id: "booking-1",
        status: "CONFIRMED",
        memberName: "Ada Member",
        wholeLodgeHold: false,
        overlapsExclusiveHold: false,
        guests: [
          { id: "guest-1", stayStart: "2026-06-01", stayEnd: "2026-06-04" },
        ],
      },
    ],
    allocations: [
      allocation({ id: "alloc-1", stayDate: "2026-06-01" }),
      allocation({ id: "alloc-2", stayDate: "2026-06-02" }),
      // Another booking's row, in the same window. The dashboard GET returns
      // the WHOLE window — filtering to this booking is the panel's job.
      allocation({
        id: "alloc-other",
        bookingId: "booking-2",
        bookingGuestId: "guest-9",
        guestName: "Someone Else",
        bedId: "bed-2",
        bedName: "Bed Two",
        stayDate: "2026-06-01",
      }),
    ],
    unallocatedGuestNights: [
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Ada Guest",
        guestAgeTier: "ADULT",
        stayDate: "2026-06-03",
      },
    ],
    exclusiveHolds: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function renderPanel(overrides: Record<string, unknown> = {}) {
  return render(
    <BookingBedAllocationPanel
      bookingId="booking-1"
      lodgeId="lodge-1"
      memberName="Ada Member"
      checkIn="2026-06-01"
      checkOut="2026-06-04"
      wholeLodgeHold={false}
      bookingStatus="CONFIRMED"
      isDeleted={false}
      guests={[{ id: "guest-1", name: "Ada Guest" }]}
      {...overrides}
    />,
  );
}

describe("BookingBedAllocationPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editAccess.mockReturnValue(true);
    fetchMock.mockResolvedValue(jsonResponse(payload()));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("shows only this booking's guests and collapses contiguous nights into a run", async () => {
    renderPanel();

    await screen.findByText("Ada Guest");
    expect(screen.queryByText("Someone Else")).not.toBeInTheDocument();

    // Two contiguous nights on one bed read as one run, not two lines.
    expect(screen.getByText("Room One / Bed One")).toBeInTheDocument();
    expect(screen.getByText("2026-06-01 → 2026-06-02")).toBeInTheDocument();
    expect(screen.getByText("2 placed ·", { exact: false })).toBeInTheDocument();

    // The read is scoped to the stay window and the booking's lodge.
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("from=2026-06-01");
    expect(url).toContain("to=2026-06-04");
    expect(url).toContain("lodgeId=lodge-1");
  });

  it("opens the shared range dialog prefilled with the guest's own stay and the member-lock warning", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Assign…" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Assign a range of nights");
    // The lock fires at the FIRST range assign, because range assignments
    // auto-approve — the dialog says so before the admin commits.
    expect(dialog).toHaveTextContent("This confirms the beds straight away");
    expect(dialog).toHaveTextContent(
      "locks this booking's member out of changing their requested room",
    );

    // Prefilled from the GUEST's stay window, not the booking envelope.
    expect(
      (screen.getByLabelText("Date In (first night)") as HTMLInputElement).value,
    ).toBe("2026-06-01");
    expect(
      (screen.getByLabelText("Date Out (checkout)") as HTMLInputElement).value,
    ).toBe("2026-06-04");
  });

  it("confirms with the booking selector and never a date range", async () => {
    renderPanel();

    const confirm = await screen.findByRole("button", {
      name: "Confirm draft beds",
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ approvedCount: 2 }));
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          (call) => String(call[0]) === "/api/admin/bed-allocation/approve",
        ),
      ).toBe(true);
    });

    const approveCall = fetchMock.mock.calls.find(
      (call) => String(call[0]) === "/api/admin/bed-allocation/approve",
    );
    const body = JSON.parse(String(approveCall?.[1]?.body));
    expect(body).toEqual({ bookingId: "booking-1" });
    // A window approval would stamp every other booking's drafts in the range.
    expect(body.from).toBeUndefined();
    expect(body.to).toBeUndefined();
    expect(body.allocationIds).toBeUndefined();
  });

  it("says plainly that confirming does not place the nights nobody is on a bed for", async () => {
    renderPanel();

    expect(
      await screen.findByText(/still ha(s|ve) no bed/),
    ).toBeInTheDocument();
  });

  it("warns that removing the last confirmed nights re-opens the member's room request", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          allocations: [
            allocation({ id: "alloc-1", approvedAt: "2026-05-01T00:00:00.000Z" }),
          ],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    expect(
      await screen.findByTestId("bed-remove-reopens-lock"),
    ).toHaveTextContent("re-opens the member's room request");
  });

  it("does not claim the lock re-opens when confirmed nights remain elsewhere", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          allocations: [
            allocation({ id: "alloc-1", approvedAt: "2026-05-01T00:00:00.000Z" }),
            allocation({
              id: "alloc-2",
              bedId: "bed-2",
              bedName: "Bed Two",
              stayDate: "2026-06-03",
              approvedAt: "2026-05-01T00:00:00.000Z",
            }),
          ],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel();

    const removeButtons = await screen.findAllByRole("button", {
      name: "Remove",
    });
    fireEvent.click(removeButtons[0]);

    await screen.findByRole("dialog");
    expect(
      screen.queryByTestId("bed-remove-reopens-lock"),
    ).not.toBeInTheDocument();
  });

  it("replaces the rows with the ADR-001 banner and renders no controls for a whole-lodge hold", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          allocations: [],
          unallocatedGuestNights: [],
          exclusiveHolds: [
            {
              bookingId: "booking-1",
              memberName: "Ada Member",
              checkIn: "2026-06-01",
              checkOut: "2026-06-04",
              guestCount: 4,
              nights: ["2026-06-01", "2026-06-02", "2026-06-03"],
            },
          ],
        }),
      ),
    );
    renderPanel({ wholeLodgeHold: true });

    expect(await screen.findByTestId("bed-exclusive-hold")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Assign…" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Confirm draft beds" }),
    ).toBeNull();
    expect(screen.queryByTestId("bed-guest-rows")).not.toBeInTheDocument();
  });

  it("keeps the panel and says why for a booking that cannot hold beds", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          bookings: [],
          allocations: [],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel({ bookingStatus: "CANCELLED" });

    expect(await screen.findByTestId("bed-not-allocatable")).toHaveTextContent(
      "cancelled booking is not allocated beds",
    );
    expect(screen.queryByRole("button", { name: "Assign…" })).toBeNull();
  });

  it("pages a stay longer than one read window and labels every page", async () => {
    renderPanel({ checkIn: "2026-06-01", checkOut: "2026-08-01" });

    // 61 nights: page one is the first 31, and the label says exactly that.
    expect(await screen.findByTestId("bed-window-label")).toHaveTextContent(
      "Nights 1–31 of 61 · 2026-06-01 → 2026-07-02",
    );
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    expect(firstUrl).toContain("from=2026-06-01");
    expect(firstUrl).toContain("to=2026-07-02");

    fireEvent.click(screen.getByRole("button", { name: "Later nights" }));

    await waitFor(() => {
      expect(screen.getByTestId("bed-window-label")).toHaveTextContent(
        "Nights 32–61 of 61 · 2026-07-02 → 2026-08-01",
      );
    });
    const secondUrl = String(
      fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0],
    );
    expect(secondUrl).toContain("from=2026-07-02");
    expect(secondUrl).toContain("to=2026-08-01");

    // …and Confirm is honest that it reaches beyond the page on screen.
    expect(
      screen.getByText(
        /Confirm covers every draft bed night of this booking, including nights outside the page shown above/,
      ),
    ).toBeInTheDocument();
  });

  it("keeps a link back to the board for the same window", async () => {
    renderPanel();

    const link = (await screen.findByRole("link", {
      name: "Open on the board",
    })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("/admin/bed-allocation");
    expect(link.getAttribute("href")).toContain("bookingId=booking-1");
  });

  it("shows a view-only admin the reason and no usable controls", async () => {
    editAccess.mockReturnValue(false);
    renderPanel();

    await screen.findByText("Ada Guest");
    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent(
      "not assign, remove, or confirm beds",
    );
    expect(screen.getByRole("button", { name: "Assign…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Confirm draft beds" }),
    ).toBeDisabled();
  });

  it("reports how many nights actually went when a removal stops part way", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          allocations: [
            allocation({ id: "alloc-1", stayDate: "2026-06-01" }),
            allocation({ id: "alloc-2", stayDate: "2026-06-02" }),
          ],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");

    // First night deletes, second refuses: the toast must not claim the run is
    // gone. There is no bulk-remove endpoint, so a partial outcome is real.
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "Not found" }, false, 404),
    );

    const buttons = Array.from(dialog.querySelectorAll("button"));
    const confirmRemove = buttons.find(
      (button) => button.textContent?.trim() === "Remove",
    );
    fireEvent.click(confirmRemove as HTMLButtonElement);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("1 of 2 nights were removed"),
      );
    });
  });
});
