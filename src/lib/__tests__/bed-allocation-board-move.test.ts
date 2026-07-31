import { describe, expect, it } from "vitest";
import {
  applyOptimisticAllocationBedMove,
  planAllocationMove,
} from "@/app/(admin)/admin/bed-allocation/_components/allocation-move";
import {
  BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS,
  createBedAllocationAnnouncements,
  describeBedAllocationDrop,
} from "@/app/(admin)/admin/bed-allocation/_components/allocation-drag-feedback";
import { deriveActiveDragDates } from "@/app/(admin)/admin/bed-allocation/_components/active-drag-dates";
import type {
  BedOption,
  BucketGuestGroup,
  DashboardAllocation,
  DashboardPayload,
} from "@/app/(admin)/admin/bed-allocation/_components/types";

function buildAllocation(
  overrides: Partial<DashboardAllocation> = {},
): DashboardAllocation {
  return {
    id: "allocation-1",
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    guestName: "Example Guest",
    guestAgeTier: "ADULT",
    roomId: "room-1",
    roomName: "Room One",
    bedId: "bed-1",
    bedName: "Bed One",
    stayDate: "2026-07-01",
    source: "AUTO",
    approvedAt: "2026-06-01T00:00:00.000Z",
    approvedByName: "Allocator",
    bookingStatus: "CONFIRMED",
    holdsCapacity: true,
    isSecondOccupant: false,
    ...overrides,
  };
}

describe("planAllocationMove", () => {
  it("moves every visible allocation for the guest when the first night moves to another bed", () => {
    const allocations = [
      buildAllocation({
        id: "allocation-2",
        stayDate: "2026-07-02",
        bedId: "bed-1",
      }),
      buildAllocation({
        id: "allocation-1",
        stayDate: "2026-07-01",
        bedId: "bed-1",
      }),
      buildAllocation({
        id: "allocation-other",
        bookingGuestId: "guest-2",
        stayDate: "2026-07-01",
        bedId: "bed-3",
      }),
    ];

    expect(
      planAllocationMove({
        allocation: allocations[1],
        target: { bedId: "bed-2", stayDate: "2026-07-01" },
        visibleAllocations: allocations,
        visibleNights: ["2026-07-01", "2026-07-02"],
      }),
    ).toEqual({
      type: "bulk",
      allocationIds: ["allocation-1", "allocation-2"],
      bookingGuestId: "guest-1",
      stayDates: ["2026-07-01", "2026-07-02"],
    });
  });

  it("snaps a later chip to its own original night even across date columns", () => {
    const first = buildAllocation({
      id: "allocation-1",
      stayDate: "2026-07-01",
    });
    const second = buildAllocation({
      id: "allocation-2",
      stayDate: "2026-07-02",
    });

    expect(
      planAllocationMove({
        allocation: second,
        target: { bedId: "bed-2", stayDate: "2026-07-03" },
        visibleAllocations: [first, second],
        visibleNights: ["2026-07-01", "2026-07-02", "2026-07-03"],
      }),
    ).toEqual({
      type: "single",
      allocationId: "allocation-2",
      stayDates: ["2026-07-02"],
    });
  });

  it("uses a first visible chip as a proxy for the same original visible nights across columns", () => {
    const first = buildAllocation({
      id: "allocation-1",
      stayDate: "2026-07-01",
    });
    const second = buildAllocation({
      id: "allocation-2",
      stayDate: "2026-07-02",
    });

    expect(
      planAllocationMove({
        allocation: first,
        target: { bedId: "bed-2", stayDate: "2026-07-02" },
        visibleAllocations: [first, second],
        visibleNights: ["2026-07-01", "2026-07-02"],
      }),
    ).toEqual({
      type: "bulk",
      allocationIds: ["allocation-1", "allocation-2"],
      bookingGuestId: "guest-1",
      stayDates: ["2026-07-01", "2026-07-02"],
    });
  });

  it("normalises every same-bed target to a no-op regardless of hovered column", () => {
    const allocation = buildAllocation({
      bedId: "bed-1",
      stayDate: "2026-07-01",
    });

    expect(
      planAllocationMove({
        allocation,
        target: { bedId: "bed-1", stayDate: "2026-07-03" },
        visibleAllocations: [allocation],
        visibleNights: ["2026-07-01", "2026-07-02", "2026-07-03"],
      }),
    ).toEqual({ type: "noop" });
  });
});

