// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BED_ALLOCATION_COLUMN_WIDTH_CLASS,
  BED_ALLOCATION_COLUMN_WIDTH_REM,
} from "@/app/(admin)/admin/bed-allocation/_components/board-cell";
import { RoomTable } from "@/app/(admin)/admin/bed-allocation/_components/room-table";
import type {
  DashboardRoom,
} from "@/app/(admin)/admin/bed-allocation/_components/types";

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDraggable: () => ({
    setNodeRef: vi.fn(),
    attributes: {},
    listeners: {},
    transform: null,
    isDragging: false,
  }),
}));

function buildRoom(): DashboardRoom {
  return {
    id: "room-1",
    name: "Example Room",
    sortOrder: 1,
    active: true,
    notes: null,
    beds: [
      {
        id: "bed-1",
        roomId: "room-1",
        name: "Bed One",
        sortOrder: 1,
        active: true,
        bedType: "SINGLE",
        bunkGroup: null,
      },
    ],
  };
}

describe("RoomTable layout", () => {
  it("uses the same fixed width for the bed column and every date cell", () => {
    const nights = ["2026-07-01", "2026-07-02"];
    const { container } = render(
      <RoomTable
        room={buildRoom()}
        nights={nights}
        allocationByBedAndDate={new Map()}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
      />,
    );

    const table = container.querySelector("table");
    expect(table?.className).toContain("table-fixed");
    expect(table?.getAttribute("style")).toContain(
      `width: ${(nights.length + 1) * BED_ALLOCATION_COLUMN_WIDTH_REM}rem`,
    );

    const columns = Array.from(container.querySelectorAll("col"));
    expect(columns).toHaveLength(nights.length + 1);
    expect(
      columns.every((column) =>
        column.className.includes(BED_ALLOCATION_COLUMN_WIDTH_CLASS),
      ),
    ).toBe(true);

    const fixedCells = Array.from(
      container.querySelectorAll("th, td"),
    ).filter((cell) =>
      cell.className.includes(BED_ALLOCATION_COLUMN_WIDTH_CLASS),
    );
    expect(fixedCells).toHaveLength(nights.length * 2 + 2);
  });
});

describe("RoomTable bed-type icon (#1675)", () => {
  function renderRoom(room: DashboardRoom) {
    return render(
      <RoomTable
        room={room}
        nights={["2026-07-01"]}
        allocationByBedAndDate={new Map()}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
      />,
    );
  }

  it("shows an accessible bed-type label alongside the bed name (never icon-only)", () => {
    renderRoom(buildRoom());
    // The single bed's icon carries a screen-reader label + tooltip.
    expect(screen.getByText("Single bed")).toBeTruthy();
    expect(screen.getByText("Bed One")).toBeTruthy();
  });

  it("labels a paired bunk with its group and top/bottom position", () => {
    const room: DashboardRoom = {
      ...buildRoom(),
      beds: [
        {
          id: "bed-top",
          roomId: "room-1",
          name: "Top",
          sortOrder: 1,
          active: true,
          bedType: "BUNK_TOP",
          bunkGroup: "Bunk A",
        },
        {
          id: "bed-bottom",
          roomId: "room-1",
          name: "Bottom",
          sortOrder: 2,
          active: true,
          bedType: "BUNK_BOTTOM",
          bunkGroup: "Bunk A",
        },
      ],
    };
    renderRoom(room);
    expect(screen.getByText("Bunk A · top")).toBeTruthy();
    expect(screen.getByText("Bunk A · bottom")).toBeTruthy();
  });

  it("does not imply a partner for a half-pair whose group holds only one bed", () => {
    // A surviving bunk-top whose bottom was deleted must not read as "Bunk A ·
    // top" (that implies a partner). It falls back to the plain type label.
    const room: DashboardRoom = {
      ...buildRoom(),
      beds: [
        {
          id: "bed-top",
          roomId: "room-1",
          name: "Top",
          sortOrder: 1,
          active: true,
          bedType: "BUNK_TOP",
          bunkGroup: "Bunk A",
        },
      ],
    };
    renderRoom(room);
    expect(screen.queryByText("Bunk A · top")).toBeNull();
    expect(screen.getByText("Bunk (top)")).toBeTruthy();
  });
});
