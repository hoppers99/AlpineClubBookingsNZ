import type { Prisma, Role } from "@prisma/client";
import { ApiError } from "@/lib/api-error";

/**
 * The reciprocal "other club member" rate on a booking (Other Lodges epic,
 * follow-up to #2749).
 *
 * A booking officer names a partner lodge on the booking (`Booking.otherLodgeId`)
 * and then ticks the individual NON-MEMBER guests who belong to it
 * (`BookingGuest.otherLodgeMember`). Those guests price from the club's own FULL
 * member rate rows at their own age tier; everybody else is untouched.
 *
 * WHY THIS MODULE EXISTS RATHER THAN THE RULE BEING WRITTEN TWICE. The preview
 * (`modify-quote`) and the save (`modifyBookingBatch` → `prepareGuestPlan`) must
 * agree exactly: the panel shows a per-person fee and a settlement delta from the
 * first, and charges them through the second, so any divergence is a quote/charge
 * mismatch of the whole member/non-member spread. Both call
 * {@link resolveOtherLodgeRateElection} with the same stored booking and the same
 * request fields, and both read the effective flag and the "must reprice" set off
 * the result. That is the same shape the #2337 placeholder→member link uses, and
 * for the same reason.
 *
 * IT CHANGES THE RATE AND NOTHING ELSE. `BookingGuest.isMember` stays false, so
 * adult-member hosting, the non-member hold, split bookings,
 * `Booking.hasNonMembers`, the subscription gate and member-only promotions all
 * keep seeing a non-member — which is the truth: the person is a member of
 * ANOTHER club, not of this one.
 */

export const OTHER_LODGE_RATE_ADMIN_ONLY_MESSAGE =
  "Only an admin or booking officer can price a guest at the other-lodge member rate.";
export const OTHER_LODGE_RATE_GUEST_NOT_ON_BOOKING_MESSAGE =
  "One or more other-lodge member ticks referenced a guest not on this booking.";
export const OTHER_LODGE_RATE_MEMBER_GUEST_MESSAGE =
  "A member of this club already prices at their own membership rate and cannot be marked as an other-lodge member.";
export const OTHER_LODGE_RATE_LODGE_REQUIRED_MESSAGE =
  "Choose the other lodge before marking anybody as one of its members.";
export const OTHER_LODGE_RATE_LODGE_NOT_FOUND_MESSAGE = "Selected lodge not found";
/**
 * The other-club re-rate is refused on a mid-stay (in-progress) edit, for
 * exactly the reason the #2337 link is (`GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE`).
 *
 * A mid-stay edit prices through `buildInProgressGuestRangePlan`, which is fed
 * the ORIGINAL stored guest rows rather than the election-modified pricing rows.
 * The cleared `lockedNightPrices` and the new flag therefore never reach
 * pricing: the re-rate would stamp the guest and settle $0. Refusing is the
 * honest answer, and it is refused on BOTH the preview and the save so the
 * officer sees the refusal rather than a phantom $0 quote.
 */
export const OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE =
  "The other-lodge member rate cannot be changed once a booking has started. Contact the office to adjust the price on a stay that is already under way.";

/** The stored shape this election is resolved against. */
export interface OtherLodgeRateBooking {
  otherLodgeId: string | null;
  guests: ReadonlyArray<{
    id: string;
    isMember: boolean;
    otherLodgeMember: boolean;
  }>;
}

/** The two request fields, exactly as both routes' zod schemas parse them. */
export interface OtherLodgeRateInput {
  /**
   * The partner lodge for the whole booking. `undefined` means "this edit says
   * nothing about it" and leaves the stored value alone; `null` clears it, which
   * also clears every guest flag.
   */
  otherLodgeId?: string | null;
  /**
   * The complete end-state set of guests to price at the other-lodge member
   * rate — not a delta. A guest absent from a PRESENT array is unflagged, which
   * is what makes unticking somebody reprice them back to the non-member rate.
   * `undefined` means the edit says nothing about it.
   */
  otherLodgeMemberGuestIds?: string[];
}

