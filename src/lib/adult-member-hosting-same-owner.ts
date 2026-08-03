import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { formatBookingReference } from "@/lib/booking-reference";
import {
  ACTIVE_BOOKING_STATUSES,
  hostingCoverageSourceBookingFilter,
} from "@/lib/booking-status";

/**
 * The `SAME_BOOKING_OWNER` host scope: which OTHER bookings may supply cover, and
 * which other bookings DEPEND on this one's cover (#2576).
 *
 * Deliberately I/O-free — two Prisma `where` builders, the refusal shape, and the
 * member-facing sentence. The reads themselves live in
 * `adult-member-hosting-review.ts`, which is the one module allowed to turn a
 * persisted booking into evaluator input, and the incident/notification side lives
 * in `adult-member-hosting-coverage-incidents.ts`. Splitting it this way is what
 * keeps the import graph acyclic, and it means the RELATIONSHIP — the thing the
 * owner's decision is almost entirely about — can be read in one place.
 *
 * THE RELATIONSHIP IS THE EXACT `Booking.memberId`, AND NOTHING ELSE (§1). Not
 * `createdById`, not the administrator who keyed the booking in, not a matching
 * email address, not Family Group membership, not `parentBookingId` on its own,
 * not a shared group organiser, not a shared payment, not another member who
 * happens to be at the lodge, and not any fuzzy identity match. An administrator
 * entering bookings on behalf of two different members must not cause those
 * bookings to cover each other, so the only column either builder below filters
 * on is `memberId`.
 *
 * OWNERSHIP IS NOT ATTENDANCE (§2). Everything here is about which bookings are
 * in scope. WHO may host is decided afterwards, by the shared evaluator's own
 * `participantQualifiesAsHost` — a booking owned by an adult member supplies
 * nothing unless a qualifying adult member is actually recorded as attending the
 * relevant lodge-night. §13 forbids a second definition of a qualifying adult
 * member and this module deliberately contains none.
 *
 * COVERAGE IS EXISTENTIAL (§14). Neither builder is keyed on a stored dependency:
 * they are re-derived from live rows at every evaluation, so a dependent booking
 * stays compliant while ANY eligible source remains, and evidence naming the
 * source observed at one evaluation never becomes an authorisation.
 */

/**
 * Bookings whose attendance may cover `booking`'s non-member guest-nights.
 *
 * Four clauses, each from the owner's decision:
 *
 *  - `memberId` — the exact same account (§1).
 *  - `lodgeId` — the exact same lodge (§4). An adult member at Lodge A on Friday
 *    cannot cover Lodge B on Friday, so this is an equality and never a fan-out.
 *  - the eligible-source filter — genuinely confirmed active attendance only
 *    (§3), read off the canonical lifecycle helper in `booking-status.ts`.
 *  - a date-range OVERLAP — a source whose stay does not touch this booking's
 *    nights cannot cover any of them. Per-NIGHT matching still happens in the
 *    evaluator, on the participants' own `BookingGuestNight` rows; this clause
 *    only keeps the read bounded, which is why it is a coarse envelope test and
 *    not the coverage rule.
 *
 * The overlap is half-open, matching the rest of the codebase: `checkOut` is the
 * morning nobody stays, so a source arriving on this booking's checkout day, or
 * leaving on its arrival day, shares no night and is excluded.
 *
 * WHY THIS IS BOUNDED WITHOUT A NEW INDEX (§10). The leading equality is
 * `memberId`, and the existing `Booking(memberId, status, checkIn)` index makes
 * this one member's own bookings — single digits for almost every member, low
 * hundreds for the busiest — with the lodge and date clauses filtering inside
 * that. It is emphatically not the lodge-wide sweep #2575 rejected: no clause
 * here can match a booking belonging to anybody else. A narrower composite index
 * is deliberately NOT added, because the owner asked for "the narrow indexes
 * required by the proven query plan" and no plan has been proven against a
 * production-shaped database in this lane — see the PR's residual risks.
 */
export function sameBookingOwnerCoverageSourceWhere(
  booking: {
    id: string;
    memberId: string;
    lodgeId: string;
    checkIn: Date;
    checkOut: Date;
  },
  options: { historical?: boolean } = {},
): Prisma.BookingWhereInput {
  return {
    ...hostingCoverageSourceBookingFilter(options),
    memberId: booking.memberId,
    lodgeId: booking.lodgeId,
    id: { not: booking.id },
    checkIn: { lt: booking.checkOut },
    checkOut: { gt: booking.checkIn },
  };
}

/**
 * Bookings whose own compliance may DEPEND on `booking`'s attendance — the set
 * that has to be re-evaluated when this booking's rows change (§6, §8, §10).
 *
 * The mirror of the source builder, with one deliberate difference: the status
 * set is the wider `ACTIVE_BOOKING_STATUSES`, not the eligible-source set. A
 * dependent is any booking the rule would judge, and the rule judges a
 * PAYMENT_PENDING or AWAITING_REVIEW booking too — those cannot SUPPLY cover, but
 * they certainly NEED it, and a change that strands one of them has stranded a
 * real booking somebody is holding beds for.
 *
 * NO GUEST-COMPOSITION FILTER, on purpose. §10 describes the bound as "active
 * bookings containing relevant non-member guest-nights", and the SQL for "has a
 * participant the rule treats as a non-member guest" is not `memberId IS NULL`:
 * it also covers a member-linked row whose Member is inactive, cancelled or
 * archived. Expressing that here would be a second copy of
 * `participantIsNonMemberGuest` written in Prisma filters, and the failure
 * direction is the bad one — a drifted copy MISSES a dependent, which means no
 * refusal, no incident and no notification for a booking that really was
 * stranded. A copy that is merely too wide costs one idempotent reconciliation
 * that writes nothing. The owner/lodge/night clauses are what make the set small,
 * and they are all here.
 */
