// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";
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
  Select: ({
    children,
    onValueChange,
    disabled,
  }: {
    children: ReactNode;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
  }) => (
    <div>
      {/* Test-only handle: the Radix select cannot be driven through
          fireEvent, so the mock exposes one button that picks bed-1 — enough
          for the range dialog to submit from inside the panel. */}
      <button
        type="button"
        data-testid="range-bed-pick-bed-1"
        disabled={disabled}
        onClick={() => onValueChange?.("bed-1")}
      >
        pick bed-1
      </button>
      {children}
    </div>
  ),
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

function removalPreview(reopened = false, matchedRowCount = 1) {
  return {
    digestVersion: "v1",
    digest: "reviewed-digest",
    scope: {
      type: "ALLOCATION",
      allocationId: "alloc-1",
      lodgeId: "lodge-1",
      stayDate: "2026-06-01",
    },
    context: {
      lodgeId: "lodge-1",
      lodgeName: "Test Lodge",
      from: "2026-06-01",
      to: "2026-06-02",
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      guestName: "Ada Guest",
      anchorNight: "2026-06-01",
    },
    categories: {
      AUTO_DRAFT: 0,
      MANUAL_DRAFT: 0,
      APPROVED: matchedRowCount,
    },
    matchedRowCount,
    affectedBookingCount: matchedRowCount > 0 ? 1 : 0,
    affectedNights: matchedRowCount > 0 ? ["2026-06-01"] : [],
    promotions: [],
    reopenedBookings: reopened
      ? [{ bookingId: "booking-1", memberName: "Ada Member" }]
      : [],
  };
}

// The panel (and the shared range dialog inside it) reads the club's own word
// for a hut leader (#2286); the provider is always mounted above it in the app
// shell, so the tests mount it too.
function panelElement(overrides: Record<string, unknown> = {}) {
  return (
    <ClubIdentityProvider value={clubIdentity}>
      <BookingBedAllocationPanel
        bookingId="booking-1"
        lodgeId="lodge-1"
        lodgeName="Test Lodge"
        memberName="Ada Member"
        checkIn="2026-06-01"
        checkOut="2026-06-04"
        wholeLodgeHold={false}
        bookingStatus="CONFIRMED"
        isDeleted={false}
        canHoldBeds
        guests={[{ id: "guest-1", name: "Ada Guest" }]}
        {...overrides}
      />
    </ClubIdentityProvider>
  );
}

function renderPanel(overrides: Record<string, unknown> = {}) {
  return render(panelElement(overrides));
}

