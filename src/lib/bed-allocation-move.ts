export const BED_ALLOCATION_MOVE_DIGEST_VERSION = "v1" as const;
export const MAX_BED_ALLOCATION_PERSON_MOVE_NIGHTS = 366;

export const BED_ALLOCATION_MOVE_SCOPES = [
  "ALLOCATION_NIGHT",
  "BOOKING_GUEST",
] as const;

export type BedAllocationMoveScope =
  (typeof BED_ALLOCATION_MOVE_SCOPES)[number];

export interface BedAllocationMoveRequest {
  anchorAllocationId: string;
  destinationBedId: string;
  scope: BedAllocationMoveScope;
}

export interface BedAllocationMoveApplyRequest
  extends BedAllocationMoveRequest {
  previewDigest: string;
}

export interface BedAllocationMoveDetail {
  allocationId: string;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  stayDate: string;
  source: "AUTO" | "MANUAL";
  approved: boolean;
  sourceLodgeId: string;
  sourceRoomId: string;
  sourceRoomName: string;
  sourceBedId: string;
  sourceBedName: string;
}

export interface BedAllocationMovePromotionPreview {
  allocationId: string;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  stayDate: string;
  bedId: string;
  bedName: string;
}

export type BedAllocationMoveConflictCode =
  | "DESTINATION_UNAVAILABLE"
  | "LODGE_MISMATCH"
  | "BOOKING_NOT_ALLOCATABLE"
  | "GUEST_NOT_STAYING"
  | "GUEST_NOT_PRESENT"
  | "BED_TAKEN"
  | "SHARED_DOUBLE_INELIGIBLE"
  | "ADULT_MINOR_MIX"
  | "CUSTODIAN_HOLD"
  | "WHOLE_LODGE_HOLD";

export interface BedAllocationMoveConflict {
  allocationId: string;
  stayDate: string;
  code: BedAllocationMoveConflictCode;
  message: string;
}

export interface BedAllocationMovePreview {
  digestVersion: typeof BED_ALLOCATION_MOVE_DIGEST_VERSION;
  digest: string;
  scope: BedAllocationMoveScope;
  anchor: {
    allocationId: string;
    bookingId: string;
    bookingGuestId: string;
    guestName: string;
    stayDate: string;
  };
  destination: {
    bedId: string;
    bedName: string | null;
    roomId: string | null;
    roomName: string | null;
    lodgeId: string | null;
    label: string;
    available: boolean;
  };
  resolvedRowCount: number;
  changedRowCount: number;
  unchangedRowCount: number;
  approvedToDraftCount: number;
  changed: BedAllocationMoveDetail[];
  unchanged: BedAllocationMoveDetail[];
  promotions: BedAllocationMovePromotionPreview[];
  conflicts: BedAllocationMoveConflict[];
}

export interface BedAllocationMoveApplyResult {
  noop: boolean;
  movedRowCount: number;
  promotedRowCount: number;
  affectedNights: string[];
}

export type BedAllocationMoveErrorCode =
  | "STALE_PREVIEW"
  | "MOVE_CONFLICT"
  | "INVALID_MOVE";

export class BedAllocationMoveError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code: BedAllocationMoveErrorCode = "INVALID_MOVE",
    public readonly refreshedPreview?: BedAllocationMovePreview,
  ) {
    super(message);
    this.name = "BedAllocationMoveError";
  }
}