export function sameOwnerCoverageDependentWhere(booking: {
  id: string;
  memberId: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
}): Prisma.BookingWhereInput {
  return {
    memberId: booking.memberId,
    lodgeId: booking.lodgeId,
    deletedAt: null,
    status: { in: [...ACTIVE_BOOKING_STATUSES] },
    id: { not: booking.id },
    checkIn: { lt: booking.checkOut },
    checkOut: { gt: booking.checkIn },
  };
}

/** One same-owner booking a change would leave without required cover. */
export interface StrandedCoverageBooking {
  bookingId: string;
  /** The short handle the member sees, never the raw cuid alone. */
  reference: string;
  lodgeName: string;
  /** Sorted, unique NZ lodge-nights (YYYY-MM-DD) left uncovered. */
  nights: string[];
}

/**
 * The member-facing sentence for a refused self-service change (§6).
 *
 * The owner supplied the first sentence verbatim and it is used verbatim. What
 * follows is the evidence §6 asks for "where appropriate and safe": the affected
 * booking reference, its lodge and the uncovered dates.
 *
 * SAFE HERE BECAUSE OF THE RELATIONSHIP ITSELF. Every booking in this list has
 * the same `Booking.memberId` as the one being changed, so it is the member's
 * own booking on their own account — which §11 states plainly is something the
 * owner may see. Nothing from another account can reach this list, because
 * nothing in `sameOwnerCoverageDependentWhere` can match another account's
 * booking. No person is named: not the covering adult member, not a guest. The
 * member is told which of their bookings, which lodge and which nights, which is
 * exactly what they need to fix it.
 */
export function formatStrandedCoverageMessage(
  stranded: readonly StrandedCoverageBooking[],
): string {
  const opening =
    "This change would leave another booking on your account without the " +
    "required adult member coverage for one or more nights. Update the " +
    "affected booking first, provide alternative qualifying coverage, or " +
    "contact a Booking Officer for assistance.";
  if (stranded.length === 0) return opening;

  const detail = stranded
    .map(
      (row) =>
        `booking ${row.reference} at ${row.lodgeName} on ` +
        `${row.nights.join(", ")}`,
    )
    .join("; ");
  return `${opening} Affected: ${detail}.`;
}

/**
 * The refusal an ordinary member self-service change raises when it would strand
 * another same-owner booking's cover (§6).
 *
 * 409 AND NOT 403, for the same reason `AdultMemberHostingRequiredError` is: the
 * member is permitted to make this change, and a Booking Officer may authorise it
 * outright (§7) — what conflicts is the state of the other booking. It is thrown
 * from INSIDE the caller's transaction, after the change has been written and
 * evaluated against the resulting rows, so the throw rolls the change back and
 * the member's booking is left exactly as it was.
 *
 * DELIBERATELY NOT AN EXCEPTION-DOOR REFUSAL, and this is the one place it
 * differs from its hosting sibling. The #2365 exception workflow decides whether
 * a PROPOSED party may breach the hosting rule; this refusal is about a DIFFERENT
 * booking that is already confirmed and already compliant. The way out the owner
 * specified is the three concrete actions in the message — amend the affected
 * booking, restore alternative cover, or ask an officer — not a policy-exception
 * request against the booking being changed. `exceptionEligible` is therefore
 * absent rather than false: this refusal never enters exception review, so it
 * carries no aggregated review shape to mislead a client into offering one.
 */
export class SameOwnerCoverageWouldBreakError extends ApiError {
  readonly code = "SAME_OWNER_COVERAGE_WOULD_BREAK";
  readonly stranded: readonly StrandedCoverageBooking[];

  constructor(stranded: readonly StrandedCoverageBooking[]) {
    super(formatStrandedCoverageMessage(stranded), 409);
    this.name = "SameOwnerCoverageWouldBreakError";
    this.stranded = stranded;
  }
}

/** The member-facing body for the refusal above. */
export function buildSameOwnerCoverageRefusalBody(
  error: SameOwnerCoverageWouldBreakError,
) {
  return {
    error: error.message,
    code: error.code,
    details: error.message,
    // Structured beside the sentence so a client can render its own list
    // without parsing prose. Same-account only — see
    // `formatStrandedCoverageMessage`.
    strandedBookings: error.stranded.map((row) => ({
      bookingId: row.bookingId,
      reference: row.reference,
      lodgeName: row.lodgeName,
      nights: row.nights,
    })),
  };
}

/** The short reference for a stranded booking, so callers share one rendering. */
export function strandedCoverageReference(bookingId: string): string {
  return formatBookingReference(bookingId);
}
