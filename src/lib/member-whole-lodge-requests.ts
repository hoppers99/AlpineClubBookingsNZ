/**
 * "My requests" — the member-facing view of their own whole-lodge booking
 * requests (#2263, D3).
 *
 * This module is the ONE place a `BookingRequest` row is reduced to something a
 * member may see, and it exists as a separate module (rather than a mapper
 * buried in the page) so the reduction is testable in isolation and cannot drift
 * per-surface.
 *
 * Two rules it enforces, both privacy rules rather than presentation ones:
 *
 *  1. STRICT ALLOWLIST. The DTO names every field it carries. It never spreads a
 *     request row, so a column added to `BookingRequest` tomorrow cannot arrive
 *     on a member's screen by accident. `declineReason`, `responseMessage`,
 *     conflict data, hold state, admin identities, prices and internal ids are
 *     all absent by construction.
 *
 *  2. VALUE-LEVEL STATUS MAPPING. The member sees exactly one of four words. The
 *     raw pipeline statuses — `PRICED`, `QUOTED`, `QUOTE_SENT`,
 *     `QUERY_PENDING`, `MODIFICATION_REQUESTED` — are an ADMIN-ACTIVITY ORACLE:
 *     "an officer has started pricing your dates" is information about what the
 *     club is doing behind the queue, and on a whole-lodge request it edges
 *     toward information about the calendar. The mapping is exhaustive over the
 *     enum (the `never` check below fails the build if a status is added and not
 *     classified), so a new status cannot default into visibility.
 */
import { BookingRequestStatus } from "@prisma/client";

/** The four words a member may see. Nothing else is ever rendered. */
export type MyWholeLodgeRequestStatus =
  | "pending"
  | "approved"
  | "declined"
  | "withdrawn";

export type MyWholeLodgeRequestItem = {
  id: string;
  /** YYYY-MM-DD (NZ date-only lodge nights). */
  checkIn: string;
  checkOut: string;
  /** The approximate headcount the member themselves submitted. */
  headcount: number;
  status: MyWholeLodgeRequestStatus;
  /** ISO timestamp of submission, for ordering and the "sent on" line. */
  createdAt: string;
  /**
   * The approved booking, when there is one — the member's link through to the
   * real thing. Null on every other status.
   */
  bookingId: string | null;
  /** Whether the withdraw affordance is offered for this row. */
  canWithdraw: boolean;
};

/**
 * Map an internal status onto the member-visible one. Exhaustive: the `never`
 * assignment at the end is a compile-time proof that every enum member is
 * classified.
 */
export function toMyWholeLodgeRequestStatus(
  status: BookingRequestStatus
): MyWholeLodgeRequestStatus {
  switch (status) {
    // Still with the booking officer. Every intermediate pipeline state
    // collapses to the same word: a member learns that a decision has not been
    // made, and nothing about how far along it is.
    case BookingRequestStatus.NEW:
    case BookingRequestStatus.VERIFIED:
    case BookingRequestStatus.PRICED:
    case BookingRequestStatus.QUOTED:
    case BookingRequestStatus.QUOTE_SENT:
    case BookingRequestStatus.QUERY_PENDING:
    case BookingRequestStatus.MODIFICATION_REQUESTED:
      return "pending";
    // APPROVED is the moment before the booking row commits; CONVERTED is after.
    // Both read as "approved" — the member is not shown the seam.
    case BookingRequestStatus.APPROVED:
    case BookingRequestStatus.CONVERTED:
      return "approved";
    case BookingRequestStatus.DECLINED:
      return "declined";
    // The member's own withdrawal.
    case BookingRequestStatus.CANCELLED:
      return "withdrawn";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * Reduce a request row to the member DTO. The input type is deliberately a
 * narrow structural shape, not `BookingRequest`: a caller cannot satisfy it by
 * handing over the whole row and hoping the mapper is careful.
 */
export function toMyWholeLodgeRequestItem(request: {
  id: string;
  status: BookingRequestStatus;
  checkIn: Date;
  checkOut: Date;
  createdAt: Date;
  convertedBookingId: string | null;
  heldBookingId: string | null;
  guestCount: number;
}): MyWholeLodgeRequestItem {
  const status = toMyWholeLodgeRequestStatus(request.status);
  return {
    id: request.id,
    checkIn: toDateOnly(request.checkIn),
    checkOut: toDateOnly(request.checkOut),
    headcount: request.guestCount,
    status,
    createdAt: request.createdAt.toISOString(),
    // Only an actually-converted request has a booking to open. An APPROVED row
    // whose conversion has not committed reads as approved with no link yet.
    bookingId: status === "approved" ? request.convertedBookingId : null,
    // Mirrors the service guard exactly (booking-request.ts): pending, and not
    // holding capacity. Offering a button the API would refuse is worse than
    // offering none.
    canWithdraw: status === "pending" && request.heldBookingId === null,
  };
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