describe("BookingBedAllocationPanel", () => {
  beforeEach(() => {
    // reset, not clear: `clearAllMocks` leaves queued `mockImplementationOnce`
    // entries in place, so an unconsumed one-shot response from a test that
    // interleaves reads would be served to the NEXT test's first fetch.
    vi.resetAllMocks();
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
    // The booking selector, plus the same lodge scope the panel READ with, so
    // the write cannot reach a row the officer was never shown (#2252 review).
    expect(body).toEqual({ bookingId: "booking-1", lodgeId: "lodge-1" });
    // A window approval would stamp every other booking's drafts in the range.
    expect(body.from).toBeUndefined();
    expect(body.to).toBeUndefined();
    expect(body.allocationIds).toBeUndefined();
  });

  it("keeps the approval club-wide when the booking has no lodge", async () => {
    // Null lodgeId is the pre-backfill tolerance the board keeps too: scoping to
    // a lodge the booking does not have would approve nothing at all.
    renderPanel({ lodgeId: null });

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
    expect(JSON.parse(String(approveCall?.[1]?.body))).toEqual({
      bookingId: "booking-1",
    });
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
    fetchMock.mockResolvedValueOnce(jsonResponse(removalPreview(true)));
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview removal" }),
    );

    expect(
      await screen.findByText(/The final approved allocation will be removed/),
    ).toBeInTheDocument();
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

    fetchMock.mockResolvedValueOnce(jsonResponse(removalPreview(false)));
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview removal" }),
    );
    await screen.findByText(/matching allocation/);
    expect(
      screen.queryByText("Requested-room editing will re-open"),
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
    renderPanel({ bookingStatus: "CANCELLED", canHoldBeds: false });

    expect(await screen.findByTestId("bed-not-allocatable")).toHaveTextContent(
      "cancelled booking is not allocated beds",
    );
    expect(screen.queryByRole("button", { name: "Assign…" })).toBeNull();
    // Server truth needs no window read to establish it: no fetch is issued at
    // all, so the honest note is not sat behind a spinner.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /*
   * The three honest-state symptoms the review found (#2252). All three came
   * from one shared inference — "absent from the window payload means this
   * booking cannot hold beds" — which is false for two entirely different
   * reasons and silently swallowed a third case.
   */
  it("still gives a cancelled booking the honest note when it carries a stale whole-lodge hold", async () => {
    // Symptom (a): `wholeLodgeHold` is not cleared when a booking is cancelled
    // or soft-deleted, and the hold branch used to win — so the booking read as
    // an active hold with "nothing to assign or confirm while the hold stands",
    // suppressing the note the owner explicitly asked for.
    renderPanel({
      bookingStatus: "CANCELLED",
      canHoldBeds: false,
      wholeLodgeHold: true,
    });

    expect(await screen.findByTestId("bed-not-allocatable")).toHaveTextContent(
      "cancelled booking is not allocated beds",
    );
    expect(screen.queryByTestId("bed-exclusive-hold")).not.toBeInTheDocument();
  });

  it("gives a deleted booking the honest note ahead of any stale hold flag", async () => {
    renderPanel({ isDeleted: true, wholeLodgeHold: true });

    expect(await screen.findByTestId("bed-not-allocatable")).toHaveTextContent(
      "This booking is deleted",
    );
    expect(screen.queryByTestId("bed-exclusive-hold")).not.toBeInTheDocument();
  });

  it("says the page has none of this booking's nights, rather than that it cannot hold beds", async () => {
    // Symptom (b): the window read only returns bookings with a guest night
    // inside the window, so a guest-stay gap — or a booking with no guests —
    // omits a perfectly allocatable booking. That is a fact about the PAGE.
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          bookings: [],
          allocations: [],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel();

    expect(await screen.findByTestId("bed-absent-this-window")).toHaveTextContent(
      "No guest of this booking is booked on any night of this page",
    );
    // It does NOT claim the booking cannot hold beds…
    expect(screen.queryByTestId("bed-not-allocatable")).not.toBeInTheDocument();
    // …and the rows and Confirm stay reachable rather than everything vanishing.
    expect(screen.getByTestId("bed-guest-rows")).toBeInTheDocument();
    expect(screen.getByText("Ada Guest")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm draft beds" }),
    ).toBeInTheDocument();
  });

  it("prefills Assign from the page on screen when the guest's own stay is unknown", async () => {
    // Symptom (c): with the booking absent from the payload the guest has no
    // stay to prefill from, and the old envelope fallback offered the WHOLE
    // 61-night booking — nights the guest may not be booked for, and more than
    // the range endpoint will ever accept.
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          bookings: [],
          allocations: [],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel({ checkIn: "2026-06-01", checkOut: "2026-08-01" });

    fireEvent.click(await screen.findByRole("button", { name: "Assign…" }));

    await screen.findByRole("dialog");
    // The first page's own window (31 nights), not 2026-06-01 → 2026-08-01.
    expect(
      (screen.getByLabelText("Date In (first night)") as HTMLInputElement).value,
    ).toBe("2026-06-01");
    expect(
      (screen.getByLabelText("Date Out (checkout)") as HTMLInputElement).value,
    ).toBe("2026-07-02");
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

  it("lets a view-only admin preview removal but never apply it", async () => {
    editAccess.mockReturnValue(false);
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          allocations: [
            allocation({
              id: "alloc-1",
              approvedAt: "2026-05-01T00:00:00.000Z",
            }),
          ],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel();

    await screen.findByText("Ada Guest");
    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent(
      "preview removals, but not assign, apply removals, or confirm beds",
    );
    expect(screen.getByRole("button", { name: "Assign…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Confirm draft beds" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(removalPreview(false)));
    const previewButton = await screen.findByRole("button", {
      name: "Preview removal",
    });
    await waitFor(() => expect(previewButton).toBeEnabled());
    fireEvent.click(previewButton);

    await screen.findByText(/matching allocation/);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/admin/bed-allocation/allocations/removal",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    ).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        typeof init === "object" && init !== null && "method" in init
          ? init.method === "PUT"
          : false,
      ),
    ).toBe(false);
  });

  it("does not claim the lock re-opens when the booking's other pages hold confirmed nights", async () => {
    /*
     * The paged variant of the warning (#2252 review). This page holds the only
     * confirmed run it can SEE, so a page-scoped decision fires the warning —
     * but the booking has four approved nights in total, so removing these two
     * re-opens nothing. The count comes from the server precisely because a
     * 31-night window cannot see the rest of a longer stay.
     */
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          allocations: [
            allocation({
              id: "alloc-1",
              stayDate: "2026-06-01",
              approvedAt: "2026-05-01T00:00:00.000Z",
            }),
          ],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel({
      checkIn: "2026-06-01",
      checkOut: "2026-08-01",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    fetchMock.mockResolvedValueOnce(jsonResponse(removalPreview(false)));
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview removal" }),
    );
    await screen.findByText(/matching allocation/);
    expect(
      screen.queryByText("Requested-room editing will re-open"),
    ).not.toBeInTheDocument();
  });

  it("still warns on a paged stay when these really are the booking's last confirmed nights", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          allocations: [
            allocation({
              id: "alloc-1",
              stayDate: "2026-06-01",
              approvedAt: "2026-05-01T00:00:00.000Z",
            }),
          ],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel({
      checkIn: "2026-06-01",
      checkOut: "2026-08-01",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(removalPreview(true)));
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview removal" }),
    );

    expect(
      await screen.findByText(/The final approved allocation will be removed/),
    ).toBeInTheDocument();
  });

  it("drops a superseded window read rather than painting its rows under the current one", async () => {
    /*
     * Stale-response guard (#2252 review). The guard covers every `load()`
     * caller — the effect, Refresh, paging, and the trailing reload each write
     * path fires — so this drives it the way it can genuinely happen without a
     * disabled control in the way: a read is in flight when the props the read
     * is keyed on change, and the FIRST read settles last.
     */
    // A holder, not a `let`: TS narrows a closure-assigned local to its
    // initializer type, because it cannot prove the callback ever ran.
    const gate = { release: () => {} };
    const firstPayload = payload({
      allocations: [allocation({ id: "alloc-old", stayDate: "2026-06-01" })],
      unallocatedGuestNights: [],
    });
    const secondPayload = payload({
      allocations: [
        allocation({
          id: "alloc-new",
          bedId: "bed-2",
          bedName: "Bed Two",
          stayDate: "2026-06-02",
        }),
      ],
      unallocatedGuestNights: [],
    });

    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          gate.release = () => resolve(jsonResponse(firstPayload));
        }),
    );
    fetchMock.mockImplementationOnce(async () => jsonResponse(secondPayload));

    const { rerender } = renderPanel();

    // A second read starts while the first is still outstanding.
    rerender(panelElement({ lodgeId: "lodge-2" }));

    await screen.findByText("Room One / Bed Two");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Now let the SUPERSEDED read land. It must be discarded in full.
    gate.release();

    await waitFor(() => {
      expect(screen.getByText("Room One / Bed Two")).toBeInTheDocument();
    });
    expect(screen.queryByText("Room One / Bed One")).not.toBeInTheDocument();
  });

  it("keeps a superseded read's error off the window it no longer describes", async () => {
    const gate = { release: () => {} };
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          gate.release = () =>
            resolve(jsonResponse({ error: "Window out of range" }, false, 400));
        }),
    );
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(payload({ unallocatedGuestNights: [] })),
    );

    const { rerender } = renderPanel();

    rerender(panelElement({ lodgeId: "lodge-2" }));

    await screen.findByText("Ada Guest");
    gate.release();

    await waitFor(() => {
      expect(screen.queryByText("Window out of range")).not.toBeInTheDocument();
    });
    // …and the superseded read cannot blank the rows it no longer describes.
    expect(screen.getByText("Ada Guest")).toBeInTheDocument();
  });

  it("qualifies the card badge with the page when the stay is paged", async () => {
    // The badge counts only what this page read, so on a paged stay it must not
    // read as a flat verdict on the whole booking (#2252 review).
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
    renderPanel({ checkIn: "2026-06-01", checkOut: "2026-08-01" });

    expect(
      await screen.findByTestId("bed-card-status-badge"),
    ).toHaveTextContent("Confirmed (this page)");
  });

  it("leaves the badge unqualified when one page is the whole stay", async () => {
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

    // One page IS the whole stay, so the badge is a verdict on the booking and
    // needs no qualifier. (The per-run badge says "Confirmed" too, hence the
    // testid: the assertion is about the CARD's badge.)
    const badge = await screen.findByTestId("bed-card-status-badge");
    expect(badge).toHaveTextContent("Confirmed");
    expect(badge.textContent).not.toContain("this page");
  });

  it("splits displayed runs at removal-category boundaries", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          allocations: [
            allocation({ id: "alloc-1", stayDate: "2026-06-01", source: "AUTO" }),
            allocation({
              id: "alloc-2",
              stayDate: "2026-06-02",
              source: "MANUAL",
            }),
          ],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel();

    expect(await screen.findByText("Suggested")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
    expect(screen.queryByText("Suggested in part")).not.toBeInTheDocument();
  });

  it("reports the server's committed reviewed-removal count", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          allocations: [
            allocation({ id: "alloc-1", stayDate: "2026-06-01" }),
          ],
          unallocatedGuestNights: [],
        }),
      ),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...removalPreview(false),
        categories: { AUTO_DRAFT: 1, MANUAL_DRAFT: 0, APPROVED: 0 },
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview removal" }),
    );
    await screen.findByText(/matching allocation/);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        removedRowCount: 1,
        promotedRowCount: 0,
        affectedBookingCount: 1,
        affectedNights: ["2026-06-01"],
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    );

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringContaining("1 reviewed bed night removed"),
      );
    });
  });

  /*
   * Custodian occupancy (#2286 wired into #2252's panel). A custodian bed hold
   * is a bed held for a season by a hut-leader assignment, with no booking and
   * no BedAllocation row anywhere. The panel reads the same dashboard payload
   * the board does, so it must show the same three honest facts: which beds in
   * the window are held (they are offered in Assign… and the server WILL
   * refuse them), that a run of this booking sitting on a held bed-night is
   * blocked rather than clean-looking, and — when an assign attempt does hit a
   * hold — the server's standard CUSTODIAN_HOLD refusal report, never a
   * silent failure.
   */
  const custodianHold = {
    assignmentId: "assign-1",
    memberName: "Custodian Chris",
    bedId: "bed-2",
    bedName: "Bed Two",
    roomName: "Room One",
    startDate: "2026-06-02",
    endDate: "2026-06-03",
    nights: ["2026-06-02", "2026-06-03"],
  };

  it("renders a custodian-held run blocked with the board's neutral hatched treatment and the shared refusal category", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          allocations: [
            allocation({ id: "alloc-1", stayDate: "2026-06-01" }),
            // This booking's row sitting on the held bed-night — the board's
            // CUSTODIAN_BED_CONFLICT, seen from the booking.
            allocation({
              id: "alloc-held",
              bedId: "bed-2",
              bedName: "Bed Two",
              stayDate: "2026-06-02",
            }),
          ],
          unallocatedGuestNights: [],
          custodianHolds: [custodianHold],
        }),
      ),
    );
    renderPanel();

    const marker = await screen.findByTestId("bed-run-custodian-hold");
    // The category is the SERVER's union member, reached through the shared
    // dialog's re-export — the wiring imports it, never re-declares it.
    expect(marker).toHaveAttribute("data-refusal-category", "CUSTODIAN_HOLD");
    // The labelled pill carries the meaning, in the club's own word for the
    // role (the same copy the shared dialog titles the category with)…
    expect(marker).toHaveTextContent(
      `Held for a ${clubIdentity.hutLeaderLabel.toLowerCase()}`,
    );
    // …and the hatching is the board cell's neutral treatment, a redundant
    // second signal rather than the only one.
    expect(marker.style.backgroundImage).toContain("repeating-linear-gradient");

    // The availability note mirrors the board's copy and names the page that
    // actually fixes it.
    expect(screen.getByTestId("bed-custodian-holds")).toHaveTextContent(
      "no guest can be placed on them",
    );
    expect(
      screen.getByRole("link", {
        name: `${clubIdentity.hutLeaderLabel} Assignments`,
      }),
    ).toHaveAttribute("href", "/admin/hut-leaders");
    expect(screen.getByText("Custodian Chris")).toBeInTheDocument();

    // …and the Assign dialog's bed list says so up front, before any round
    // trip — the held bed stays listed (a hold may cover only part of a
    // range; the server's per-night refusal is the authority), labelled.
    fireEvent.click(screen.getAllByRole("button", { name: "Assign…" })[0]);
    await screen.findByRole("dialog");
    expect(
      screen.getByText(
        `Room One / Bed Two — held for a ${clubIdentity.hutLeaderLabel.toLowerCase()} (2026-06-02 → 2026-06-03)`,
      ),
    ).toBeInTheDocument();
  });

  it("renders no custodian marker or note when the payload has none — including an old-colour payload without the field", async () => {
    // The base payload() deliberately carries NO custodianHolds field at all
    // (the deploy-drain shape an old-colour server answers with): the panel
    // must neither crash nor invent a hold. Together with the test above this
    // is the mutation check on the wiring — the marker appears exactly when
    // the payload says a hold covers a rendered bed-night.
    renderPanel();

    await screen.findByText("Ada Guest");
    expect(
      screen.queryByTestId("bed-run-custodian-hold"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("bed-custodian-holds")).not.toBeInTheDocument();
  });

  it("surfaces the standard CUSTODIAN_HOLD refusal report when an assign attempt hits a held bed-night", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Assign…" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("range-bed-pick-bed-1"));

    // The atomic range endpoint refuses the whole attempt (409 + report);
    // nothing is written and nothing is silent.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: "Nothing was written",
        result: {
          applied: false,
          partialByConsent: false,
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          guestName: "Ada Guest",
          bedId: "bed-1",
          bedName: "Bed One",
          roomName: "Room One",
          fromDate: "2026-06-01",
          toDate: "2026-06-04",
          requestedNights: ["2026-06-01", "2026-06-02", "2026-06-03"],
          freeNights: ["2026-06-01"],
          writtenNights: [],
          refusals: [
            { stayDate: "2026-06-02", category: "CUSTODIAN_HOLD" },
            { stayDate: "2026-06-03", category: "CUSTODIAN_HOLD" },
          ],
        },
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: /^Assign 3 nights$/ }));

    const block = await screen.findByTestId("refusal-category-CUSTODIAN_HOLD");
    expect(block).toHaveTextContent(
      `Held for a ${clubIdentity.hutLeaderLabel.toLowerCase()}`,
    );
    expect(block).toHaveTextContent(
      new RegExp(`${clubIdentity.hutLeaderLabel} Assignments page`),
    );
    expect(block).toHaveTextContent("2026-06-02");
    expect(block).toHaveTextContent("2026-06-03");
    expect(
      screen.getByText(/Nothing was written — 2 of 3 nights are blocked/),
    ).toBeInTheDocument();
  });
});
