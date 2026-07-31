import type { BedOption, DashboardAllocation, DashboardPayload } from "./types";

export interface AllocationMoveTarget {
  bedId: string;
  stayDate: string;
}

export type AllocationMovePlan =
  | { type: "noop" }
  | {
      type: "single";
      allocationId: string;
      stayDates: [string];
    }
  | {
      type: "bulk";
      allocationIds: string[];
      bookingGuestId: string;
      stayDates: string[];
    };

export function planAllocationMove(input: {
  allocation: DashboardAllocation;
  target: AllocationMoveTarget;
  visibleAllocations: DashboardAllocation[];
  visibleNights: string[];
}): AllocationMovePlan {
  const { allocation, target, visibleAllocations, visibleNights } = input;

  if (!visibleNights.includes(target.stayDate)) {
    return { type: "noop" };
  }

  const guestAllocations = visibleAllocations
    .filter((item) => item.bookingGuestId === allocation.bookingGuestId)
    .sort(
      (a, b) =>
        a.stayDate.localeCompare(b.stayDate) || a.id.localeCompare(b.id),
    );

  const firstAllocation = guestAllocations[0];
  const isFirstVisibleAllocation = firstAllocation?.id === allocation.id;
  const selectedAllocations = isFirstVisibleAllocation
    ? guestAllocations
    : [allocation];

  // Existing allocation drags choose a BED only. The hovered column is
  // deliberately ignored and every selected row stays on its persisted lodge
  // night (#2366). A first-visible chip is a proxy for ALL visible rows, which
  // may currently span several beds: dropping it on the dragged row's own bed
  // is still a real move when any later selected row uses another bed. It is a
  // no-op only when every selected row already uses the destination.
  if (selectedAllocations.every((item) => item.bedId === target.bedId)) {
    return { type: "noop" };
  }

  if (!isFirstVisibleAllocation) {
    return {
      type: "single",
      allocationId: allocation.id,
      stayDates: [allocation.stayDate],
    };
  }

  if (selectedAllocations.length <= 1) {
    return {
      type: "single",
      allocationId: allocation.id,
      stayDates: [allocation.stayDate],
    };
  }

  return {
    type: "bulk",
    allocationIds: selectedAllocations.map((item) => item.id),
    bookingGuestId: allocation.bookingGuestId,
    stayDates: selectedAllocations.map((item) => item.stayDate),
  };
}

export function applyOptimisticAllocationBedMove(input: {
  payload: DashboardPayload;
  allocationIds: string[];
  bed: BedOption;
}): DashboardPayload {
  const allocationIdSet = new Set(input.allocationIds);

  return {
    ...input.payload,
    allocations: input.payload.allocations.map((allocation) =>
      allocationIdSet.has(allocation.id)
        ? {
            ...allocation,
            bedId: input.bed.id,
            bedName: input.bed.bedName,
            roomId: input.bed.roomId,
            roomName: input.bed.roomName,
            source: "MANUAL",
            approvedAt: null,
            approvedByName: null,
          }
        : allocation,
    ),
  };
}
