import type { AgeTier } from "@prisma/client";

import { logAudit } from "@/lib/audit";
import { ApiError } from "@/lib/api-error";
import {
  createDraftBooking,
  type BookingGuestInput as DraftBookingGuestInput,
} from "@/lib/booking-create";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembersWithBoundary,
  type ResolvedLinkedBookingMembers,
} from "@/lib/booking-guests";
import {
  loadMemberGuestAddPolicy,
  planMemberGuestConsentWrites,
} from "@/lib/member-guest-add-policy";
import {
  matchMemberGuestNotificationRows,
  sendMemberGuestAddNotifications,
} from "@/lib/member-guest-consent-notifications";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayDiff(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
}

function toApiError(error: unknown) {
  if (error instanceof BookingGuestValidationError) {
    return new ApiError(error.message, error.status);
  }
  return error;
}

export async function copyBookingToDraft({
  sourceBookingId,
  targetCheckIn,
  adminMemberId,
}: {
  sourceBookingId: string;
  targetCheckIn: string;
  adminMemberId: string;
}) {
  const newCheckIn = parseDateOnly(targetCheckIn);
  if (Number.isNaN(newCheckIn.getTime())) {
    throw new ApiError("Invalid target check-in date", 400);
  }
  if (newCheckIn < getTodayDateOnly()) {
    throw new ApiError("Target check-in date cannot be in the past", 400);
  }

  const source = await prisma.booking.findUnique({
    where: { id: sourceBookingId },
    include: {
      guests: true,
      member: { select: { id: true, active: true } },
    },
  });
  if (!source) {
    throw new ApiError("Booking not found", 404);
  }
  if (source.deletedAt) {
    throw new ApiError("Deleted bookings cannot be copied", 400);
  }
  if (!source.member.active) {
    throw new ApiError("The booking member is inactive", 400);
  }
  if (source.guests.length === 0) {
    throw new ApiError("Cannot copy a booking with no guests", 400);
  }

  const sourceCheckIn = normalizeDateOnlyForTimeZone(source.checkIn);
  const sourceCheckOut = normalizeDateOnlyForTimeZone(source.checkOut);
  const nights = dayDiff(sourceCheckIn, sourceCheckOut);
  if (nights <= 0) {
    throw new ApiError("Source booking has invalid dates", 400);
  }

  const newCheckOut = addDaysDateOnly(newCheckIn, nights);
  const shiftDays = dayDiff(sourceCheckIn, newCheckIn);
  const memberGuestIds = source.guests
    .map((guest) => guest.memberId)
    .filter((memberId): memberId is string => Boolean(memberId));

  // "+ Add Member Guest" (epic #2305, MG2 #2307). Read before `createDraftBooking`
  // opens its transaction.
  const memberGuestPolicy = await loadMemberGuestAddPolicy();
  // MG4-D-a: the copy is an ADMIN add. This is also where CONSENT IS NOT
  // TRANSITIVE — see the re-stamp note below.
  const memberGuestActor: MemberGuestAddActor = {
    kind: "ADMIN",
    adminMemberId: adminMemberId,
  };

  let resolved: ResolvedLinkedBookingMembers;
  try {
    resolved = await resolveLinkedBookingMembersWithBoundary(
      prisma,
      source.memberId,
      memberGuestIds,
      {
        skipAuthorization: true,
        memberGuestWideningEnabled: memberGuestPolicy.wideningEnabled,
      },
    );
    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      resolved.members,
      adminMemberId,
      {
        actorRole: "ADMIN",
        onBehalfOfMemberId: source.memberId,
        // D-8: a blocked cross-family member is refused neutrally, even here —
        // the admin copying the booking may be looking at a member whose details
        // the source booking's owner should not have handed over in the first
        // place, and the refusal text is the club's, not the admin's.
        crossFamilyMemberIds: resolved.boundary.beyondFamilyMemberIds,
      },
    );
  } catch (error) {
    throw toApiError(error);
  }
  const linkedMembers = resolved.members;

  const copiedGuestInputs = source.guests.map((guest) => {
    if (guest.isMember && !guest.memberId) {
      throw new ApiError(
        "Source booking has a member guest without a linked member reference",
        400,
      );
    }

    const stayStart = addDaysDateOnly(
      normalizeDateOnlyForTimeZone(guest.stayStart ?? source.checkIn),
      shiftDays,
    );
    const stayEnd = addDaysDateOnly(
      normalizeDateOnlyForTimeZone(guest.stayEnd ?? source.checkOut),
      shiftDays,
    );

    return {
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier as AgeTier,
      isMember: guest.isMember,
      memberId: guest.memberId ?? undefined,
      stayStart,
      stayEnd,
    };
  });

  /**
   * CONSENT IS NOT TRANSITIVE ACROSS BOOKINGS, and this is the only place that
   * could have made it look like it is.
   *
   * The copy reads the SOURCE booking's guest rows, which may carry a
   * TARGET_APPROVED consent — a member who agreed to be on THAT stay, on those
   * nights, made by that person. Copying those columns forward would silently
   * assert that they also agreed to a different stay on different dates they have
   * never been told about. So the source consent columns are never read: every
   * copied cross-family guest is re-stamped here through
   * `buildMemberGuestConsentWrite` against the COPYING admin (MG4-D-a,
   * ADMIN_ASSIGNED), and the target is told about the new booking.
   *
   * Note that `copiedGuestInputs` above is built field by field from the source
   * rows and deliberately does NOT include the consent columns — that omission is
   * what makes the re-stamp the only possible outcome rather than a correction
   * applied on top.
   */
  const consentPlan = planMemberGuestConsentWrites({
    guests: normalizeBookingGuestInputs(
      copiedGuestInputs,
      linkedMembers,
    ) as DraftBookingGuestInput[],
    boundary: resolved.boundary,
    actor: memberGuestActor,
    now: new Date(),
    bookingCheckIn: newCheckIn,
    policy: memberGuestPolicy,
  });
  const guests = consentPlan.guests;

  const booking = await createDraftBooking({
    effectiveMemberId: source.memberId,
    isOnBehalf: true,
    sessionUserId: adminMemberId,
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests,
    notes: source.notes ?? undefined,
    expectedArrivalTime: source.expectedArrivalTime ?? undefined,
  });

  // AFTER the draft's transaction has committed. Awaited so a copy that could not
  // reach anybody has already been logged and audited by the time the caller
  // returns.
  const memberGuestRows = matchMemberGuestNotificationRows({
    createdGuests: booking.guests,
    entriesByMemberId: consentPlan.entriesByMemberId,
  });
  if (memberGuestRows.length > 0) {
    await sendMemberGuestAddNotifications({
      bookingId: booking.id,
      rows: memberGuestRows,
      actor: memberGuestActor,
    });
  }

  logAudit({
    action: "booking.copy.created",
    memberId: adminMemberId,
    targetId: booking.id,
    subjectMemberId: source.memberId,
    entityType: "Booking",
    entityId: booking.id,
    category: "booking",
    outcome: "success",
    summary: "Booking copied to draft",
    details: `Copied booking ${sourceBookingId} to draft booking ${booking.id}`,
    metadata: {
      sourceBookingId,
      copiedBookingId: booking.id,
      checkIn: formatDateOnly(newCheckIn),
      checkOut: formatDateOnly(newCheckOut),
      guestCount: guests.length,
    },
  });

  return {
    bookingId: booking.id,
    sourceBookingId,
    checkIn: formatDateOnly(newCheckIn),
    checkOut: formatDateOnly(newCheckOut),
    status: booking.status,
  };
}
