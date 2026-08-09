import { prisma } from "@/lib/prisma";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { checkinNotBlockedByPendingReviewFilter } from "@/lib/booking-review";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import type { Prisma } from "@prisma/client";
import {
  isGuestDepartureMorning,
  isGuestOperationallyPresentOnDay,
} from "@/lib/booking-guest-stay-ranges";

// PRE-EXISTING DIVERGENCE, PRESERVED ON PURPOSE (#2622): this alias is a
// separate name for the same list as `OPERATIONAL_STAY_BOOKING_STATUSES`, and
// the two are free to drift. Unifying them would silently re-scope the kiosk
// arrive/depart lookups as well as roster validation, which is not this issue's
// change. Leave them as two names until something deliberately reconciles them.
export const LODGE_VISIBLE_BOOKING_STATUSES = [
  ...OPERATIONAL_STAY_BOOKING_STATUSES,
] as const;

// THE ARRIVE/DEPART ASYMMETRY IS DELIBERATE AND #2622 LEFT IT ALONE.
// `findLodgeGuestForDate` (arrive) stays NIGHT-only: you can only mark someone
// arrived for a night they are actually sleeping. `findLodgeGuestDepartingOnDate`
// (depart) stays pinned to the EXACT departure date: you leave on one specific
// day, not on any day you happen to be present. Neither is the roster's
// operational-day question — "was this person in the building this morning?" —
// so neither moved to the operational-day rule. Do not "unify" them.
//
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

/**
 * The guest who may be marked departed on exactly this date.
 *
 * Still the narrow "you leave on one specific day" rule of the comment above —
 * it is NOT the roster's "was this person in the building this morning?". What
 * changed in #2628 is that a stay can have MORE THAN ONE departure day. The
 * query used to be keyed `stayEnd: date`, and `stayEnd` is the morning after the
 * guest's LAST night, so a guest booked on nights {10, 12} could only ever be
 * marked departed on the 13th — the officer had no way to record that they left
 * on the 11th and came back on the 12th.
 *
 * So the SQL filter is now the coarse envelope (which must contain any departure
 * morning) and the authoritative decision is `isGuestDepartureMorning` applied
 * to the loaded night rows — the same load-coarse-then-decide-in-code shape
 * `validateRosterAllocationsForDate` uses below. For a contiguous stay the two
 * are the same date, and for a guest carrying no night rows the helper falls
 * back to the envelope and yields `stayEnd` alone, so neither case moves.
 */
export async function findLodgeGuestDepartingOnDate(
  bookingGuestId: string,
  date: Date,
  lodgeId?: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const guest = await db.bookingGuest.findFirst({
    where: {
      id: bookingGuestId,
      stayStart: { lte: date },
      stayEnd: { gte: date },
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
      stayStart: true,
      stayEnd: true,
      nights: { select: { stayDate: true } },
      booking: {
        select: {
          memberId: true,
          checkIn: true,
          checkOut: true,
        },
      },
    },
  });

  if (!guest || !isGuestDepartureMorning(guest, date, guest.booking)) {
    return null;
  }
  return guest;
}

/**
 * Does every submitted allocation name someone who is actually here today?
 *
 * #2622: "here today" is the operational day, not the night — a guest who
 * checks out this morning is on the roster, so both coarse envelope bounds are
 * checkout-inclusive (`gte`) and the authoritative decision is the shared
 * operational-day rule applied to the loaded night rows.
 */
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
      stayEnd: { gte: date },
      // D-12 (#2307): an unconsented guest is not on the roster at all, so an
      // allocation naming them fails validation and roster-confirm rejects it.
      ...OPERATIONALLY_PRESENT_GUEST_WHERE,
      booking: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        checkIn: { lte: date },
        checkOut: { gte: date },
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
      .filter((guest) =>
        isGuestOperationallyPresentOnDay(guest, date, guest.booking),
      )
      .map((guest) => [guest.id, guest.bookingId])
  );

  return allocations.every(
    (allocation) =>
      guestBookingMap.get(allocation.bookingGuestId) === allocation.bookingId
  );
}