describe("deriveActiveDragDates", () => {
  it("highlights every visible guest night for a first visible allocation drag", () => {
    const allocations = [
      buildAllocation({
        id: "allocation-2",
        stayDate: "2026-07-02",
      }),
      buildAllocation({
        id: "allocation-1",
        stayDate: "2026-07-01",
      }),
      buildAllocation({
        id: "allocation-other",
        bookingGuestId: "guest-2",
        stayDate: "2026-07-01",
      }),
    ];

    expect(
      deriveActiveDragDates({
        activeDrag: { type: "allocation", allocationId: "allocation-1" },
        visibleAllocations: allocations,
        bucketGroups: [],
      }),
    ).toEqual(["2026-07-01", "2026-07-02"]);
  });

  it("highlights only the dragged night for a later allocation drag", () => {
    const allocations = [
      buildAllocation({
        id: "allocation-1",
        stayDate: "2026-07-01",
      }),
      buildAllocation({
        id: "allocation-2",
        stayDate: "2026-07-02",
      }),
    ];

    expect(
      deriveActiveDragDates({
        activeDrag: { type: "allocation", allocationId: "allocation-2" },
        visibleAllocations: allocations,
        bucketGroups: [],
      }),
    ).toEqual(["2026-07-02"]);
  });

  it("highlights the bucket guest's relevant nights", () => {
    const bucketGroups: BucketGuestGroup[] = [
      {
        bookingGuestId: "guest-1",
        bookingId: "booking-1",
        guestName: "Example Guest",
        guestAgeTier: "ADULT",
        memberName: "Example Member",
        stayDates: ["2026-07-03", "2026-07-01", "2026-07-02"],
      },
    ];

    expect(
      deriveActiveDragDates({
        activeDrag: { type: "bucket-guest", bookingGuestId: "guest-1" },
        visibleAllocations: [],
        bucketGroups,
      }),
    ).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
  });
});

describe("applyOptimisticAllocationBedMove", () => {
  it("moves only affected allocations to the target bed and clears approval state", () => {
    const affectedFirst = buildAllocation({
      id: "allocation-1",
      stayDate: "2026-07-01",
      approvedAt: "2026-06-01T00:00:00.000Z",
      approvedByName: "Allocator",
      source: "AUTO",
    });
    const affectedSecond = buildAllocation({
      id: "allocation-2",
      stayDate: "2026-07-02",
      approvedAt: "2026-06-01T00:00:00.000Z",
      approvedByName: "Allocator",
      source: "AUTO",
    });
    const unaffected = buildAllocation({
      id: "allocation-3",
      bookingGuestId: "guest-2",
      stayDate: "2026-07-01",
      bedId: "bed-3",
      bedName: "Bed Three",
    });
    const bed: BedOption = {
      id: "bed-2",
      roomId: "room-2",
      roomName: "Room Two",
      bedName: "Bed Two",
      label: "Room Two / Bed Two",
    };
    const payload: DashboardPayload = {
      settings: {
        autoAllocationEnabled: true,
        updatedAt: null,
        updatedByMemberId: null,
      },
      range: { fromDate: "2026-07-01", toDate: "2026-07-03" },
      rooms: [],
      bookings: [],
      allocations: [affectedFirst, affectedSecond, unaffected],
      unallocatedGuestNights: [],
      exclusiveHolds: [],
      // #2286: no custodian holds in this fixture.
      custodianHolds: [],
      suggestedAllocations: [],
      suggestedUnallocatedGuestNights: [],
      warnings: [],
      focusedBooking: null,
    };

    const result = applyOptimisticAllocationBedMove({
      payload,
      allocationIds: ["allocation-1", "allocation-2"],
      bed,
    });

    expect(result.allocations).toEqual([
      expect.objectContaining({
        id: "allocation-1",
        bedId: "bed-2",
        bedName: "Bed Two",
        roomId: "room-2",
        roomName: "Room Two",
        source: "MANUAL",
        approvedAt: null,
        approvedByName: null,
        stayDate: "2026-07-01",
      }),
      expect.objectContaining({
        id: "allocation-2",
        bedId: "bed-2",
        bedName: "Bed Two",
        roomId: "room-2",
        roomName: "Room Two",
        source: "MANUAL",
        approvedAt: null,
        approvedByName: null,
        stayDate: "2026-07-02",
      }),
      unaffected,
    ]);
  });
});

