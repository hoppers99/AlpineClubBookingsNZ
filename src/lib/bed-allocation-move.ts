import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { isAdultAgeTier } from "@/lib/bed-allocation";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import {
  findCustodianBedHolds,
  holdCoversNight,
} from "@/lib/custodian-occupancy";
import {
  isBlockingWholeLodgeHold,
  wholeLodgeHoldCoversNight,
} from "@/lib/exclusive-hold-occupancy";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import { acquireMemberPartnerLinkLocks } from "@/lib/member-partner-lock";
import {
  canonicalPartnerPair,
  PARTNER_LINK_CONFIRMED,
} from "@/lib/member-partner-link-shared";
import { prisma } from "@/lib/prisma";

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
  stayDate: string;
  source: "AUTO" | "MANUAL";
  approved: boolean;
  sourceRoomName: string;
  sourceBedName: string;
}

export interface BedAllocationMovePromotionPreview {
  stayDate: string;
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
  stayDate: string | null;
  code: BedAllocationMoveConflictCode;
  message: string;
}

export interface BedAllocationMovePreview {
  digestVersion: typeof BED_ALLOCATION_MOVE_DIGEST_VERSION;
  digest: string;
  scope: BedAllocationMoveScope;
  anchor: {
    allocationId: string;
    guestName: string | null;
    stayDate: string | null;
  };
  destination: {
    bedId: string;
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

const MAX_AUDIT_IDENTITIES = 50;

const bookingFactsSelect = {
  id: true,
  status: true,
  deletedAt: true,
  lodgeId: true,
  wholeLodgeHold: true,
  checkIn: true,
  checkOut: true,
  adminCapacityHoldAt: true,
  updatedAt: true,
  originBookingRequest: { select: { id: true } },
} satisfies Prisma.BookingSelect;

const moveAllocationInclude = Prisma.validator<Prisma.BedAllocationInclude>()({
  booking: { select: bookingFactsSelect },
  bookingGuest: {
    include: {
      booking: { select: bookingFactsSelect },
      member: {
        select: { id: true, active: true, ageTier: true, updatedAt: true },
      },
      nights: { select: { id: true, stayDate: true, priceCents: true } },
    },
  },
  room: {
    select: {
      id: true,
      name: true,
      active: true,
      lodgeId: true,
      updatedAt: true,
    },
  },
  bed: {
    select: {
      id: true,
      roomId: true,
      name: true,
      active: true,
      bedType: true,
      updatedAt: true,
    },
  },
});

const destinationInclude = Prisma.validator<Prisma.LodgeBedInclude>()({
  room: {
    select: {
      id: true,
      name: true,
      active: true,
      lodgeId: true,
      updatedAt: true,
    },
  },
});

type MoveAllocationRow = Prisma.BedAllocationGetPayload<{
  include: typeof moveAllocationInclude;
}>;
type MoveDestination = Prisma.LodgeBedGetPayload<{
  include: typeof destinationInclude;
}>;
type MoveDb = Pick<
  typeof prisma,
  | "bedAllocation"
  | "booking"
  | "bookingGuest"
  | "hutLeaderAssignment"
  | "lodgeBed"
  | "lodgeRoom"
  | "member"
  | "memberPartnerLink"
>;

interface MoveBaseState {
  anchor: MoveAllocationRow;
  destination: MoveDestination;
  selectedRows: MoveAllocationRow[];
  changedRows: MoveAllocationRow[];
  lodgeIds: string[];
}

interface MoveMemberFact {
  id: string;
  active: boolean;
  ageTier: string;
  updatedAt: Date;
}

interface MovePartnerFact {
  id: string;
  memberAId: string;
  memberBId: string;
  status: string;
  updatedAt: Date;
}

interface MoveWholeHoldFact {
  id: string;
  status: string;
  checkIn: Date;
  checkOut: Date;
  lodgeId: string;
  wholeLodgeHold: boolean;
  adminCapacityHoldAt: Date | null;
  updatedAt: Date;
  originBookingRequest: { id: string } | null;
}

interface MoveState extends MoveBaseState {
  relatedRows: MoveAllocationRow[];
  members: MoveMemberFact[];
  partnerLinks: MovePartnerFact[];
  memberIds: string[];
  custodianHolds: Awaited<ReturnType<typeof findCustodianBedHolds>>;
  wholeLodgeHolds: MoveWholeHoldFact[];
  targetSecondByAllocationId: Map<string, boolean>;
  promotionRows: MoveAllocationRow[];
  preview: BedAllocationMovePreview;
}

function personName(person: { firstName: string; lastName: string }) {
  return `${person.firstName} ${person.lastName}`.trim();
}

function destinationLabel(destination: MoveDestination) {
  return `${destination.room.name} / ${destination.name}`;
}

function assertMoveScope(scope: BedAllocationMoveScope) {
  if (!BED_ALLOCATION_MOVE_SCOPES.includes(scope)) {
    throw new BedAllocationMoveError("Invalid allocation move scope", 400);
  }
}

function assertMoveIdentity(
  anchor: MoveAllocationRow,
  rows: readonly MoveAllocationRow[],
) {
  const guestBookingId = anchor.bookingGuest.bookingId;
  if (
    anchor.bookingId !== guestBookingId ||
    anchor.booking.id !== anchor.bookingId ||
    anchor.bookingGuest.booking.id !== guestBookingId
  ) {
    throw new BedAllocationMoveError(
      "The allocation no longer belongs to a consistent booking and guest.",
      409,
    );
  }
  for (const row of rows) {
    if (
      row.bookingGuestId !== anchor.bookingGuestId ||
      row.bookingId !== guestBookingId ||
      row.booking.id !== row.bookingId ||
      row.bookingGuest.bookingId !== guestBookingId ||
      row.bookingGuest.booking.id !== guestBookingId ||
      row.roomId !== row.room.id ||
      row.bedId !== row.bed.id ||
      row.bed.roomId !== row.roomId
    ) {
      throw new BedAllocationMoveError(
        "The selected allocation rows no longer share one consistent booking and guest.",
        409,
      );
    }
  }
}

async function loadMoveBase(
  request: BedAllocationMoveRequest,
  db: MoveDb,
): Promise<MoveBaseState> {
  assertMoveScope(request.scope);
  const [anchor, destination] = await Promise.all([
    db.bedAllocation.findUnique({
      where: { id: request.anchorAllocationId },
      include: moveAllocationInclude,
    }),
    db.lodgeBed.findUnique({
      where: { id: request.destinationBedId },
      include: destinationInclude,
    }),
  ]);
  if (!anchor) {
    throw new BedAllocationMoveError("Allocation not found", 404);
  }
  if (!destination) {
    throw new BedAllocationMoveError("Destination bed not found", 404);
  }

  const selectedRows =
    request.scope === "ALLOCATION_NIGHT"
      ? [anchor]
      : await db.bedAllocation.findMany({
          where: { bookingGuestId: anchor.bookingGuestId },
          include: moveAllocationInclude,
          orderBy: [{ stayDate: "asc" }, { id: "asc" }],
        });
  if (selectedRows.length > MAX_BED_ALLOCATION_PERSON_MOVE_NIGHTS) {
    throw new BedAllocationMoveError(
      `Cannot move more than ${MAX_BED_ALLOCATION_PERSON_MOVE_NIGHTS} existing allocation nights for one person`,
      400,
    );
  }
  assertMoveIdentity(anchor, selectedRows);

  const guestBookingLodgeId = anchor.bookingGuest.booking.lodgeId;
  if (destination.room.lodgeId !== guestBookingLodgeId) {
    throw new BedAllocationMoveError(
      "Destination bed belongs to a different lodge than the booking",
      409,
    );
  }

  const lodgeIds = [
    ...new Set([
      destination.room.lodgeId,
      anchor.booking.lodgeId,
      anchor.bookingGuest.booking.lodgeId,
      ...selectedRows.flatMap((row) => [
        row.room.lodgeId,
        row.booking.lodgeId,
        row.bookingGuest.booking.lodgeId,
      ]),
    ]),
  ].sort();

  return {
    anchor,
    destination,
    selectedRows,
    changedRows: selectedRows.filter(
      (row) => row.bedId !== request.destinationBedId,
    ),
    lodgeIds,
  };
}

function guestStaysOn(row: MoveAllocationRow, stayDate: Date) {
  const guest = row.bookingGuest;
  if (guest.nights.length > 0) {
    const wanted = formatDateOnly(stayDate);
    return guest.nights.some(
      (night) => formatDateOnly(night.stayDate) === wanted,
    );
  }
  return guest.stayStart <= stayDate && stayDate < guest.stayEnd;
}

function holdingBooking(booking: MoveAllocationRow["booking"]) {
  return bookingHoldsCapacity({
    status: booking.status,
    isRequestConverted: Boolean(booking.originBookingRequest),
    hasAdminCapacityHold: Boolean(booking.adminCapacityHoldAt),
  });
}

function rowDetail(row: MoveAllocationRow): BedAllocationMoveDetail {
  return {
    allocationId: row.id,
    stayDate: formatDateOnly(row.stayDate),
    source: row.source,
    approved: Boolean(row.approvedAt),
    sourceRoomName: row.room.name,
    sourceBedName: row.bed.name,
  };
}
