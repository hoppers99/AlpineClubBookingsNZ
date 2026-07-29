// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BedRangeAssignDialog,
  rangeAssignError,
  type BedRangeAssignTarget,
} from "@/components/admin/bed-range-assign-dialog";

const fetchMock = vi.fn();
const toastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

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
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
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

const target: BedRangeAssignTarget = {
  bookingGuestId: "guest-1",
  bookingId: "booking-1",
  guestName: "Range Guest",
  memberName: "Range Member",
  bedId: "bed-1",
  fromDate: "2026-06-01",
  toDate: "2026-06-06",
};

const bedOptionGroups = [
  { roomId: "room-1", roomName: "Room One", beds: [{ id: "bed-1", bedName: "Bed One" }] },
];

function renderDialog(overrides: { onAssigned?: () => void } = {}) {
  const onAssigned = overrides.onAssigned ?? vi.fn();
  render(
    <BedRangeAssignDialog
      open
      onOpenChange={vi.fn()}
      target={target}
      bedOptionGroups={bedOptionGroups}
      canEdit
      onAssigned={onAssigned}
    />,
  );
  return { onAssigned };
}

function refusalResponse(status: number, result: Record<string, unknown>) {
  return {
    ok: false,
    status,
    json: async () => ({ error: "Nothing was written", result }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

describe("BedRangeAssignDialog", () => {
  it("shows the range summary and warns that assigning approves the beds", () => {
    renderDialog();

    expect(screen.getByTestId("range-summary")).toHaveTextContent(
      "5 nights · first night 2026-06-01 · last night 2026-06-05",
    );
    // Under auto-approve, the member lock fires on the FIRST range assign.
    expect(
      screen.getByText(/locks this booking's member out of changing/i),
    ).toBeInTheDocument();
  });

  it("attempts the whole range with no preview step", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          applied: true,
          freeNightsOnly: false,
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          guestName: "Range Guest",
          bedId: "bed-1",
          bedName: "Bed One",
          roomName: "Room One",
          fromDate: "2026-06-01",
          toDate: "2026-06-06",
          requestedNights: [],
          freeNights: [],
          writtenNights: ["2026-06-01"],
          refusals: [],
        },
      }),
    });
    const { onAssigned } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));

    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/bed-allocation/allocations/range");
    expect(JSON.parse(init.body)).toEqual({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
    });
  });

  it("renders all three refusal categories distinctly and arms the free-nights action", async () => {
    fetchMock.mockResolvedValueOnce(
      refusalResponse(400, {
        applied: false,
        freeNightsOnly: false,
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Range Guest",
        bedId: "bed-1",
        bedName: "Bed One",
        roomName: "Room One",
        fromDate: "2026-06-01",
        toDate: "2026-06-06",
        requestedNights: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
        ],
        freeNights: ["2026-06-01", "2026-06-05"],
        writtenNights: [],
        refusals: [
          {
            stayDate: "2026-06-02",
            category: "BED_TAKEN",
            occupiedBy: {
              guestName: "Other Guest",
              memberName: "Other Member",
              bookingId: "booking-other",
              holdsCapacity: false,
            },
          },
          { stayDate: "2026-06-03", category: "GUEST_NOT_BOOKED" },
          {
            stayDate: "2026-06-04",
            category: "EXCLUSIVE_HOLD",
            hold: {
              bookingId: "booking-hold",
              memberName: "Hold Member",
              ownBooking: false,
            },
          },
        ],
      }),
    );
    const { onAssigned } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));

    await screen.findByTestId("range-refusal-report");
    // Nothing was applied, so the dialog stays open with the evidence.
    expect(onAssigned).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Nothing was written — 3 of 5 nights are blocked/),
    ).toBeInTheDocument();

    // Three distinct categories, never merged into "skipped".
    const bedTaken = screen.getByTestId("refusal-category-BED_TAKEN");
    expect(bedTaken).toHaveTextContent("Bed already allocated");
    expect(bedTaken).toHaveTextContent("Other Guest");
    // Provisional occupant: still a conflict, badged as not holding.
    expect(bedTaken).toHaveTextContent("Provisional");

    const notBooked = screen.getByTestId("refusal-category-GUEST_NOT_BOOKED");
    expect(notBooked).toHaveTextContent("Guest is not booked that night");
    expect(notBooked).toHaveTextContent(/not a clash/i);

    const hold = screen.getByTestId("refusal-category-EXCLUSIVE_HOLD");
    expect(hold).toHaveTextContent("Whole-lodge hold");
    expect(hold).toHaveTextContent("Hold Member");

    // The second action is explicit, states the exact count, and is the only
    // way a partial result can happen.
    const freeNightsButton = screen.getByRole("button", {
      name: "Assign the 2 free nights",
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          applied: true,
          freeNightsOnly: true,
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          guestName: "Range Guest",
          bedId: "bed-1",
          bedName: "Bed One",
          roomName: "Room One",
          fromDate: "2026-06-01",
          toDate: "2026-06-06",
          requestedNights: [],
          freeNights: [],
          writtenNights: ["2026-06-01", "2026-06-05"],
          refusals: [],
        },
      }),
    });
    fireEvent.click(freeNightsButton);

    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      freeNightsOnly: true,
    });
  });

  it("offers no free-nights action when every night is blocked", async () => {
    fetchMock.mockResolvedValue(
      refusalResponse(409, {
        applied: false,
        freeNightsOnly: false,
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Range Guest",
        bedId: "bed-1",
        bedName: "Bed One",
        roomName: "Room One",
        fromDate: "2026-06-01",
        toDate: "2026-06-06",
        requestedNights: ["2026-06-01"],
        freeNights: [],
        writtenNights: [],
        refusals: [
          {
            stayDate: "2026-06-01",
            category: "EXCLUSIVE_HOLD",
            hold: {
              bookingId: "booking-1",
              memberName: "Own Member",
              ownBooking: true,
            },
          },
        ],
      }),
    );
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));

    await screen.findByTestId("range-refusal-report");
    expect(
      screen.getByText(/No night in this range is free/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /free night/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/This booking holds the whole lodge/),
    ).toBeInTheDocument();
  });

  it("refuses an over-long range on the client rather than shortening it", () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText("Date Out (checkout)"), {
      target: { value: "2028-06-01" },
    });

    // The typed dates stay exactly as typed; the button is blocked instead.
    expect(screen.getByLabelText("Date Out (checkout)")).toHaveValue("2028-06-01");
    expect(screen.getByText(/covers at most 366 nights/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Assign/ })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("rangeAssignError", () => {
  it("accepts a well-formed range of any length up to the cap", () => {
    expect(rangeAssignError("2026-06-01", "2026-09-01")).toBeNull();
  });

  it("refuses a backwards range and an over-long one", () => {
    expect(rangeAssignError("2026-06-08", "2026-06-01")).toBe(
      "Date out must be after date in.",
    );
    expect(rangeAssignError("2026-01-01", "2027-06-01")).toContain(
      "at most 366 nights",
    );
  });
});
