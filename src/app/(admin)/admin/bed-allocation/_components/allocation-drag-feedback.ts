import type { Announcements } from "@dnd-kit/core";
import { deriveActiveDragDates } from "./active-drag-dates";
import { planAllocationMove } from "./allocation-move";
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

type DropFeedback =
  | { outcome: "request"; description: string }
  | { outcome: "noop"; description: string }
  | { outcome: "refused"; description: string };

function planBedAllocationDropFeedback(input: {
  activeData: DragData | undefined;
  overData: DropData | undefined;
  visibleAllocations: DashboardAllocation[];
  bucketGroups: BucketGuestGroup[];
  beds: BedOption[];
  singleNightMode: boolean;
}): DropFeedback | null {
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
      ? {
          outcome: "request",
          // Bucket removal deletes only the dragged allocation id. A
          // first-visible chip is a proxy only for BED moves, never removal.
          description: `Remove ${allocation.guestName} from ${formatNightList([
            allocation.stayDate,
          ])}`,
        }
      : null;
  }

  const bed = beds.find((item) => item.id === overData.bedId);
  if (!bed) return null;

  if (activeData.type === "bucket-guest") {
    const group = bucketGroups.find(
      (item) => item.bookingGuestId === activeData.bookingGuestId,
    );
    if (!group) return null;
    if (singleNightMode && !group.stayDates.includes(overData.stayDate)) {
      return {
        outcome: "refused",
        description: `No allocation will be made for ${group.guestName}: ${overData.stayDate} is not a booked lodge night`,
      };
    }
    return {
      outcome: "request",
      description: singleNightMode
        ? `${group.guestName} to ${bed.label} for booked lodge night ${overData.stayDate}`
        : `${group.guestName} to ${bed.label} for all booked lodge nights`,
    };
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
  const movePlan = planAllocationMove({
    allocation,
    target: overData,
    visibleAllocations,
    // The drop target came from the rendered board. Include it explicitly so
    // the planner can apply its out-of-window guard without feedback inventing
    // a second, subtly different board-window contract.
    visibleNights: [
      ...new Set([
        overData.stayDate,
        ...visibleAllocations.map((item) => item.stayDate),
      ]),
    ],
  });
  if (movePlan.type === "noop") {
    return {
      outcome: "noop",
      description: `No change for ${allocation.guestName}; the selected allocation${originalDates.length === 1 ? "" : "s"} already ${originalDates.length === 1 ? "uses" : "use"} ${bed.label}`,
    };
  }
  return {
    outcome: "request",
    description: `${allocation.guestName} to ${bed.label}, snapped to ${formatNightList(
      originalDates,
    )}`,
  };
}

export function describeBedAllocationDrop(
  input: Parameters<typeof planBedAllocationDropFeedback>[0],
): string | null {
  return planBedAllocationDropFeedback(input)?.description ?? null;
}

export function createBedAllocationAnnouncements(input: {
  visibleAllocations: DashboardAllocation[];
  bucketGroups: BucketGuestGroup[];
  beds: BedOption[];
  singleNightMode: boolean;
}): Announcements {
  const planFeedback = (
    activeData: DragData | undefined,
    overData?: DropData,
  ) =>
    planBedAllocationDropFeedback({
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
        planFeedback(
          active.data.current as DragData | undefined,
          over?.data.current as DropData | undefined,
        )?.description ?? undefined
      );
    },
    onDragEnd({ active, over }) {
      const feedback = planFeedback(
        active.data.current as DragData | undefined,
        over?.data.current as DropData | undefined,
      );
      if (!feedback) {
        return "Drop refused. No allocation request was sent.";
      }
      if (feedback.outcome === "noop") {
        return `${feedback.description}. No request was sent.`;
      }
      if (feedback.outcome === "refused") {
        return `Drop refused. ${feedback.description}. No request was sent.`;
      }
      return `Requested ${feedback.description}. Saving; success or failure will be reported after the server responds.`;
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
