import type { Announcements } from "@dnd-kit/core";
import { deriveActiveDragDates } from "./active-drag-dates";
import type {
  BedOption,
  BucketGuestGroup,
  DashboardAllocation,
  DragData,
  DropData,
} from "./types";

export const BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS = {
  draggable:
    "To pick up a guest, press space or enter. Use the arrow keys to choose a destination bed, then press space or enter to drop. Existing allocations keep their original lodge night even when you move across date columns. Press escape to cancel without making a change.",
};

function formatNightList(stayDates: string[]) {
  return stayDates.length === 1
    ? `original lodge night ${stayDates[0]}`
    : `original lodge nights ${stayDates.join(", ")}`;
}

export function describeBedAllocationDrop(input: {
  activeData: DragData | undefined;
  overData: DropData | undefined;
  visibleAllocations: DashboardAllocation[];
  bucketGroups: BucketGuestGroup[];
  beds: BedOption[];
  singleNightMode: boolean;
}): string | null {
  const {
    activeData,
    overData,
    visibleAllocations,
    bucketGroups,
    beds,
    singleNightMode,
  } = input;
  if (!activeData || !overData) return null;

  if (overData.type === "bucket") {
    if (activeData.type !== "allocation") return null;
    const allocation = visibleAllocations.find(
      (item) => item.id === activeData.allocationId,
    );
    return allocation
      ? `Remove ${allocation.guestName} from ${formatNightList(
          deriveActiveDragDates({
            activeDrag: activeData,
            visibleAllocations,
            bucketGroups,
          }),
        )}`
      : null;
  }

  const bed = beds.find((item) => item.id === overData.bedId);
  if (!bed) return null;

  if (activeData.type === "bucket-guest") {
    const group = bucketGroups.find(
      (item) => item.bookingGuestId === activeData.bookingGuestId,
    );
    if (!group) return null;
    return singleNightMode
      ? `${group.guestName} to ${bed.label} for booked lodge night ${overData.stayDate}`
      : `${group.guestName} to ${bed.label} for all booked lodge nights`;
  }

  const allocation = visibleAllocations.find(
    (item) => item.id === activeData.allocationId,
  );
  if (!allocation) return null;
  const originalDates = deriveActiveDragDates({
    activeDrag: activeData,
    visibleAllocations,
    bucketGroups,
  });
  return `${allocation.guestName} to ${bed.label}, snapped to ${formatNightList(
    originalDates,
  )}`;
}

export function createBedAllocationAnnouncements(input: {
  visibleAllocations: DashboardAllocation[];
  bucketGroups: BucketGuestGroup[];
  beds: BedOption[];
  singleNightMode: boolean;
}): Announcements {
  const describe = (activeData: DragData | undefined, overData?: DropData) =>
    describeBedAllocationDrop({
      ...input,
      activeData,
      overData,
    });

  return {
    onDragStart({ active }) {
      const activeData = active.data.current as DragData | undefined;
      if (activeData?.type === "allocation") {
        const allocation = input.visibleAllocations.find(
          (item) => item.id === activeData.allocationId,
        );
        return allocation
          ? `Picked up ${allocation.guestName}. Choose a destination bed; ${formatNightList(
              deriveActiveDragDates({
                activeDrag: activeData,
                visibleAllocations: input.visibleAllocations,
                bucketGroups: input.bucketGroups,
              }),
            )} will be kept.`
          : undefined;
      }
      const group = input.bucketGroups.find(
        (item) =>
          activeData?.type === "bucket-guest" &&
          item.bookingGuestId === activeData.bookingGuestId,
      );
      return group ? `Picked up ${group.guestName}.` : undefined;
    },
    onDragOver({ active, over }) {
      return (
        describe(
          active.data.current as DragData | undefined,
          over?.data.current as DropData | undefined,
        ) ?? undefined
      );
    },
    onDragEnd({ active, over }) {
      const preview = describe(
        active.data.current as DragData | undefined,
        over?.data.current as DropData | undefined,
      );
      return preview ? `Dropped ${preview}.` : "Drag ended with no change.";
    },
    onDragCancel({ active }) {
      const activeData = active.data.current as DragData | undefined;
      const allocation =
        activeData?.type === "allocation"
          ? input.visibleAllocations.find(
              (item) => item.id === activeData.allocationId,
            )
          : undefined;
      const group =
        activeData?.type === "bucket-guest"
          ? input.bucketGroups.find(
              (item) => item.bookingGuestId === activeData.bookingGuestId,
            )
          : undefined;
      return `Cancelled ${allocation?.guestName ?? group?.guestName ?? "guest"} drag. No allocation changed.`;
    },
  };
}