export interface OtherLodgeRateElection {
  /** True when this request carried an election at all. */
  requested: boolean;
  /** The booking's partner lodge once this edit is saved. */
  otherLodgeId: string | null;
  /** Whether {@link otherLodgeId} differs from the stored value. */
  otherLodgeIdChanged: boolean;
  /** Every guest priced at the other-lodge member rate once this edit is saved. */
  flaggedGuestIds: ReadonlySet<string>;
  /**
   * Guests whose flag CHANGES in this request, in either direction.
   *
   * LOAD-BEARING: these are exactly the guests whose locked booked-night prices
   * must be cleared so the stay actually reprices. Leave the locks in place and
   * a tick changes nothing at all — every night stays pinned to the price it was
   * bought at (#1036) — which is the same trap the #2337 link had to avoid. It
   * cuts both ways here: unticking somebody whose nights are locked at the member
   * rate has to clear them too, or they never go back to the non-member rate.
   */
  repriceGuestIds: ReadonlySet<string>;
}

/** The election a request that says nothing about the other-lodge rate produces. */
function inertElection(booking: OtherLodgeRateBooking): OtherLodgeRateElection {
  return {
    requested: false,
    otherLodgeId: booking.otherLodgeId,
    otherLodgeIdChanged: false,
    flaggedGuestIds: new Set(
      booking.guests.filter((guest) => guest.otherLodgeMember).map((guest) => guest.id),
    ),
    repriceGuestIds: new Set(),
  };
}

/**
 * Resolve the end state of the other-lodge rate election for one modification,
 * enforcing the fences the save path relies on.
 *
 * The gate is admin/officer-only, mirroring `resolveGuestMemberLinks`: this
 * re-rates a guest downward, so it must be unreachable from member self-service
 * however this resolver is reached, not merely hidden on the screen. The rest is
 * structural — a tick must name a guest on this booking, that guest must be a
 * non-member, and a tick with no lodge behind it is refused so a booking can
 * never carry a member-rated guest with no club recorded against them.
 */
export function resolveOtherLodgeRateElection({
  booking,
  input,
  role,
}: {
  booking: OtherLodgeRateBooking;
  input: OtherLodgeRateInput;
  role: Role;
}): OtherLodgeRateElection {
  const mentionsLodge = input.otherLodgeId !== undefined;
  const mentionsGuests = input.otherLodgeMemberGuestIds !== undefined;
  if (!mentionsLodge && !mentionsGuests) {
    return inertElection(booking);
  }

  if (role !== "ADMIN") {
    throw new ApiError(OTHER_LODGE_RATE_ADMIN_ONLY_MESSAGE, 403);
  }

  const otherLodgeId = mentionsLodge
    ? (input.otherLodgeId?.trim() || null)
    : booking.otherLodgeId;

  const guestsById = new Map(booking.guests.map((guest) => [guest.id, guest]));
  const flaggedGuestIds = new Set<string>();
  for (const guestId of input.otherLodgeMemberGuestIds ?? []) {
    const guest = guestsById.get(guestId);
    if (!guest) {
      throw new ApiError(OTHER_LODGE_RATE_GUEST_NOT_ON_BOOKING_MESSAGE, 400);
    }
    if (guest.isMember) {
      throw new ApiError(OTHER_LODGE_RATE_MEMBER_GUEST_MESSAGE, 400);
    }
    flaggedGuestIds.add(guestId);
  }
  // Dropping the lodge drops every tick with it, in one direction only: a
  // request that clears the lodge AND names guests is a contradiction, refused
  // rather than silently half-applied.
  if (!otherLodgeId && flaggedGuestIds.size > 0) {
    throw new ApiError(OTHER_LODGE_RATE_LODGE_REQUIRED_MESSAGE, 400);
  }

  const repriceGuestIds = new Set<string>();
  for (const guest of booking.guests) {
    if (guest.otherLodgeMember !== flaggedGuestIds.has(guest.id)) {
      repriceGuestIds.add(guest.id);
    }
  }

  return {
    requested: true,
    otherLodgeId,
    otherLodgeIdChanged: otherLodgeId !== booking.otherLodgeId,
    flaggedGuestIds,
    repriceGuestIds,
  };
}

/**
 * Confirm a named partner lodge exists, so the save fails with a 400 the officer
 * can read rather than a foreign-key violation. Skipped entirely when the
 * election names no lodge or leaves the stored one alone.
 */
export async function assertOtherLodgeExists(
  db: Pick<Prisma.TransactionClient, "otherLodge">,
  otherLodgeId: string | null,
): Promise<void> {
  if (!otherLodgeId) return;
  const found = await db.otherLodge.findUnique({
    where: { id: otherLodgeId },
    select: { id: true },
  });
  if (!found) {
    throw new ApiError(OTHER_LODGE_RATE_LODGE_NOT_FOUND_MESSAGE, 400);
  }
}