describe("allocation drag feedback (#2366)", () => {
  const beds: BedOption[] = [
    {
      id: "bed-2",
      roomId: "room-2",
      roomName: "Room Two",
      bedName: "Bed Two",
      label: "Room Two / Bed Two",
    },
  ];

  it("shows pointer drag-over destination bed and snapped original dates", () => {
    const allocations = [
      buildAllocation({ id: "allocation-1", stayDate: "2026-07-01" }),
      buildAllocation({ id: "allocation-2", stayDate: "2026-07-02" }),
    ];

    expect(
      describeBedAllocationDrop({
        activeData: { type: "allocation", allocationId: "allocation-1" },
        overData: {
          type: "cell",
          bedId: "bed-2",
          roomId: "room-2",
          // Pointer is horizontally over a different date. Feedback must name
          // persisted source dates, not this hovered date.
          stayDate: "2026-07-09",
        },
        visibleAllocations: allocations,
        bucketGroups: [],
        beds,
        singleNightMode: false,
      }),
    ).toBe(
      "Example Guest to Room Two / Bed Two, snapped to original lodge nights 2026-07-01, 2026-07-02",
    );
  });

  it("announces the destination and snapped night for keyboard drag-over", () => {
    const allocation = buildAllocation({
      id: "allocation-2",
      stayDate: "2026-07-02",
    });
    const announcements = createBedAllocationAnnouncements({
      visibleAllocations: [allocation],
      bucketGroups: [],
      beds,
      singleNightMode: false,
    });
    const active = {
      id: "allocation:allocation-2",
      data: {
        current: { type: "allocation", allocationId: "allocation-2" },
      },
    };
    const over = {
      id: "cell:bed-2:2026-07-09",
      data: {
        current: {
          type: "cell",
          bedId: "bed-2",
          roomId: "room-2",
          stayDate: "2026-07-09",
        },
      },
    };

    expect(
      announcements.onDragOver({
        active,
        over,
      } as unknown as Parameters<typeof announcements.onDragOver>[0]),
    ).toBe(
      "Example Guest to Room Two / Bed Two, snapped to original lodge night 2026-07-02",
    );
  });

  it("announces cancellation as no change and never instructs a date move", () => {
    const allocation = buildAllocation();
    const announcements = createBedAllocationAnnouncements({
      visibleAllocations: [allocation],
      bucketGroups: [],
      beds,
      singleNightMode: false,
    });
    const active = {
      id: "allocation:allocation-1",
      data: {
        current: { type: "allocation", allocationId: "allocation-1" },
      },
    };

    expect(
      announcements.onDragCancel({
        active,
        over: null,
      } as unknown as Parameters<typeof announcements.onDragCancel>[0]),
    ).toBe("Cancelled Example Guest drag. No allocation changed.");
    expect(BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS.draggable).toContain(
      "keep their original lodge night",
    );
    expect(BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS.draggable).not.toContain(
      "another night",
    );
  });
});
