import { BookingStatus, type Prisma, type PrismaClient } from "@prisma/client";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  normalizeDateOnlyForTimeZone,
} from "@/lib/date-only";
import {
  isGuestActiveOnNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { evaluateGuestSelfRemoval } from "@/lib/booking-guest-self-removal";
import { buildBookingMemberNightConflictMessage } from "@/lib/booking-member-night-conflict-messages";

const BOOKING_MEMBER_NIGHT_CONFLICT_CODE =
  "BOOKING_MEMBER_NIGHT_CONFLICT";

const BOOKING_MEMBER_NIGHT_LOCK_NAMESPACE = "booking-member-night";

// The subset of a transaction client this module needs to take the per-member
// advisory lock. `prisma` and any `Prisma.TransactionClient` both satisfy it.
type MemberNightLockClient = { $executeRaw: Prisma.TransactionClient["$executeRaw"] };

function hasExecuteRaw(db: unknown): db is MemberNightLockClient {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as { $executeRaw?: unknown }).$executeRaw === "function"
  );
}

/**
 * Serialise the member-night guard ACROSS LODGES (#1881). The person-night
 * invariant — "a linked member is on at most one live booking per lodge night"
 * — spans lodges (`findBookingMemberNightConflicts` intentionally ignores
 * `lodgeId`), but capacity claims serialise only PER lodge
 * (`acquireLodgeCapacityLock`). So two concurrent writers creating/re-dating the
 * SAME member's footprint at DIFFERENT lodges hold different capacity locks and
 * both pass the guard, double-booking the member. Take a per-member
 * transaction-scoped advisory lock for every member-linked guest BEFORE the
 * guard reads, in sorted memberId order so composing several can never deadlock
 * (the same sorted-order discipline the multi-lodge processor uses). Keyed in
 * its own namespace, so it never contends with the per-lodge, global, or
 * credit-ledger locks. Callers take this AFTER their per-lodge lock, giving a
 * consistent lodge → member-night acquisition order.
 */
