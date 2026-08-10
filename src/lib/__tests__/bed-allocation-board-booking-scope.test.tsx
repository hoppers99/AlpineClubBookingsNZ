// @vitest-environment jsdom

/*
 * The bed-allocation board's own half of the #2678 fix.
 *
 * WHY THIS FILE EXISTS AT ALL. `bed-allocation-get-lodge-validation.test.ts`
 * proves the API derives the board's lodge from `bookingId` and ignores any
 * `lodgeId` beside it. That proof is worth nothing to the board unless the board
 * actually SENDS `bookingId` on its own fetch — and nothing pinned that. The
 * whole of #2678's fix for the four board bed pickers (bucket "Select bed", the
 * allocation chip's "Move to bed", drag-and-drop onto a cell, and
 * `BedRangeAssignDialog` from the board) rests on one line in
 * `admin/bed-allocation/page.tsx` that nothing was asserting. Delete it and every
 * server-side test still passes while the board goes club-wide again.
 *
 * AND THE FLIP SIDE, which is the regression the fix itself created. Because the
 * API now ignores a `lodgeId` sent beside a `bookingId`, an admin who arrived on
 * the deep link and then chose a DIFFERENT lodge from the board's own selector
 * would have been served the booking's lodge under a selector reading the lodge
 * they picked. The board answers that by letting the focus go on a deliberate
 * lodge change — and by NOT letting it go when `LodgeSelect` reports `null` on
 * its own, because that is the `/api/admin/lodges` outage in which the
 * server-side derivation is the only thing keeping the board off a club-wide
 * read.
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardPayload } from "@/app/(admin)/admin/bed-allocation/_components/types";

const editAccessMock = vi.hoisted(() => vi.fn());

// The deep link `AdminBookingToolsCard` builds (#2678): the booking, its own
// lodge, and its stay window.
vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams(
      "bookingId=booking-1&lodgeId=lodge-1&from=2026-07-01&to=2026-07-08",
    ),
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

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>();
  return { ...actual, useAdminAreaEditAccess: () => editAccessMock() };
});

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

/*
 * A LodgeSelect that fires nothing by itself. The real one normalises through
 * `onChange` in an effect, which is exactly the call this test has to be able to
 * tell apart from an admin's, so the two are driven explicitly here instead.
 */
vi.mock("@/components/lodge-select", () => ({
  LodgeSelect: ({ onChange }: { onChange: (value: string | null) => void }) => (
    <div>
      <button type="button" onClick={() => onChange("lodge-2")}>
        Pick lodge two
      </button>
      <button type="button" onClick={() => onChange(null)}>
        Report no lodge
      </button>
    </div>
  ),
  useLodgeOptions: () => ({
    lodges: [
      { id: "lodge-1", name: "Test Lodge" },
      { id: "lodge-2", name: "Other Lodge" },
    ],
    loading: false,
  }),
}));

vi.mock("@/components/admin/bed-allocation-removal-dialog", () => ({
  bedAllocationRemovalCategoryForAnchor: () => "MANUAL_DRAFT",
  useBedAllocationRemovalDialog: () => ({
    openRemovalDialog: vi.fn(),
    dialog: <div data-testid="removal-dialog-seam" />,
  }),
}));
vi.mock("@/components/admin/bed-allocation-move-dialog", () => ({
  useBedAllocationMoveDialog: () => ({
    openMoveDialog: vi.fn(),
    dialog: <div data-testid="move-dialog-seam" />,
  }),
}));
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
      allocationPriorityOrder: [
        "BOOKING_COHESION",
        "STAY_CONTINUITY",
        "REQUESTED_ROOM",
        "FAMILY_COHESION",
      ],
      updatedAt: null,
      updatedByMemberId: null,
    },
    range: { fromDate: "2026-07-01", toDate: "2026-07-08" },
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

function boardRequests(): URLSearchParams[] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith("/api/admin/bed-allocation?"))
    .map((url) => new URLSearchParams(url.split("?")[1]));
}

describe("bed allocation board — booking scope on the deep link (#2678)", () => {
  beforeEach(() => {
    editAccessMock.mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => buildPayload() }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("names the booking on its own dashboard request, which is what lets the server scope it", async () => {
    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    // MUTATION PROBE: drop `params.set("bookingId", …)` from `fetchDashboard`
    // and this is the only assertion in the repo that notices. Every
    // server-side #2678 test keeps passing, because the server can only derive
    // a lodge from a booking the client bothered to name.
    const [first] = boardRequests();
    expect(first?.get("bookingId")).toBe("booking-1");
    expect(first?.get("lodgeId")).toBe("lodge-1");
    expect(screen.getByText("Focused booking")).toBeInTheDocument();
  });

  it("lets the focus go when the admin deliberately picks another lodge", async () => {
    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    fireEvent.click(screen.getByRole("button", { name: "Pick lodge two" }));

    // The request that follows asks for lodge two and names NO booking, so the
    // server answers with lodge two rather than silently overriding it back to
    // the booking's lodge under a selector that now reads "Other Lodge".
    await waitFor(() => {
      const latest = boardRequests().at(-1);
      expect(latest?.get("lodgeId")).toBe("lodge-2");
      expect(latest?.has("bookingId")).toBe(false);
    });
    // And the drop is visible rather than silent.
    await waitFor(() =>
      expect(screen.queryByText("Focused booking")).not.toBeInTheDocument(),
    );
  });

  it("keeps the focus when LodgeSelect reports no lodge at all", async () => {
    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    // `LodgeSelect` calls `onChange(null)` by itself when `/api/admin/lodges`
    // fails and it is left with no options — the outage state, not a choice.
    // Losing the focus there would be the worst possible moment for it: the
    // server's derivation from `bookingId` is the only thing then keeping the
    // board off a club-wide read.
    fireEvent.click(screen.getByRole("button", { name: "Report no lodge" }));

    await waitFor(() => {
      const latest = boardRequests().at(-1);
      expect(latest?.has("lodgeId")).toBe(false);
      expect(latest?.get("bookingId")).toBe("booking-1");
    });
    expect(screen.getByText("Focused booking")).toBeInTheDocument();
  });
});
