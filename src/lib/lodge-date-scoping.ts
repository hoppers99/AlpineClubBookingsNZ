import { prisma } from "@/lib/prisma";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { checkinNotBlockedByPendingReviewFilter } from "@/lib/booking-review";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import type { Prisma } from "@prisma/client";
import { isGuestActiveOnNight } from "@/lib/booking-guest-stay-ranges";

export const LODGE_VISIBLE_BOOKING_STATUSES = [
  ...OPERATIONAL_STAY_BOOKING_STATUSES,
] as const;

// lodgeId is optional so existing (pre-phase-5) callers keep club-wide
// behaviour; kiosk routes pass the resolved lodge to scope the lookup
// (docs/multi-lodge/lodge-scoping-contract.md — roster/guest lookups are
// null-tolerant while lodgeId backfill is not yet enforced NOT NULL).
export async function findLodgeGuestForDate(
  bookingGuestId: string,
  date: Date,
  lodgeId?: string
) {
  return prisma.bookingGuest.findFirst({
    where: {
      id: bookingGuestId,
      stayStart: { lte: date },
      stayEnd: { gt: date },
      // Owner decision D-12 (#2307): this is the ENFORCEMENT half of the kiosk,
      // not just the display half. A guest whose member consent is still
      // PENDING must resolve to null here so `arrive` 404s exactly the way a
      // review-blocked guest already does — otherwise the arrivals list hides
      // them while the endpoint would still happily mark them arrived.
      ...OPERATIONALLY_PRESENT_GUEST_WHERE,
      booking: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        checkIn: { lte: date },
        checkOut: { gt: date },
        ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
        // Enforcement path (#1372 / #1422): keep excluding a booking blocked by
        // a pending admin review so its guest resolves to null and the arrive
        // endpoint 404s — even though the guest LIST now shows it flagged.
        ...checkinNotBlockedByPendingReviewFilter(),
      },
    },
    select: {
      id: true,
      bookingId: true,
      firstName: true,
      lastName: true,
      memberId: true,
      arrivedAt: true,
      departedAt: true,
      booking: {
        select: {
          memberId: true,
        },
      },
    },
  });
}

export async function findLodgeGuestDepartingOnDate(
  bookingGuestId: string,
  date: Date,
  lodgeId?: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return db.bookingGuest.findFirst({
    where: {
      id: bookingGuestId,
      stayStart: { lte: date },
      stayEnd: date,
      // D-12 (#2307): the depart endpoint gets the same treatment as arrive —
      // an unconsented guest resolves to null and the endpoint 404s.
      ...OPERATIONALLY_PRESENT_GUEST_WHERE,
      booking: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        checkIn: { lte: date },
        checkOut: { gte: date },
        ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
        // Enforcement path (#1372 / #1422): keep excluding a booking blocked by
        // a pending admin review so its guest resolves to null and the depart
        // endpoint 404s — even though the guest LIST now shows it flagged.
        ...checkinNotBlockedByPendingReviewFilter(),
      },
    },
    select: {
      id: true,
      bookingId: true,
      firstName: true,
      lastName: true,
      memberId: true,
      arrivedAt: true,
      departedAt: true,
      booking: {
        select: {
          memberId: true,
        },
      },
    },
  });
}

export async function validateRosterAllocationsForDate(
  allocations: Array<{ bookingGuestId: string; bookingId: string }>,
  date: Date,
  lodgeId?: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const guestIds = Array.from(
    new Set(allocations.map((allocation) => allocation.bookingGuestId))
  );

  const guests = await db.bookingGuest.findMany({
    where: {
      id: { in: guestIds },
      stayStart: { lte: date },
      stayEnd: { gt: date },
      // D-12 (#2307): an unconsented guest is not on the roster at all, so an
      // allocation naming them fails validation and roster-confirm rejects it.
      ...OPERATIONALLY_PRESENT_GUEST_WHERE,
      booking: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        checkIn: { lte: date },
        checkOut: { gt: date },
        ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
        // Enforcement path (#1372 / #1422): keep excluding a booking blocked by
        // a pending admin review so roster-confirm rejects it — even though the
        // guest LIST now shows it flagged.
        ...checkinNotBlockedByPendingReviewFilter(),
      },
    },
    select: {
      id: true,
      bookingId: true,
      stayStart: true,
      stayEnd: true,
      nights: { select: { stayDate: true } },
      booking: { select: { checkIn: true, checkOut: true } },
    },
  });

  const guestBookingMap = new Map(
    guests
      .filter((guest) => isGuestActiveOnNight(guest, date, guest.booking))
      .map((guest) => [guest.id, guest.bookingId])
  );

  return allocations.every(
    (allocation) =>
      guestBookingMap.get(allocation.bookingGuestId) === allocation.bookingId
  );
}
