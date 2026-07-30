// @vitest-environment jsdom

/*
 * The board's REFUSED-WINDOW render guard (#2251).
 *
 * `boardWindowError()` withholds the fetch, but a payload from the PREVIOUS good
 * window survives in React state. Without the `payload && !windowError` guard in
 * the page, the board keeps rendering those stale rows underneath an Alert that
 * says the window is out of range — the admin sees a board for a window they no
 * longer asked for. The board-window unit tests cover the helper; this covers the
 * page actually honouring it.
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardPayload } from "@/app/(admin)/admin/bed-allocation/_components/types";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  KeyboardSensor: class {},
  PointerSensor: class {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(),
  useSensors: () => [],
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>();
  return { ...actual, useAdminAreaEditAccess: () => true };
});

vi.mock("@/components/lodge-select", () => ({
  LodgeSelect: () => null,
  useLodgeOptions: () => ({ lodges: [], loading: false }),
}));

// The board's contents are covered by their own component tests; here we only
// need to know WHETHER the board rendered at all.
vi.mock("@/app/(admin)/admin/bed-allocation/_components/room-table", () => ({
  RoomTable: () => <div data-testid="room-table" />,
}));
vi.mock("@/app/(admin)/admin/bed-allocation/_components/bucket-board", () => ({
  BucketBoard: () => <div data-testid="bucket-board" />,
}));
vi.mock("@/components/admin/bed-range-assign-dialog", () => ({
  BedRangeAssignDialog: () => null,
}));

import AdminBedAllocationPage from "@/app/(admin)/admin/bed-allocation/page";

function buildPayload(): DashboardPayload {
  return {
    settings: {
      autoAllocationEnabled: true,
      updatedAt: null,
      updatedByMemberId: null,
    },
    range: { fromDate: "2026-06-01", toDate: "2026-06-08" },
    rooms: [
      {
        id: "room-1",
        name: "Example Room",
        sortOrder: 1,
        active: true,
        notes: null,
        beds: [
          {
            id: "bed-1",
            name: "Bed One",
            sortOrder: 1,
            active: true,
            bedType: "SINGLE",
            notes: null,
            bunkGroupId: null,
            bunkPosition: null,
          },
        ],
      },
    ],
    bookings: [],
    allocations: [],
    unallocatedGuestNights: [],
    exclusiveHolds: [],
    suggestedAllocations: [],
    suggestedUnallocatedGuestNights: [],
    warnings: [],
    focusedBooking: null,
  } as unknown as DashboardPayload;
}

describe("bed allocation board — refused window", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => buildPayload(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("stops rendering the previous window's board once the typed window is refused", async () => {
    render(<AdminBedAllocationPage />);

    // A good window first: the board is on screen and a payload is in state.
    await waitFor(() => {
      expect(screen.getByTestId("room-table")).toBeInTheDocument();
    });

    const fetchCallsAfterLoad = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls.length;

    // Now type a window longer than the board's 31-night maximum.
    fireEvent.change(screen.getByLabelText("Date In"), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText("Date Out"), {
      target: { value: "2026-09-01" },
    });

    await waitFor(() => {
      expect(
        screen.getByText("The board window is out of range"),
      ).toBeInTheDocument();
    });

    // The stale board is GONE — the refusal is the only thing on screen for a
    // window the board will not show.
    expect(screen.queryByTestId("room-table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bucket-board")).not.toBeInTheDocument();
    // And no request was issued for the refused window.
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      fetchCallsAfterLoad,
    );

    // Back inside the limit, the board returns.
    fireEvent.change(screen.getByLabelText("Date Out"), {
      target: { value: "2026-06-08" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("room-table")).toBeInTheDocument();
    });
    expect(
      screen.queryByText("The board window is out of range"),
    ).not.toBeInTheDocument();
  });
});
