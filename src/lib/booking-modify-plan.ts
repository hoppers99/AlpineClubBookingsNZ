// Split out of src/lib/booking-modify.ts (issue #1138): the in-transaction
// modification pipeline — guest plan, repricing, promo changes, change fee,
// and guest/chore writes. Kept together because the booking-guest-profile
// gate contract test compares string indexes across this pipeline in one
// file. Code moved verbatim; import via the "@/lib/booking-modify" barrel.

import {
  AdminReviewStatus,
  BookingStatus,
  type AgeTier,
  type BookingGuest,
  type Prisma,
  type PromoCode,
  type Role,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import {
  buildInProgressGuestRangePlan,
  type BookingEditGuestRangePlan,
} from "@/lib/booking-edit-guest-ranges";
import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";
import {
  daysUntilDate,
  loadCancellationPolicy,
} from "@/lib/cancellation";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  checkCapacityForGuestRanges,
  checkCapacityForPartnerSharedAdmission,
} from "@/lib/capacity";
import {
  OverCapacityConfirmationRequiredError,
  overCapacityNights,
  wholeLodgeBlockedNights,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  resolveGuestRateMembershipTypes,
  assertMembershipTypeBookingAllowed,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import { toGroupDiscountConfig } from "@/lib/policies/booking-route-decisions";
import {
  deletePromoRedemptionAndAdjustCount,
  lockAndRefreshPromoCodeUsage,
  lockPromoCodeRowsForUpdate,
  redeemPromoCode,
  replacePromoRedemptionAllocations,
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import {
  describePromoCapCoverage,
  type PromoCoverageNotice,
} from "@/lib/promo-cap-coverage";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import { isLikelyTypoCorrection } from "@/lib/guest-name-similarity";
import {
  assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembersWithBoundary,
  type BookingGuestInput,
} from "@/lib/booking-guests";
import {
  planMemberGuestConsentWrites,
  type MemberGuestAddPolicy,
  type MemberGuestConsentGuestFields,
  type MemberGuestConsentWritePlanEntry,
} from "@/lib/member-guest-add-policy";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import {
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  normalizeDateOnlyForTimeZone,
} from "@/lib/date-only";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { getSeasonYear } from "@/lib/utils";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import {
  BookingModifyReviewJustificationRequiredError,
  getGuestStayRangeInputMap,
  hasGuestStayRangeInputs,
  hasStayRangeInput,
  isBookingFullyPaidForGuestNameEdits,
  normalizeRangeOrApiError,
  type BatchModifyInput,
  type LoadedBookingForModify,
  type LoadedPromoRedemption,
} from "@/lib/booking-modify-validation";

type ProposedGuestPricingInput = {
  bookingGuestId?: string | null;
  ageTier: AgeTier;
  isMember: boolean;
  memberId: string | null;
  stayStart: Date;
  stayEnd: Date;
  nights?: Date[];
};

type ProposedRemainingGuest = {
  guest: BookingGuest & { nights?: { stayDate: Date; priceCents?: number }[] };
  stayStart: Date;
  stayEnd: Date;
  nights?: Date[];
};

function normalizeRangesOrApiError<Guest extends { stayStart?: string | Date | null; stayEnd?: string | Date | null }>(
  guests: Guest[],
  booking: { checkIn: Date; checkOut: Date }
) {
  try {
    return normalizeGuestStayRanges(guests, booking);
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      throw new ApiError(error.message, 400);
    }
    throw error;
  }
}

/**
 * The guest's stored per-night prices, usable as `lockedNightPrices` (#1036).
 * Rows loaded without `priceCents` (or legacy guests without night rows)
 * yield no locks, so those nights price at current season rates.
 */
export function lockedNightPricesForGuest(guest: {
  nights?: { stayDate: Date; priceCents?: number }[];
}): Array<{ stayDate: Date; priceCents: number }> {
  return (guest.nights ?? []).flatMap((night) =>
    typeof night.priceCents === "number"
      ? [{ stayDate: night.stayDate, priceCents: night.priceCents }]
      : [],
  );
}

export type ResolvedGuestNameUpdate = {
  guestId: string;
  firstName: string;
  lastName: string;
  previousFirstName: string;
  previousLastName: string;
};

/**
 * Shown when a free-text non-member guest name edit on a fully-paid booking is
 * NOT an identity-preserving spelling correction (#1386). The paid-name lock
 * still blocks swapping in a different person; only typo fixes are exempt.
 */
export const PAID_NAME_TYPO_ONLY_MESSAGE =
  "Only spelling corrections are allowed after payment; to change who a booking is for, contact the office.";

function normalizeGuestName(value: string, fieldName: string) {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  if (!normalized) {
    throw new ApiError(`${fieldName} is required`, 400);
  }
  if (normalized.length > 100) {
    throw new ApiError(`${fieldName} must be 100 characters or fewer`, 400);
  }
  return normalized;
}

export function resolveGuestNameUpdates({
  booking,
  input,
  allowWhenFullyPaid = false,
  allowTypoFixWhenFullyPaid = false,
}: {
  booking: Pick<
    LoadedBookingForModify,
    "guests" | "status" | "finalPriceCents" | "payment"
  >;
  input: Pick<BatchModifyInput, "guestUpdates" | "removeGuestIds">;
  /**
   * Quoted (booking-request) bookings are exempt from the paid-name lock
   * (#1099): their guests are placeholder records ("School Child 1..N") and
   * replacing them with real attendee names before arrival is the intended
   * workflow — including after the school has paid its invoice.
   */
  allowWhenFullyPaid?: boolean;
  /**
   * Identity-only edits (no structural change) on a fully-paid booking may fix
   * an identity-preserving spelling TYPO on a free-text non-member guest
   * (#1386). Each changed name must pass {@link isLikelyTypoCorrection}; the
   * lock still rejects anything that could be a different person (a swap).
   * Ignored when {@link allowWhenFullyPaid} already lifts the lock (quoted
   * bookings), and irrelevant when the booking is not fully paid.
   */
  allowTypoFixWhenFullyPaid?: boolean;
}): ResolvedGuestNameUpdate[] {
  if (!input.guestUpdates?.length) {
    return [];
  }

  const fullyPaidLockActive =
    !allowWhenFullyPaid && isBookingFullyPaidForGuestNameEdits(booking);

  if (fullyPaidLockActive && !allowTypoFixWhenFullyPaid) {
    throw new ApiError(
      "Non-member guest names cannot be edited after the booking is fully paid",
      400,
    );
  }

  const removedGuestIds = new Set(input.removeGuestIds ?? []);
  const guestsById = new Map(booking.guests.map((guest) => [guest.id, guest]));
  const seenGuestIds = new Set<string>();
  const updates: ResolvedGuestNameUpdate[] = [];

  for (const update of input.guestUpdates) {
    if (seenGuestIds.has(update.guestId)) {
      throw new ApiError("Each guest can only be updated once", 400);
    }
    seenGuestIds.add(update.guestId);

    if (removedGuestIds.has(update.guestId)) {
      throw new ApiError(
        "A guest cannot be renamed and removed in the same change",
        400,
      );
    }

    const guest = guestsById.get(update.guestId);
    if (!guest) {
      throw new ApiError(
        "One or more guest updates referenced a guest not found on this booking",
        400,
      );
    }

    if (guest.isMember || guest.memberId) {
      throw new ApiError("Member guest names cannot be edited on a booking", 400);
    }

    const firstName = normalizeGuestName(update.firstName, "First name");
    const lastName = normalizeGuestName(update.lastName, "Last name");
    if (firstName === guest.firstName && lastName === guest.lastName) {
      continue;
    }

    // On a fully-paid booking the lock is only lifted for an identity-preserving
    // spelling correction (#1386); a name that could be a different person keeps
    // the hard reject so payment can't quietly transfer the booking.
    if (
      fullyPaidLockActive &&
      !isLikelyTypoCorrection(
        guest.firstName,
        guest.lastName,
        firstName,
        lastName,
      )
    ) {
      throw new ApiError(PAID_NAME_TYPO_ONLY_MESSAGE, 400);
    }

    updates.push({
      guestId: guest.id,
      firstName,
      lastName,
      previousFirstName: guest.firstName,
      previousLastName: guest.lastName,
    });
  }

  return updates;
}

export type GuestPlan = {
  remainingGuests: BookingGuest[];
  proposedRemainingGuests: ProposedRemainingGuest[];
  removedGuests: BookingGuest[];
  normalizedAddGuests:
    | Array<BookingGuestInput & MemberGuestConsentGuestFields>
    | undefined;
  guestsForPricing: ProposedGuestPricingInput[];
  /**
   * The cross-family member guests this modification adds, keyed by target member
   * id ("+ Add Member Guest", epic #2305, MG2 #2307). The batch service matches
   * these to the guest rows `applyGuestChanges` creates and sends the request or
   * notice AFTER the transaction commits — nothing in this file mails anybody.
   * Empty on every family-scope modification.
   */
  memberGuestEntries: Map<string, MemberGuestConsentWritePlanEntry>;
  totalGuestCount: number;
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  /**
   * Review-related fields to write to the booking after the modification.
   * Encapsulates four scenarios: rule clears (fields nulled), rule trips
   * for the first time on a member modification (justification captured,
   * adminReviewStatus = PENDING), rule trips on an admin modification
   * (auto-approved), rule already tripped (existing review state kept).
   */
  reviewUpdate: {
    requiresAdminReview: boolean;
    adminReviewReason: string | null;
    memberReviewJustification: string | null;
    adminReviewStatus: AdminReviewStatus | null;
    adminReviewNotes: string | null;
    adminReviewedById: string | null;
    adminReviewedAt: Date | null;
    /** When true, status must move to AWAITING_REVIEW unless already there. */
    parkForReview: boolean;
    /** When true, AWAITING_REVIEW should be released to PAYMENT_PENDING. */
    releaseFromReview: boolean;
  };
};

export async function prepareGuestPlan(
  tx: Prisma.TransactionClient,
  {
    booking,
    role,
    actorId,
    input,
    isInProgressEdit,
    editableFrom,
    newCheckIn,
    newCheckOut,
    memberGuestPolicy,
    now = new Date(),
  }: {
    booking: LoadedBookingForModify;
    role: Role;
    actorId: string;
    input: BatchModifyInput;
    isInProgressEdit: boolean;
    editableFrom: Date | null;
    newCheckIn: Date;
    newCheckOut: Date;
    /**
     * MG2 (#2307). Read by the caller BEFORE it opened this transaction — see the
     * ordering rule in `member-guest-add-policy.ts`. Optional so the existing
     * unit tests of this planner keep compiling; a missing policy is MG1's
     * behaviour, which is a refusal, not a silent consent-free add.
     */
    memberGuestPolicy?: MemberGuestAddPolicy;
    now?: Date;
  },
): Promise<GuestPlan> {
  // MG4-D-a, brought forward: `role === "ADMIN"` is exactly the condition that
  // passes `skipAuthorization`, so an admin modification adds a cross-family guest
  // consent-free and always-notify, stamped with the acting admin.
  const memberGuestActor: MemberGuestAddActor =
    role === "ADMIN" ? { kind: "ADMIN", adminMemberId: actorId } : { kind: "MEMBER" };
  const { members: linkedMembers, boundary } =
    await resolveLinkedBookingMembersWithBoundary(
      tx,
      booking.memberId,
      (input.addGuests ?? []).map((guest) => guest.memberId),
      {
        skipAuthorization: role === "ADMIN",
        memberGuestWideningEnabled: memberGuestPolicy?.wideningEnabled ?? false,
      },
    );
  await assertLinkedBookingMembersCanBeBooked(tx, linkedMembers, actorId, {
    actorRole: role,
    onBehalfOfMemberId: role === "ADMIN" ? booking.memberId : null,
    // D-8: a blocked cross-family member is refused neutrally.
    crossFamilyMemberIds: boundary.beyondFamilyMemberIds,
  });
  const consentPlan = planMemberGuestConsentWrites({
    guests: input.addGuests
      ? normalizeBookingGuestInputs(input.addGuests, linkedMembers).map((guest, index) => ({
          ...guest,
          stayStart: input.addGuests?.[index]?.stayStart ?? null,
          stayEnd: input.addGuests?.[index]?.stayEnd ?? null,
          nights: input.addGuests?.[index]?.nights ?? null,
        }))
      : [],
    boundary,
    actor: memberGuestActor,
    now,
    bookingCheckIn: newCheckIn,
    policy:
      memberGuestPolicy ?? {
        wideningEnabled: false,
        approvalRequired: true,
        pendingHoldExpiryDays: 0,
      },
  });
  const memberGuestEntries = consentPlan.entriesByMemberId;
  const normalizedAddGuests = input.addGuests ? consentPlan.guests : undefined;

  const removeSet = new Set(input.removeGuestIds ?? []);
  const remainingGuests = booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = booking.guests.filter((g) => removeSet.has(g.id));

  if (
    !isInProgressEdit &&
    remainingGuests.length === 0 &&
    (!normalizedAddGuests || normalizedAddGuests.length === 0)
  ) {
    throw new ApiError("Booking must have at least one guest", 400);
  }

  const hasRangeInputs = hasGuestStayRangeInputs(input);
  const datesChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime() ||
    newCheckOut.getTime() !== new Date(booking.checkOut).getTime();
  const existingRangeInputs = getGuestStayRangeInputMap(input);
  // Preserve an unedited guest's existing night set (issue #713) so editing
  // one guest (or only names/notes/promo) never collapses another guest's gaps.
  const existingNightsFor = (guest: BookingGuest & { nights?: { stayDate: Date }[] }) =>
    guest.nights && guest.nights.length > 0
      ? guest.nights.map((night) => night.stayDate)
      : undefined;

  const proposedRemainingGuests: ProposedRemainingGuest[] = remainingGuests.map((guest, index) => {
    if (!hasRangeInputs) {
      // A booking date change resets each guest to the full new range (existing
      // behaviour); otherwise keep the guest exactly as stored, gaps included.
      return datesChanged
        ? { guest, stayStart: newCheckIn, stayEnd: newCheckOut }
        : {
            guest,
            stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
            stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
            nights: existingNightsFor(guest),
          };
    }

    const rangeInput = existingRangeInputs.get(guest.id);
    const normalizedRange =
      rangeInput && hasStayRangeInput(rangeInput)
        ? normalizeRangeOrApiError(rangeInput, { checkIn: newCheckIn, checkOut: newCheckOut }, index)
        : {
            stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
            stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
            nights: existingNightsFor(guest),
          };

    return { guest, ...normalizedRange };
  });

  const normalizedAddGuestsWithRanges = normalizedAddGuests
    ? normalizeRangesOrApiError(normalizedAddGuests, {
        checkIn: newCheckIn,
        checkOut: newCheckOut,
      })
    : undefined;

  const guestsForPricing = [
    ...proposedRemainingGuests.map((entry) => ({
      bookingGuestId: entry.guest.id,
      ageTier: entry.guest.ageTier as AgeTier,
      isMember: entry.guest.isMember,
      memberId: entry.guest.memberId ?? null,
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
      nights: entry.nights,
      // Nights the guest already bought keep their booked price (#1036);
      // only nights outside the stored set price at current season rates.
      lockedNightPrices: lockedNightPricesForGuest(entry.guest),
    })),
    ...(normalizedAddGuestsWithRanges ?? []).map((g) => ({
      bookingGuestId: null,
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
      stayStart: g.stayStart,
      stayEnd: g.stayEnd,
      nights: g.nights,
      // D-8 (MG2 #2307): this list is rebuilt field by field, so the marker is
      // carried across explicitly — the in-transaction person-night guard below
      // reads it to refuse a cross-family clash neutrally.
      crossFamilyMemberGuest: g.crossFamilyMemberGuest,
    })),
  ];

  const totalGuestCount = guestsForPricing.length;
  const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
  const lodgeCapacity = await getLodgeCapacity(bookingLodgeId, tx);
  if (totalGuestCount > lodgeCapacity) {
    throw new ApiError(
      `A booking cannot exceed ${lodgeCapacity} guests`,
      400,
    );
  }

  await assertNoBookingMemberNightConflicts(tx, {
    actorMemberId: actorId,
    actorRole: role,
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests: guestsForPricing,
    excludeBookingId: booking.id,
  });

  const requiresAdminReview = requiresAdultSupervisionReview(guestsForPricing);
  const adminReviewReason = requiresAdminReview
    ? ADULT_SUPERVISION_REVIEW_REASON
    : null;

  const reviewUpdate = resolveModifyReviewUpdate({
    booking,
    role,
    actorId,
    nowFlagged: requiresAdminReview,
    memberReviewJustification: input.memberReviewJustification,
  });

  if (role !== "ADMIN") {
    const unpaidMemberGuests = await findUnpaidMemberGuestNames(tx, {
      bookingMemberId: booking.memberId,
      checkIn: isInProgressEdit && editableFrom ? editableFrom : newCheckIn,
      guests: normalizedAddGuests ?? [],
    });
    if (unpaidMemberGuests.length > 0) {
      throw new ApiError(
        `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
        403,
      );
    }
  }

  return {
    remainingGuests,
    proposedRemainingGuests,
    removedGuests,
    normalizedAddGuests: normalizedAddGuestsWithRanges,
    guestsForPricing,
    totalGuestCount,
    requiresAdminReview,
    adminReviewReason,
    reviewUpdate,
    memberGuestEntries,
  };
}

function resolveModifyReviewUpdate({
  booking,
  role,
  actorId,
  nowFlagged,
  memberReviewJustification,
}: {
  booking: LoadedBookingForModify;
  role: Role;
  actorId: string;
  nowFlagged: boolean;
  memberReviewJustification: string | undefined;
}): GuestPlan["reviewUpdate"] {
  const wasFlagged = booking.requiresAdminReview;
  const existingStatus = booking.adminReviewStatus;
  const justification = memberReviewJustification?.trim();

  if (!nowFlagged) {
    // Rule cleared. Wipe review state so the booking returns to the
    // normal lifecycle; if it was parked in AWAITING_REVIEW, release it.
    return {
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      adminReviewStatus: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      parkForReview: false,
      releaseFromReview: booking.status === "AWAITING_REVIEW",
    };
  }

  // Still flagged after modification. If review already happened (or is
  // pending), preserve it — admins should not be re-prompted for the same
  // booking just because the guest list shuffled.
  if (wasFlagged && existingStatus !== null) {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification:
        justification ?? booking.memberReviewJustification ?? null,
      adminReviewStatus: existingStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewedById: booking.adminReviewedById,
      adminReviewedAt: booking.adminReviewedAt,
      parkForReview: existingStatus === AdminReviewStatus.PENDING,
      releaseFromReview: false,
    };
  }

  // First time the rule has tripped on this booking.
  if (role === "ADMIN") {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: justification ?? null,
      adminReviewStatus: AdminReviewStatus.APPROVED,
      adminReviewNotes: "Approved at modification by admin.",
      adminReviewedById: actorId,
      adminReviewedAt: new Date(),
      parkForReview: false,
      releaseFromReview: false,
    };
  }

  if (!justification) {
    throw new BookingModifyReviewJustificationRequiredError();
  }

  return {
    requiresAdminReview: true,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    memberReviewJustification: justification,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    parkForReview: true,
    releaseFromReview: false,
  };
}

export async function loadActiveSeasonRates(
  tx: Prisma.TransactionClient,
  lodgeId: string,
): Promise<SeasonRateData[]> {
  const seasons = await tx.season.findMany({
    where: { active: true, ...lodgeNullTolerantScope(lodgeId) },
    include: { membershipTypeRates: true },
  });
  return seasons.map((s) => ({
    seasonId: s.id,
    startDate: s.startDate,
    endDate: s.endDate,
    rates: s.membershipTypeRates.map((r) => ({
      membershipTypeId: r.membershipTypeId,
      ageTier: r.ageTier,
      pricePerNightCents: r.pricePerNightCents,
    })),
  }));
}

export type PricingResult = {
  inProgressPlan: BookingEditGuestRangePlan | null;
  // Admin override (issue #1668): true when the target nights were over lodge
  // capacity and the admin confirmed the overbooking. Always false on the
  // normal (hard-blocked) path.
  capacityOverridden: boolean;
  newTotalPriceCents: number;
  priceBreakdown: {
    totalPriceCents: number;
    guests: Array<{ priceCents: number; perNightCents: number[]; nightDates: Date[] }>;
  };
  guestNightRates: Array<{
    bookingGuestId?: string | null;
    memberId: string | null;
    isMember: boolean;
    perNightRates: number[];
    nightDates?: Date[];
  }>;
};

/**
 * Build a per-night breakdown for a contiguous range by splitting the total
 * evenly across the nights, with any integer-cent remainder on the earliest
 * nights so the per-night sum equals the total exactly. Used by the
 * in-progress edit plan, which prices guests as scalar totals (issue #713).
 */
function splitContiguousNights(
  stayStart: Date,
  stayEnd: Date,
  totalCents: number
): { priceCents: number; perNightCents: number[]; nightDates: Date[] } {
  const nightDates = eachDateOnlyInRange(
    normalizeDateOnlyForTimeZone(stayStart),
    normalizeDateOnlyForTimeZone(stayEnd)
  );
  const count = nightDates.length;
  const perNightCents: number[] = [];
  if (count > 0) {
    const base = Math.floor(totalCents / count);
    const remainder = totalCents - base * count;
    for (let i = 0; i < count; i++) {
      perNightCents.push(base + (i < remainder ? 1 : 0));
    }
  }
  return { priceCents: totalCents, perNightCents, nightDates };
}

/**
 * Split a proposed guest set into admin-flagged partner-sharers and ordinary
 * guests (matched by memberId) and run the #1745 reserved-slot admission
 * check (#1746). Shared by the modify service (which throws on rejection)
 * and the modify-quote preview (which reports the outcome): one splitter, so
 * preview and apply can never disagree on who counts as a sharer.
 *
 * A flagged memberId that matches no proposed guest throws — a sharer flag
 * must always attach to a real member guest in the change. A member holding
 * several ranges (data error) matches once; later duplicates stay ordinary
 * so they cannot widen the shared claim.
 */
export async function resolvePartnerSharedCapacity(params: {
  lodgeId: string;
  rangeStart: Date;
  rangeEnd: Date;
  proposedRanges: Array<{
    stayStart?: Date | null;
    stayEnd?: Date | null;
    nights?: Date[];
    memberId?: string | null;
  }>;
  partnerSharedGuests: Array<{ memberId: string; partnerMemberId: string }>;
  excludeBookingId: string;
  tx?: Prisma.TransactionClient;
}): Promise<Awaited<ReturnType<typeof checkCapacityForPartnerSharedAdmission>>> {
  const sharerByMemberId = new Map(
    params.partnerSharedGuests.map((sharer) => [sharer.memberId, sharer]),
  );
  if (sharerByMemberId.size !== params.partnerSharedGuests.length) {
    // Two flags for one member would otherwise collapse last-wins; reject so
    // a malformed caller payload can never silently change which partner an
    // admission is checked against.
    throw new ApiError(
      "The same guest was flagged as a partner-sharer more than once.",
      400,
    );
  }
  const matchedSharerIds = new Set<string>();
  const ordinary: typeof params.proposedRanges = [];
  const sharers: Array<{
    range: (typeof params.proposedRanges)[number];
    memberId: string;
    partnerMemberId: string;
  }> = [];
  for (const range of params.proposedRanges) {
    const sharer = range.memberId ? sharerByMemberId.get(range.memberId) : undefined;
    if (sharer && !matchedSharerIds.has(sharer.memberId)) {
      matchedSharerIds.add(sharer.memberId);
      sharers.push({
        range,
        memberId: sharer.memberId,
        partnerMemberId: sharer.partnerMemberId,
      });
    } else {
      ordinary.push(range);
    }
  }
  if (matchedSharerIds.size !== sharerByMemberId.size) {
    throw new ApiError(
      "A guest flagged as a partner-sharer is not part of this change (they must be a member guest on the booking).",
      400,
    );
  }

  return checkCapacityForPartnerSharedAdmission(
    params.lodgeId,
    params.rangeStart,
    params.rangeEnd,
    ordinary,
    sharers,
    params.excludeBookingId,
    params.tx,
  );
}

export async function calculateModifiedPricing(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    isInProgressEdit,
    editableFrom,
    newCheckIn,
    newCheckOut,
    normalizedAddGuests,
    removeGuestIds,
    guestsForPricing,
    skipBookingLifecycleRules,
    seasonRateData,
    adminOverride = false,
    confirmOverCapacity = false,
    partnerSharedGuests = [],
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    isInProgressEdit: boolean;
    editableFrom: Date | null;
    newCheckIn: Date;
    newCheckOut: Date;
    normalizedAddGuests: BookingGuestInput[] | undefined;
    removeGuestIds: string[] | undefined;
    guestsForPricing: Array<{
      bookingGuestId?: string | null;
      ageTier: AgeTier;
      isMember: boolean;
      memberId: string | null;
      stayStart?: Date | null;
      stayEnd?: Date | null;
      nights?: Date[];
      lockedNightPrices?: ReadonlyArray<{
        stayDate: Date | string;
        priceCents: number;
      }> | null;
    }>;
    skipBookingLifecycleRules: boolean;
    seasonRateData: SeasonRateData[];
    // Admin override (issue #1668): under adminOverride, an over-capacity target
    // warns instead of hard-blocking — the write proceeds only when
    // confirmOverCapacity is set, and capacityOverridden is reported back.
    adminOverride?: boolean;
    confirmOverCapacity?: boolean;
    // Partner-shared admission (#1746, admin-only — routes must gate it):
    // each entry flags a proposed guest (matched by memberId) as the second
    // occupant of a shared double with their CONFIRMED partner. Capacity then
    // runs through checkCapacityForPartnerSharedAdmission — reserved slots
    // above the base ceiling, one per active DOUBLE (#1745) — instead of the
    // ordinary check. Fail-loud: a rejection throws with the check's reason
    // and never falls back to the #1668 overbook path (leave sharers
    // unflagged to overbook the blunt way).
    partnerSharedGuests?: Array<{ memberId: string; partnerMemberId: string }>;
  },
): Promise<PricingResult> {
  const seasonYear = getSeasonYear(newCheckIn);
  await assertMembershipTypeBookingAllowed(tx, {
    ownerMemberId: booking.memberId,
    guests: guestsForPricing,
    seasonYear,
  });

  const policyAdjustedGuestsForPricing = await resolveGuestRateMembershipTypes(tx, {
    seasonYear,
    guests: guestsForPricing,
  });
  const policyAdjustedAddGuests = normalizedAddGuests
    ? await resolveGuestRateMembershipTypes(tx, {
        seasonYear,
        guests: normalizedAddGuests,
      })
    : undefined;
  const policyAdjustedExistingGuests = await resolveGuestRateMembershipTypes(tx, {
    seasonYear,
    guests: booking.guests.map((guest) => ({
      ...guest,
      ageTier: guest.ageTier as AgeTier,
    })),
  });

  let inProgressPlan: BookingEditGuestRangePlan | null = null;
  if (isInProgressEdit && editableFrom) {
    inProgressPlan = buildInProgressGuestRangePlan({
      booking: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        totalPriceCents: booking.totalPriceCents,
        discountCents: booking.discountCents,
        promoAdjustmentCents: booking.promoAdjustmentCents,
        finalPriceCents: booking.finalPriceCents,
        guests: policyAdjustedExistingGuests,
      },
      editableFrom,
      newCheckOut,
      addGuests: policyAdjustedAddGuests,
      removeGuestIds,
      seasons: seasonRateData,
    });
  }

  const pricingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
  let capacity: Awaited<ReturnType<typeof checkCapacityForGuestRanges>>;
  let capacityOverridden = false;
  if (skipBookingLifecycleRules) {
    capacity = { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };
  } else if (partnerSharedGuests.length > 0) {
    // Partner-shared admission (#1746): fail-loud on any rejection — the
    // #1668 overbook path stays a deliberately separate, unflagged action.
    const shared = await resolvePartnerSharedCapacity({
      lodgeId: pricingLodgeId,
      // #2029: use the plan's capacityRangeStart (not editableFrom) so a
      // check-out-day extension's newly-occupied night is inside the checked
      // window; it equals editableFrom for every mid-stay / last-night edit.
      rangeStart:
        inProgressPlan && editableFrom
          ? inProgressPlan.capacityRangeStart
          : newCheckIn,
      rangeEnd: newCheckOut,
      proposedRanges:
        inProgressPlan && editableFrom
          ? inProgressPlan.capacityGuestRanges
          : policyAdjustedGuestsForPricing,
      partnerSharedGuests,
      excludeBookingId: bookingId,
      tx,
    });
    if (!shared.available) {
      throw new ApiError(
        shared.reason ?? "Not enough partner-shared capacity for these changes",
        400,
      );
    }
    capacity = {
      available: true,
      minAvailable: shared.minAvailable,
      nightDetails: shared.nightDetails,
    };
  } else {
    capacity =
      inProgressPlan && editableFrom
        ? await checkCapacityForGuestRanges(
            pricingLodgeId,
            // #2029: capacityRangeStart, not editableFrom — see the
            // partner-shared branch above; unchanged for mid-stay edits.
            inProgressPlan.capacityRangeStart,
            newCheckOut,
            inProgressPlan.capacityGuestRanges,
            bookingId,
            tx,
          )
        : await checkCapacityForGuestRanges(
            pricingLodgeId,
            newCheckIn,
            newCheckOut,
            policyAdjustedGuestsForPricing,
            bookingId,
            tx,
          );
    if (!capacity.available) {
      if (!adminOverride) {
        // Member / non-override path: a held night is unavailable exactly like a
        // full lodge (ADR-001 decision 6, issue #118) — no exclusive signal.
        throw new ApiError("Not enough beds available for these changes", 400);
      }
      if (!confirmOverCapacity) {
        throw new OverCapacityConfirmationRequiredError(overCapacityNights(capacity));
      }
      // Admin explicitly confirmed the overbooking. An exclusive hold is NOT
      // bypassable by the override (ADR-001 decision 5, issue #118) — refuse
      // before reporting capacityOverridden so no guest is admitted onto a held
      // night.
      const blocked = wholeLodgeBlockedNights(capacity);
      if (blocked.length > 0) {
        throw new WholeLodgeHoldBlockedError(blocked);
      }
      // proceed and report it so the caller can audit capacityOverridden.
      capacityOverridden = true;
    }
  }

  let priceBreakdown: PricingResult["priceBreakdown"];
  try {
    priceBreakdown = inProgressPlan
      ? {
          totalPriceCents: inProgressPlan.newTotalPriceCents,
          guests: [
            ...inProgressPlan.proposedExistingGuests.map((entry) =>
              splitContiguousNights(entry.stayStart, entry.stayEnd, entry.priceCents)
            ),
            ...inProgressPlan.proposedAddedGuests.map((entry) =>
              splitContiguousNights(entry.stayStart, entry.stayEnd, entry.priceCents)
            ),
          ],
        }
      : await priceBookingGuestsWithMembershipTypePolicy(tx, {
          ownerMemberId: booking.memberId,
          checkIn: newCheckIn,
          checkOut: newCheckOut,
          guests: policyAdjustedGuestsForPricing,
          seasons: seasonRateData,
          // Group discount applies to the newly priced nights (#1095); locked
          // nights keep their booked (discount-inclusive) prices regardless.
          groupDiscount: toGroupDiscountConfig(
            await tx.groupDiscountSetting.findUnique({
              where: { id: "default" },
            }),
          ),
          seasonYear,
        });
  } catch (error) {
    if (error instanceof MembershipTypeBookingPolicyError) {
      throw error;
    }
    throw new ApiError("No season rate found for the requested dates", 400);
  }

  const newTotalPriceCents = priceBreakdown.totalPriceCents;
  const guestNightRates = inProgressPlan
    ? []
    : guestsForPricing.map((guest, index) => ({
        memberId: guest.memberId ?? null,
        bookingGuestId: guest.bookingGuestId ?? null,
        isMember: guest.isMember,
        perNightRates: priceBreakdown.guests[index]?.perNightCents ?? [],
        // Dates the positional rates so internal work-party promos restrict
        // the discount to the event's night window — correct for gaps too.
        firstNight: guest.stayStart ?? newCheckIn,
        nightDates: priceBreakdown.guests[index]?.nightDates ?? [],
      }));

  return {
    inProgressPlan,
    capacityOverridden,
    newTotalPriceCents,
    priceBreakdown,
    guestNightRates,
  };
}

export type PromoChangeResult = {
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  promoRemoved: boolean;
  promoChanged: boolean;
  // #2390: set only when a usage cap stopped the promotion reaching somebody on
  // the repriced booking; null means everyone it applies to is covered.
  promoCoverage: PromoCoverageNotice | null;
};

function promoRequiresStoredGuestTargets(
  promo: PromoCode & { assignments: Array<{ memberId: string }> }
) {
  return promo.assignments.length > 0 && promo.assignedMembersOnlyOwnNights === false;
}

function selectedIndexesForStoredGuestTargets(
  redemption: LoadedPromoRedemption,
  guestNightRates: Array<{ bookingGuestId?: string | null }>
) {
  if (!promoRequiresStoredGuestTargets(redemption.promoCode)) {
    return undefined;
  }

  const targetIds = new Set((redemption.guestTargets ?? []).map((target) => target.bookingGuestId));
  if (targetIds.size === 0) {
    return guestNightRates.map((_, index) => index);
  }

  return guestNightRates
    .map((guest, index) => (guest.bookingGuestId && targetIds.has(guest.bookingGuestId) ? index : -1))
    .filter((index) => index >= 0);
}

function targetBookingGuestIdsForSelectedIndexes(
  guestNightRates: Array<{ bookingGuestId?: string | null }>,
  selectedGuestIndexes: number[] | undefined
) {
  if (!selectedGuestIndexes) return undefined;
  return selectedGuestIndexes
    .map((index) => guestNightRates[index]?.bookingGuestId)
    .filter((id): id is string => Boolean(id));
}

/**
 * Resolve a request's promo beneficiaries to positional indexes over the
 * priced guest list (#2266, MED-4).
 *
 * EXISTING guests are bound by `bookingGuestId`, never by position: the
 * pricing order is [remaining guests..., added guests...] as of APPLY time,
 * so a positional index chosen at preview time would be re-bound to whatever
 * that list happens to be when the save lands — a concurrent edit by another
 * session between preview and save would silently redeem the discount for
 * the wrong guest. An id that no longer resolves refuses loudly instead.
 *
 * TO-BE-ADDED guests have no id yet, so they alone remain positional —
 * relative to this same request's `addGuests` array, which nothing concurrent
 * can reorder.
 *
 * Shared by the apply path (applyPromoCodeChanges) and the modify-quote
 * preview so the two can never disagree about who a code covers.
 */
export function resolvePromoBeneficiarySelection({
  guestNightRates,
  addedGuestCount,
  promoGuestIds,
  promoAddedGuestIndexes,
}: {
  /** Priced guests in apply order: remaining (with ids) then added (no ids). */
  guestNightRates: Array<{ bookingGuestId?: string | null }>;
  /** How many TO-BE-ADDED guests sit at the tail of guestNightRates. */
  addedGuestCount: number;
  promoGuestIds?: string[];
  promoAddedGuestIndexes?: number[];
}): number[] | undefined {
  if (!promoGuestIds?.length && !promoAddedGuestIndexes?.length) {
    return undefined;
  }

  const indexByGuestId = new Map<string, number>();
  guestNightRates.forEach((guest, index) => {
    if (guest.bookingGuestId) indexByGuestId.set(guest.bookingGuestId, index);
  });

  const selected = new Set<number>();
  for (const guestId of promoGuestIds ?? []) {
    const index = indexByGuestId.get(guestId);
    if (index === undefined) {
      throw new ApiError(
        "A guest selected for the promo code is no longer on this booking — refresh and re-apply the code",
        400,
      );
    }
    selected.add(index);
  }

  const addedStartIndex = guestNightRates.length - addedGuestCount;
  for (const addedIndex of promoAddedGuestIndexes ?? []) {
    if (
      !Number.isInteger(addedIndex) ||
      addedIndex < 0 ||
      addedIndex >= addedGuestCount
    ) {
      throw new ApiError(
        "A guest selected for the promo code is not part of this change",
        400,
      );
    }
    selected.add(addedStartIndex + addedIndex);
  }

  return [...selected].sort((a, b) => a - b);
}

export async function applyPromoCodeChanges(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    input,
    inProgressPlan,
    newCheckIn,
    newTotalPriceCents,
    guestNightRates,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    input: BatchModifyInput;
    inProgressPlan: BookingEditGuestRangePlan | null;
    newCheckIn: Date;
    newTotalPriceCents: number;
    guestNightRates: Array<{
      bookingGuestId?: string | null;
      memberId: string | null;
      isMember: boolean;
      perNightRates: number[];
    }>;
  },
): Promise<PromoChangeResult> {
  if (inProgressPlan) {
    return {
      newDiscountCents: inProgressPlan.newDiscountCents,
      newPromoAdjustmentCents: inProgressPlan.newPromoAdjustmentCents,
      promoRemoved: false,
      promoChanged: false,
      // An in-progress plan reuses prices already agreed; it re-runs no cap.
      promoCoverage: null,
    };
  }

  let newDiscountCents = 0;
  let newPromoAdjustmentCents = 0;
  let promoRemoved = false;
  let promoChanged = false;
  let promoCoverage: PromoCoverageNotice | null = null;
  const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));

  // Row-lock every promo code whose usage caps this transaction may charge or
  // refund, BEFORE the first cap read and the first counter write (#2299).
  // Booking creation has locked its promo row for a long time; none of the four
  // modification paths did, so two concurrent modifications could both pass a
  // "one use left" check. (The other three now take the same lock via
  // `lockAndRefreshPromoCodeUsage`; this one may touch TWO codes, so it uses the
  // multi-id form.) `lockPromoCodeRowsForUpdate` sorts the ids, so the outgoing
  // and incoming codes of a swap are always taken in the same global order and
  // no two transactions can build a cycle.
  const incomingPromoCodeId =
    input.promoCode && !input.removePromoCode
      ? (
          await tx.promoCode.findUnique({
            where: { code: input.promoCode.toUpperCase().trim() },
            select: { id: true },
          })
        )?.id
      : undefined;
  await lockPromoCodeRowsForUpdate(tx, [
    booking.promoRedemption?.promoCodeId,
    incomingPromoCodeId,
  ]);

  if (input.removePromoCode && booking.promoRedemption) {
    await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
    promoRemoved = true;
  }

  if (input.promoCode && !input.removePromoCode) {
    if (booking.promoRedemption && !promoRemoved) {
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
      promoRemoved = true;
    }

    // Re-read under the lock taken above, so the caps this validation sees are
    // the caps the redemption below consumes.
    const promoCode = await tx.promoCode.findUnique({
      where: { code: input.promoCode.toUpperCase().trim() },
      include: {
        assignments: { select: { memberId: true } },
        lodges: { select: { lodgeId: true } },
      },
    });

    // Internal promos (work party events) cannot be entered as codes.
    if (!promoCode || promoCode.internal) {
      throw new ApiError("Promo code not found", 400);
    }

    const assignedMemberIds = promoCode.assignments.length
      ? promoCode.assignments.map((assignment) => assignment.memberId)
      : null;
    const application = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        memberId: booking.memberId,
        bookingCheckIn: newCheckIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      assignedMemberIds,
      {
        excludeBookingId: bookingId,
        db: tx,
        // #2266 (MED-4): existing beneficiaries arrive bound by bookingGuestId
        // and are resolved against THIS transaction's priced guest list, so a
        // concurrent edit can never re-point the discount; stale ids 400.
        selectedGuestIndexes: resolvePromoBeneficiarySelection({
          guestNightRates,
          addedGuestCount: input.addGuests?.length ?? 0,
          promoGuestIds: input.promoGuestIds,
          promoAddedGuestIndexes: input.promoAddedGuestIndexes,
        }),
        lodgeId: bookingLodgeId,
      },
    );
    if (application.error || !application.discount) {
      throw new ApiError(application.error ?? "Promo code could not be applied", 400);
    }

    const promoResult = application.discount;
    newDiscountCents = promoResult.discountCents;
    newPromoAdjustmentCents = promoResult.priceAdjustmentCents;

    if (shouldPersistPromoRedemption(promoResult)) {
      await redeemPromoCode(
        tx,
        promoCode.id,
        bookingId,
        booking.memberId,
        newDiscountCents,
        newPromoAdjustmentCents,
        promoResult.freeNightsUsed,
        promoResult.eligibleGuestCount,
        promoResult.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
        bookingLodgeId,
      );
    }
    promoChanged = true;
  } else if (
    !input.removePromoCode &&
    !promoRemoved &&
    booking.promoRedemption?.promoCode
  ) {
    // The lock is already held (taken above for both codes of a possible swap),
    // but this snapshot was loaded with the booking, BEFORE it — so re-read the
    // usage counter under the lock. Locking and then deciding against a number
    // read outside the lock would leave the race open (#2299).
    const promo = await lockAndRefreshPromoCodeUsage(
      tx,
      booking.promoRedemption.promoCode
    );
    const selectedGuestIndexes = selectedIndexesForStoredGuestTargets(
      booking.promoRedemption,
      guestNightRates
    );
    const application = await validateAndCalculatePromoDiscount(
      promo,
      {
        memberId: booking.memberId,
        bookingCheckIn: newCheckIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      promo.assignments.length > 0
        ? promo.assignments.map((assignment) => assignment.memberId)
        : null,
      {
        excludeBookingId: bookingId,
        db: tx,
        selectedGuestIndexes,
        lodgeId: bookingLodgeId,
        // #2390: the reprice branch keeps the code the booking already has, so
        // a cap must narrow who it covers rather than refuse the whole edit.
        // The swap branch above deliberately does NOT do this: there the member
        // is applying a code, nobody holds a discount from it yet, and "this
        // code is full" is the honest answer.
        capOverflow: "coverExisting",
      },
    );

    if (application.error || !application.discount) {
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
      promoRemoved = true;
    } else {
      const promoResult = application.discount;
      newDiscountCents = promoResult.discountCents;
      newPromoAdjustmentCents = promoResult.priceAdjustmentCents;
      promoCoverage = await describePromoCapCoverage(tx, {
        promoCode: promo.code,
        capCoverage: application.capCoverage,
      });

      await replacePromoRedemptionAllocations(
        tx,
        booking.promoRedemption,
        newDiscountCents,
        newPromoAdjustmentCents,
        promoResult.freeNightsUsed,
        promoResult.eligibleGuestCount,
        promoResult.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
      );
    }
  }

  return {
    newDiscountCents,
    newPromoAdjustmentCents,
    promoRemoved,
    promoChanged,
    promoCoverage,
  };
}

export async function calculateModificationChangeFee({
  booking,
  newCheckIn,
  checkInChanged,
  skipBookingLifecycleRules,
}: {
  booking: LoadedBookingForModify;
  newCheckIn: Date;
  checkInChanged: boolean;
  skipBookingLifecycleRules: boolean;
}): Promise<number> {
  if (skipBookingLifecycleRules || !checkInChanged) {
    return 0;
  }
  // #2266: no change fee on a DRAFT — nothing has been committed to, exactly
  // like moving the dates in the wizard before saving. Member draft edits do
  // not take the admin skip above, so the guard must be explicit.
  if (booking.status === BookingStatus.DRAFT) {
    return 0;
  }
  const now = new Date();
  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId);
  const feeResult = calculateChangeFee({
    daysUntilOriginalCheckIn: daysUntilDate(booking.checkIn, now),
    daysUntilNewCheckIn: daysUntilDate(newCheckIn, now),
    originalFinalPriceCents: booking.finalPriceCents,
    policyRules: policy,
  });
  return feeResult.feeCents;
}

export async function applyGuestChanges(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    newCheckIn,
    newCheckOut,
    removedGuests,
    remainingGuests,
    proposedRemainingGuests,
    normalizedAddGuests,
    guestNameUpdates,
    priceBreakdown,
    inProgressPlan,
  }: {
    bookingId: string;
    newCheckIn: Date;
    newCheckOut: Date;
    removedGuests: BookingGuest[];
    remainingGuests: BookingGuest[];
    proposedRemainingGuests: ProposedRemainingGuest[];
    // Carries the MG2 consent columns straight from `prepareGuestPlan` (#2307).
    normalizedAddGuests:
      | Array<BookingGuestInput & MemberGuestConsentGuestFields>
      | undefined;
    guestNameUpdates?: ResolvedGuestNameUpdate[];
    priceBreakdown: PricingResult["priceBreakdown"];
    inProgressPlan: BookingEditGuestRangePlan | null;
  },
): Promise<{ createdGuests: BookingGuest[] }> {
  const createdGuests: BookingGuest[] = [];
  const nameUpdatesByGuestId = new Map(
    (guestNameUpdates ?? []).map((update) => [update.guestId, update]),
  );

  type BreakdownGuest = { nightDates: Date[]; perNightCents: number[] };

  // Re-sync a guest's BookingGuestNight rows to the priced nights (issue #713),
  // and return the matching stayStart/stayEnd envelope. Called on every guest
  // write so a guest's gaps are persisted and stale nights never linger.
  const syncGuestNights = async (
    bookingGuestId: string,
    bg: BreakdownGuest | undefined,
    fallbackStart: Date,
    fallbackEnd: Date,
  ): Promise<{ stayStart: Date; stayEnd: Date }> => {
    await tx.bookingGuestNight.deleteMany({ where: { bookingGuestId } });
    const nightDates = bg?.nightDates ?? [];
    if (nightDates.length > 0) {
      await tx.bookingGuestNight.createMany({
        data: nightDates.map((stayDate, k) => ({
          bookingGuestId,
          stayDate,
          priceCents: bg?.perNightCents[k] ?? 0,
        })),
      });
      return {
        stayStart: nightDates[0],
        stayEnd: addDaysDateOnly(nightDates[nightDates.length - 1], 1),
      };
    }
    return { stayStart: fallbackStart, stayEnd: fallbackEnd };
  };

  if (inProgressPlan) {
    const existingCount = inProgressPlan.proposedExistingGuests.length;
    for (let e = 0; e < existingCount; e++) {
      const entry = inProgressPlan.proposedExistingGuests[e];
      const nameUpdate = nameUpdatesByGuestId.get(entry.guest.id);
      const envelope = await syncGuestNights(
        entry.guest.id,
        priceBreakdown.guests[e],
        entry.stayStart,
        entry.stayEnd,
      );
      await tx.bookingGuest.update({
        where: { id: entry.guest.id },
        data: {
          ...(nameUpdate
            ? {
                firstName: nameUpdate.firstName,
                lastName: nameUpdate.lastName,
              }
            : {}),
          stayStart: envelope.stayStart,
          stayEnd: envelope.stayEnd,
          priceCents: entry.priceCents,
        },
      });
    }

    for (let a = 0; a < inProgressPlan.proposedAddedGuests.length; a++) {
      const entry = inProgressPlan.proposedAddedGuests[a];
      const g = entry.guest;
      const guest = await tx.bookingGuest.create({
        data: {
          bookingId,
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier,
          isMember: g.isMember,
          memberId: g.memberId || null,
          stayStart: entry.stayStart,
          stayEnd: entry.stayEnd,
          priceCents: entry.priceCents,
          // Persist the resolved rate-type snapshot on the added guest (#1930,
          // E4).
          rateMembershipTypeId: g.rateMembershipTypeId,
          // Member-guest consent (MG2 #2307), decided by
          // `buildMemberGuestConsentWrite` and spread only when present, so a
          // family-scope or non-member guest writes exactly what it wrote before.
          ...(g.memberGuestConsent ?? {}),
        },
      });
      const envelope = await syncGuestNights(
        guest.id,
        priceBreakdown.guests[existingCount + a],
        entry.stayStart,
        entry.stayEnd,
      );
      if (
        envelope.stayStart.getTime() !== guest.stayStart.getTime() ||
        envelope.stayEnd.getTime() !== guest.stayEnd.getTime()
      ) {
        await tx.bookingGuest.update({
          where: { id: guest.id },
          data: { stayStart: envelope.stayStart, stayEnd: envelope.stayEnd },
        });
      }
      createdGuests.push(guest);
    }

    return { createdGuests };
  }

  for (const guest of removedGuests) {
    await tx.choreAssignment.deleteMany({
      where: { bookingGuestId: guest.id },
    });
    // BookingGuestNight rows cascade-delete with the guest.
    await tx.bookingGuest.delete({ where: { id: guest.id } });
  }

  const addedGuestStartIndex = remainingGuests.length;
  const addList = normalizedAddGuests ?? [];
  for (let i = 0; i < addList.length; i++) {
    const g = addList[i];
    const guestPriceIndex = addedGuestStartIndex + i;
    const bg = priceBreakdown.guests[guestPriceIndex];
    const guest = await tx.bookingGuest.create({
      data: {
        bookingId,
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId || null,
        stayStart: g.stayStart ?? newCheckIn,
        stayEnd: g.stayEnd ?? newCheckOut,
        priceCents: bg.priceCents,
        // Persist the resolved rate-type snapshot on the added guest (#1930,
        // E4).
        rateMembershipTypeId: (bg as { rateMembershipTypeId?: string | null })
          .rateMembershipTypeId,
        // Member-guest consent (MG2 #2307) — see the in-progress branch above.
        ...(g.memberGuestConsent ?? {}),
      },
    });
    const envelope = await syncGuestNights(
      guest.id,
      bg,
      newCheckIn,
      newCheckOut,
    );
    if (
      envelope.stayStart.getTime() !== guest.stayStart.getTime() ||
      envelope.stayEnd.getTime() !== guest.stayEnd.getTime()
    ) {
      await tx.bookingGuest.update({
        where: { id: guest.id },
        data: { stayStart: envelope.stayStart, stayEnd: envelope.stayEnd },
      });
    }
    createdGuests.push(guest);
  }

  for (let i = 0; i < remainingGuests.length; i++) {
    const proposedRange = proposedRemainingGuests[i];
    const nameUpdate = nameUpdatesByGuestId.get(remainingGuests[i].id);
    const envelope = await syncGuestNights(
      remainingGuests[i].id,
      priceBreakdown.guests[i],
      proposedRange?.stayStart ?? newCheckIn,
      proposedRange?.stayEnd ?? newCheckOut,
    );
    await tx.bookingGuest.update({
      where: { id: remainingGuests[i].id },
      data: {
        ...(nameUpdate
          ? {
              firstName: nameUpdate.firstName,
              lastName: nameUpdate.lastName,
            }
          : {}),
        stayStart: envelope.stayStart,
        stayEnd: envelope.stayEnd,
        priceCents: priceBreakdown.guests[i].priceCents,
        // Overwrite the rate-type snapshot on the full-reprice path (#1930,
        // E4). The in-progress-edit path builds guests without a snapshot, so
        // this is undefined there and Prisma leaves the stored snapshot
        // untouched — matching D5's "locked nights keep their stale snapshot".
        rateMembershipTypeId: (
          priceBreakdown.guests[i] as { rateMembershipTypeId?: string | null }
        ).rateMembershipTypeId,
      },
    });
  }

  return { createdGuests };
}

export async function applyChoreCleanup(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    newCheckIn,
    newCheckOut,
    datesChanged,
  }: {
    bookingId: string;
    newCheckIn: Date;
    newCheckOut: Date;
    datesChanged: boolean;
  },
): Promise<string[]> {
  let choreWarnings: string[] = [];
  if (datesChanged) {
    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      bookingId,
      newCheckIn,
      newCheckOut,
    );
    choreWarnings = result.choreWarnings;
  }
  const rangeCleanup = await cleanupChoreAssignmentsForGuestStayRanges(
    tx,
    bookingId,
  );
  return [...choreWarnings, ...rangeCleanup.choreWarnings];
}
