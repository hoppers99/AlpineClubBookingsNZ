import { BookingStatus } from "@prisma/client";
import { getTodayDateOnly, normalizeDateOnlyForTimeZone } from "@/lib/date-only";

/**
 * Booking statuses a linked guest may take themselves off (#2250).
 *
 * This is the single source of truth for the status half of the self-removal
 * rule. `removeBookingGuestInTransaction` (the authoritative gate in
 * `booking-guest-removal-service.ts`) imports it, and so does the advisory
 * `canSelfRemove` computed by `findBookingMemberNightConflicts` and the booking
 * detail page's affordance — so a member is never shown a control the removal
 * service would refuse, and never denied one it would allow.
 */
export const SELF_REMOVABLE_GUEST_BOOKING_STATUSES: ReadonlySet<string> =
  new Set<string>([
    BookingStatus.DRAFT,
    BookingStatus.PENDING,
    BookingStatus.PAYMENT_PENDING,
    BookingStatus.CONFIRMED,
    BookingStatus.PAID,
    BookingStatus.WAITLISTED,
    BookingStatus.WAITLIST_OFFERED,
    BookingStatus.AWAITING_REVIEW,
  ]);

/**
 * Why a linked guest may NOT take themselves off a booking. Ordered exactly as
 * `removeBookingGuestInTransaction` evaluates its gates, so the reason shown to
 * the member is the same one the server would have raised.
 */
export type GuestSelfRemovalBlocker =
  | "NOT_THEIR_OWN_GUEST"
  | "OWN_BOOKING"
  | "BOOKING_STATUS"
  | "STAY_NOT_FUTURE"
  | "LAST_GUEST";

export type GuestSelfRemovalEligibility = {
  canSelfRemove: boolean;
  blocker: GuestSelfRemovalBlocker | null;
};

/**
 * The self-removal rule, evaluated server-side and shared by every surface that
 * offers (or explains the absence of) the action.
 *
 * Deliberately NOT exhaustive: the removal service additionally refuses a
 * quote-priced booking (`assertBookingNotQuotePriced`) and a settled booking
 * whose refund/credit election a self-remover may not make on the owner's
 * behalf. Both need a database read the caller may not have and both return a
 * plain-English 400 the caller surfaces verbatim, so they stay server-only.
 */
export function evaluateGuestSelfRemoval({
  actorMemberId,
  guestMemberId,
  bookingOwnerMemberId,
  bookingStatus,
  bookingCheckIn,
  bookingGuestCount,
  today = getTodayDateOnly(),
}: {
  actorMemberId: string;
  /** `memberId` on the guest row being removed (null for a non-member guest). */
  guestMemberId: string | null;
  bookingOwnerMemberId: string;
  bookingStatus: string;
  bookingCheckIn: Date;
  bookingGuestCount: number;
  today?: Date;
}): GuestSelfRemovalEligibility {
  // Self-removal is the path for someone ELSE's booking. An owner (and an
  // admin) edits the guest list through the full booking edit flow instead.
  if (bookingOwnerMemberId === actorMemberId) {
    return { canSelfRemove: false, blocker: "OWN_BOOKING" };
  }
  if (!guestMemberId || guestMemberId !== actorMemberId) {
    return { canSelfRemove: false, blocker: "NOT_THEIR_OWN_GUEST" };
  }
  if (!SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(bookingStatus)) {
    return { canSelfRemove: false, blocker: "BOOKING_STATUS" };
  }
  if (normalizeDateOnlyForTimeZone(bookingCheckIn) <= today) {
    return { canSelfRemove: false, blocker: "STAY_NOT_FUTURE" };
  }
  if (bookingGuestCount <= 1) {
    return { canSelfRemove: false, blocker: "LAST_GUEST" };
  }
  return { canSelfRemove: true, blocker: null };
}

/**
 * Plain-English reason a linked guest cannot take themselves off the booking
 * they are looking at, written for the member rather than the operator.
 */
export function describeGuestSelfRemovalBlocker(
  blocker: GuestSelfRemovalBlocker,
): string {
  switch (blocker) {
    case "BOOKING_STATUS":
      return "This booking is no longer in a state you can take yourself off. Ask the person who made the booking, or the club, if you need to come off it.";
    case "STAY_NOT_FUTURE":
      return "This stay starts today or has already started, so you can no longer take yourself off it here. Ask the person who made the booking, or the club, if your plans have changed.";
    case "LAST_GUEST":
      return "You are the only person on this booking, so taking yourself off would leave it empty. Ask the person who made the booking, or the club, to cancel it instead.";
    case "OWN_BOOKING":
      return "This is your own booking — edit the guest list, or cancel it, from the booking details above.";
    case "NOT_THEIR_OWN_GUEST":
      return "Only the person named on a place can take themselves off a booking.";
  }
}

export type BookingSelfRemovalCard = {
  /** The viewer's own `BookingGuest` row on this booking. */
  guestId: string;
  canSelfRemove: boolean;
  blockedReason: string | null;
};

/**
 * Whether the booking detail page shows the self-removal card at all, and with
 * what — the page-level gate, extracted so it is testable rather than living
 * inline in a server component nobody can render in a unit test.
 *
 * Returns null (no card, not even an explanation) for anyone the action is not
 * FOR: the booking's own owner and a full admin both edit the guest list
 * through the booking edit flow instead, a viewer with no guest row on this
 * booking has no place to give up, and a soft-deleted booking is admin-only
 * archaeology. Everyone else gets the card, with the action itself driven by
 * the shared `evaluateGuestSelfRemoval` predicate.
 */
export function resolveBookingSelfRemovalCard({
  actorMemberId,
  isBookingOwner,
  isAdminViewer,
  bookingDeletedAt,
  bookingOwnerMemberId,
  bookingStatus,
  bookingCheckIn,
  guests,
  today,
}: {
  actorMemberId: string;
  isBookingOwner: boolean;
  /** A full admin, who manages the guest list through the admin tooling. */
  isAdminViewer: boolean;
  bookingDeletedAt: Date | null;
  bookingOwnerMemberId: string;
  bookingStatus: string;
  bookingCheckIn: Date;
  guests: readonly { id: string; memberId: string | null }[];
  today?: Date;
}): BookingSelfRemovalCard | null {
  if (isBookingOwner || isAdminViewer) return null;
  if (bookingDeletedAt) return null;
  // `guests` carries non-member rows with a null `memberId`, so an absent actor
  // id would match the first of them by equality and put somebody else's guest
  // id on the page (the action itself would still be refused).
  if (!actorMemberId) return null;

  const viewerGuest = guests.find((guest) => guest.memberId === actorMemberId);
  if (!viewerGuest) return null;

  const { canSelfRemove, blocker } = evaluateGuestSelfRemoval({
    actorMemberId,
    guestMemberId: viewerGuest.memberId,
    bookingOwnerMemberId,
    bookingStatus,
    bookingCheckIn,
    bookingGuestCount: guests.length,
    ...(today ? { today } : {}),
  });

  return {
    guestId: viewerGuest.id,
    canSelfRemove,
    blockedReason: blocker ? describeGuestSelfRemovalBlocker(blocker) : null,
  };
}
