import { prisma } from "@/lib/prisma";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { checkinNotBlockedByPendingReviewFilter } from "@/lib/booking-review";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import type { Prisma } from "@prisma/client";
import {
  isGuestActiveOnNight,
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
// `findLodgeGuestForDate` (arrive) stays NIGHT-scoped: you can only mark someone
// arrived for a night they are sleeping, never for the morning they drive home.
// `findLodgeGuestDepartingOnDate` (depart) stays pinned to a DEPARTURE MORNING:
// you leave on a specific day, not on any day you happen to be present. #2628
// changed how many such mornings there are — a sparse stay has ONE PER SEGMENT,
// not one per stay — and nothing else about the rule. Neither lookup is the
// roster's operational-day question — "was this person in the building this
// morning?" — so neither moved to the operational-day rule. Do not "unify" them.
//
// BOTH LOOKUPS NOW LOAD COARSE AND DECIDE IN CODE (#2737, INV-DATE-022). A SQL
// `where` on `stayStart`/`stayEnd` is an ENVELOPE, and an envelope is only ever
// a SUPERSET of the canonical `BookingGuestNight` set: a sparse stay's internal
// gap nights sit inside `[stayStart, stayEnd)`, so until #2737 the arrive
// endpoint would accept a check-in for a night the guest is at home. No kiosk
// surface ever offered it — `canMarkArrived` has been the night-set rule since
// #2628 — but "no screen sends it" is not a server guard, and the endpoint is
// reachable from a stale open page or a direct call. The authoritative answer is
// now `isGuestActiveOnNight` applied to the loaded night rows, which is exactly
// the shape the depart lookup takes with `isGuestDepartureMorning`. A guest
// carrying no night rows still falls back to the envelope, so every pre-#713 row
// behaves byte-for-byte as it always has.
//
// The arrive envelope stays HALF-OPEN (`stayEnd: { gt: date }`) while depart's
// is checkout-inclusive, and that asymmetry is not an oversight to tidy away. A
// departure morning is never an occupied night (INV-DATE-003), so widening
// arrive's coarse filter could only load rows the night rule then refuses: the
// narrower filter is the cheaper of two answers that agree.
//
// lodgeId is optional so existing (pre-phase-5) callers keep club-wide
// behaviour; kiosk routes pass the resolved lodge to scope the lookup
// (docs/multi-lodge/lodge-scoping-contract.md — roster/guest lookups are
// null-tolerant while lodgeId backfill is not yet enforced NOT NULL).

/** The guest row both the arrive lookup and its refusal are decided over. */
export type LodgeArrivalGuest = NonNullable<
  Awaited<ReturnType<typeof loadLodgeGuestInArrivalEnvelope>>
>;

/**
 * May this guest be marked ARRIVED for this date, and if not, why not?
 *
 * THREE outcomes, not two, because the two refusals are different facts and the
 * kiosk must not report them the same way (#2737):
 *
 * - `"not-found"` — nothing matched the scoped lookup at all. Deliberately
 *   uniform and deliberately uninformative: it is also what an unconsented guest
 *   (D-12/#2307), a review-blocked booking (#1372/#1422), another lodge's guest
 *   and a non-operational booking status collapse to, and telling the caller
 *   which of those it was would leak the answer to a question they were refused.
 * - `"not-a-booked-night"` — the guest passed EVERY one of those gates and
 *   failed only the night rule. Nothing is disclosed by saying so that the day
 *   list does not already show the same operator, and it is the only refusal a
 *   hut leader can act on: the page is stale, reload it.
 */
export type LodgeArrivalLookup =
  | { outcome: "ok"; guest: LodgeArrivalGuest }
  | { outcome: "not-found" }
  | { outcome: "not-a-booked-night" };

export async function findLodgeGuestForDate(
  bookingGuestId: string,
  date: Date,
  lodgeId?: string
): Promise<LodgeArrivalLookup> {
  const guest = await loadLodgeGuestInArrivalEnvelope(
    bookingGuestId,
    date,
    lodgeId
  );
  if (!guest) {
    return { outcome: "not-found" };
  }
  // THE WHOLE POINT OF #2737, AND IT IS DELIBERATELY NOT IN THE `where` ABOVE.
  // The where-clause fragments are the ENFORCEMENT gates — consent, pending
  // review, lodge scope, booking status — and folding the night rule in beside
  // them would make "you are at home tonight" indistinguishable from "you are
  // not allowed", both to the caller and to the next reader of this file. It is
  // a domain fact about the booking, so it is decided here, in code, over the
  // night rows, and it is reported as its own outcome.
  if (!isGuestActiveOnNight(guest, date, guest.booking)) {
    return { outcome: "not-a-booked-night" };
  }
  return { outcome: "ok", guest };
}

function loadLodgeGuestInArrivalEnvelope(
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
      // #2628: the arrive endpoint has to be able to tell a RETURN from a first
      // arrival, because `arrivedAt`/`departedAt` is one attendance pair for the
      // whole stay. A guest booked on nights {11, 14} arrives on the 14th
      // against a record that still says "departed" from the 12th, and only the
      // night set says which of those two a given date is.
      //
      // #2737: `nights` is now load-bearing for the LOOKUP itself, not only for
      // the route's return-detection. Drop it and the night rule above silently
      // degrades to the envelope fallback — which is exactly the gap-night hole
      // this closes, so a fixture that omits it is pinning the wrong function.
      //
      // `stayStart`/`stayEnd` are defence in depth rather than load-bearing
      // TODAY, and the difference is worth stating precisely so nobody
      // "verifies" it wrongly in either direction. The `where` above already
      // pins the row to the guest's own envelope, so for a legacy guest with no
      // night rows the fallback answers the same whether these are selected or
      // not. They stay selected so the in-code rule is keyed to the GUEST's
      // envelope and not the whole booking's — `getGuestStayStart`/`End`
      // substitute `booking.checkIn`/`checkOut` when they are missing, and the
      // two differ for a partial-stay guest. The rule must not depend on the
      // `where` to be correct, because the `where` is only a coarse pre-filter
      // (INV-DATE-022) and is free to widen. Neither `tsc` (both fields are
      // optional on `GuestStayRange`) nor any mocked-Prisma test can catch
      // these going missing, so the select-shape probe in
      // `lodge-arrive-depart-asymmetry.test.ts` pins all three by name.
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