export async function lockBookingMemberNights(
  db: MemberNightLockClient,
  guests: readonly ConflictGuestInput[],
): Promise<void> {
  const memberIds = Array.from(
    new Set(
      guests
        .map((guest) => guest.memberId)
        .filter((id): id is string => Boolean(id)),
    ),
  ).sort();
  for (const memberId of memberIds) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BOOKING_MEMBER_NIGHT_LOCK_NAMESPACE}), hashtext(${memberId}))`;
  }
}

// test seam
export const MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES = [
  BookingStatus.DRAFT,
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
  BookingStatus.WAITLISTED,
  BookingStatus.WAITLIST_OFFERED,
  BookingStatus.AWAITING_REVIEW,
] as const;

type ConflictDb =
  | Pick<PrismaClient, "bookingGuest">
  | Pick<Prisma.TransactionClient, "bookingGuest">;

type ConflictGuestInput = GuestStayRange & {
  memberId?: string | null;
};

/**
 * ENTITLEMENT-SCOPED PAYLOAD (#2250). A member-night 409 goes to whoever made
 * the request, and that requester is not necessarily entitled to see the
 * clashing booking: a member may legitimately have a family-group member who is
 * a guest on a STRANGER's booking, and a side-effect-free
 * `POST /api/bookings/quote` would otherwise hand them that stranger's name,
 * their whole stay range, and the booking id.
 *
 * So every field describing the OTHER booking (and the other guest row on it)
 * is present only when the server marked this viewer `canOpenBooking` — the
 * booking's own owner, an admin, or the conflicting guest themselves. The
 * always-present fields are exactly the ones the requester already supplied or
 * already knows: the member they tried to book, that member's name, and the
 * intersection with the nights they chose.
 *
 * Gating the fields here rather than in each of the ~14 routes that return this
 * body is deliberate: those routes pass the array straight through, so this
 * assembly point is the only place the rule can be stated once.
 */
export type BookingMemberNightConflict = {
  memberId: string;
  memberName: string;
  conflictingNights: string[];
  isOwnBooking: boolean;
  canOpenBooking: boolean;
  canSelfRemove: boolean;
  /**
   * The clashing guest row is the actor's own place (#2250). Distinct from
   * `canSelfRemove`, which is additionally gated on status/date/last-guest and
   * is false for the commonest clash of all — the member against a booking they
   * made themselves. The copy uses it to address the member directly rather
   * than narrating them in the third person.
   */
  isSelfGuest: boolean;
  /**
   * The clashing booking and the clashing guest row on it. Present only when
   * `canOpenBooking` — see the disclosure note above. `guestId` goes with them:
   * on its own it addresses nothing (every guest route is scoped by its booking
   * id), and keeping it would leave a stable handle on a stranger's guest row
   * for no UI that is allowed to use it.
   */
  bookingId?: string;
  bookingStatus?: BookingStatus;
  bookingOwnerName?: string;
  bookingCheckIn?: string;
  bookingCheckOut?: string;
  guestId?: string;
};

/** The disclosure-gated half of a conflict row, listed once so tests can assert it. */
export const BOOKING_MEMBER_NIGHT_CONFLICT_PRIVILEGED_FIELDS = [
  "bookingCheckIn",
  "bookingCheckOut",
  "bookingId",
  "bookingOwnerName",
  "bookingStatus",
  "guestId",
] as const;

export class BookingMemberNightConflictError extends Error {
  constructor(public readonly conflicts: BookingMemberNightConflict[]) {
    // #2250 — the message says who, which nights, and what to do next, built
    // only from what the requester already supplied (the member they tried to
    // book and the nights they chose). See the disclosure rule in
    // booking-member-night-conflict-messages.ts.
    super(buildBookingMemberNightConflictMessage(conflicts));
    this.name = "BookingMemberNightConflictError";
  }
}

function displayName(firstName?: string | null, lastName?: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || "Member";
}

function requestedNightsByMember(
  guests: readonly ConflictGuestInput[],
  checkIn: Date,
  checkOut: Date,
) {
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const end = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, end);
  const byMember = new Map<string, Set<string>>();

  for (const guest of guests) {
    if (!guest.memberId) continue;
    const bookingRange = { checkIn: start, checkOut: end };
    for (const night of nights) {
      if (!isGuestActiveOnNight(guest, night, bookingRange)) continue;
      const memberNights = byMember.get(guest.memberId) ?? new Set<string>();
      memberNights.add(formatDateOnly(night));
      byMember.set(guest.memberId, memberNights);
    }
  }

  return byMember;
}

export async function findBookingMemberNightConflicts(
  db: ConflictDb,
  {
    actorMemberId,
    actorRole,
    checkIn,
    checkOut,
    guests,
    excludeBookingId,
  }: {
    actorMemberId: string;
    actorRole: string;
    checkIn: Date;
    checkOut: Date;
    guests: readonly ConflictGuestInput[];
    excludeBookingId?: string;
  },
): Promise<BookingMemberNightConflict[]> {
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const end = normalizeDateOnlyForTimeZone(checkOut);
  const requested = requestedNightsByMember(guests, start, end);
  const memberIds = [...requested.keys()];
  if (memberIds.length === 0) return [];

  const today = normalizeDateOnlyForTimeZone(new Date());
  const existingGuests = await db.bookingGuest.findMany({
    where: {
      memberId: { in: memberIds },
      booking: {
        deletedAt: null,
        checkIn: { lt: end },
        checkOut: { gt: start },
        status: { in: [...MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES] },
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
        OR: [
          { status: { not: BookingStatus.DRAFT } },
          { draftExpiresAt: null },
          { draftExpiresAt: { gt: new Date() } },
        ],
      },
    },
    include: {
      nights: { select: { stayDate: true } },
      member: { select: { firstName: true, lastName: true } },
      booking: {
        select: {
          id: true,
          memberId: true,
          status: true,
          checkIn: true,
          checkOut: true,
          member: { select: { firstName: true, lastName: true } },
          guests: { select: { id: true, memberId: true } },
        },
      },
    },
  });

  const conflicts: BookingMemberNightConflict[] = [];

  for (const guest of existingGuests) {
    if (!guest.memberId) continue;
    const requestedNights = requested.get(guest.memberId);
    if (!requestedNights) continue;

    const bookingRange = {
      checkIn: guest.booking.checkIn,
      checkOut: guest.booking.checkOut,
    };
    const conflictingNights = [...requestedNights].filter((night) =>
      isGuestActiveOnNight(
        guest,
        normalizeDateOnlyForTimeZone(new Date(`${night}T00:00:00.000Z`)),
        bookingRange,
      ),
    );
    if (conflictingNights.length === 0) continue;

    const isOwnBooking = guest.booking.memberId === actorMemberId;
    const isSelfGuest = guest.memberId === actorMemberId;
    // #2250 — one server-side rule, shared with the booking detail page's
    // affordance and with the removal service's own status gate, so no surface
    // offers (or withholds) self-removal on its own private copy of the rule.
    const { canSelfRemove } = evaluateGuestSelfRemoval({
      actorMemberId,
      guestMemberId: guest.memberId,
      bookingOwnerMemberId: guest.booking.memberId,
      bookingStatus: guest.booking.status,
      bookingCheckIn: guest.booking.checkIn,
      bookingGuestCount: guest.booking.guests.length,
      today,
    });

    const canOpenBooking = isOwnBooking || actorRole === "ADMIN" || isSelfGuest;

    conflicts.push({
      memberId: guest.memberId,
      memberName: displayName(
        guest.member?.firstName ?? guest.firstName,
        guest.member?.lastName ?? guest.lastName,
      ),
      conflictingNights: conflictingNights.sort(),
      isOwnBooking,
      canOpenBooking,
      canSelfRemove,
      isSelfGuest,
      // #2250 — everything about the OTHER booking is attached only for a
      // viewer entitled to it. The admin paths (booking-request approve / hold
      // / send-quote / link-conflicts, and every admin-on-behalf create and
      // modify) pass `actorRole: "ADMIN"`, so an admin resolving a conflict
      // still receives the full detail their UI renders.
      ...(canOpenBooking
        ? {
            bookingId: guest.booking.id,
            bookingStatus: guest.booking.status,
            bookingOwnerName: displayName(
              guest.booking.member.firstName,
              guest.booking.member.lastName,
            ),
            bookingCheckIn: formatDateOnly(guest.booking.checkIn),
            bookingCheckOut: formatDateOnly(guest.booking.checkOut),
            guestId: guest.id,
          }
        : {}),
    });
  }

  return conflicts.sort((a, b) => {
    const byNight = a.conflictingNights[0].localeCompare(b.conflictingNights[0]);
    if (byNight !== 0) return byNight;
    return a.memberName.localeCompare(b.memberName);
  });
}

export async function assertNoBookingMemberNightConflicts(
  db: ConflictDb,
  input: Parameters<typeof findBookingMemberNightConflicts>[1],
) {
  // #1881 — take the per-member advisory lock BEFORE the guard reads, so the
  // cross-lodge person-night invariant is serialised (capacity locks are
  // per-lodge only). This is the authoritative enforcement path and always runs
  // inside a transaction, so the lock is transaction-scoped and released on
  // commit/rollback. The advisory (non-authoritative) `findBookingMemberNight-
  // Conflicts` pre-check deliberately does NOT lock. If `db` is not a
  // lock-capable client (never the case for the authoritative callers, which
  // pass the transaction client), the guard still reads — this only adds the
  // cross-lodge serialisation, it never weakens the existing check.
  if (hasExecuteRaw(db)) {
    await lockBookingMemberNights(db, input.guests);
  }
  const conflicts = await findBookingMemberNightConflicts(db, input);
  if (conflicts.length > 0) {
    throw new BookingMemberNightConflictError(conflicts);
  }
}

export function getBookingMemberNightConflictResponse(
  conflicts: BookingMemberNightConflict[],
) {
  return {
    code: BOOKING_MEMBER_NIGHT_CONFLICT_CODE,
    // #2250 — same message the thrown error carries, so the advisory pre-check
    // (409 built from a found conflict list) and the transactional guard read
    // identically to the member. Flow-neutral by default: this response is also
    // returned by the admin booking-request approve/hold/quote routes, where
    // "choose different dates" is advice the reader cannot act on. Surfaces
    // that DO pick the dates (the booking wizard) opt back in by rendering
    // `describeBookingMemberNightConflictNextStep` with
    // `canChooseDifferentDates`.
    error: buildBookingMemberNightConflictMessage(conflicts),
    conflicts,
  };
}
