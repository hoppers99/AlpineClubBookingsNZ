import type { AgeTier, Prisma, PrismaClient } from "@prisma/client";
import {
  formatMemberProfileMissingField,
  getMemberProfileCompleteness,
  type MemberProfileCompletenessResult,
} from "@/lib/member-profile-completeness";
import {
  MEMBER_GUEST_WIDENING_ENABLED,
  type MemberGuestBoundaryScope,
  type MemberGuestBoundaryState,
} from "@/lib/member-guest-consent";

export type BookingGuestPricingInput = {
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: Date | string | null;
  stayEnd?: Date | string | null;
  // Explicit included nights (issue #713). When present, the guest stays
  // exactly these nights; stayStart/stayEnd become the derived envelope.
  nights?: ReadonlyArray<Date | string> | null;
};

export type BookingGuestInput = BookingGuestPricingInput & {
  firstName: string;
  lastName: string;
};

type BookingGuestAgeTierSource = {
  ageTier: AgeTier;
  member?: { ageTier: AgeTier } | null;
};

type BookingGuestLookupDb =
  | Pick<PrismaClient, "familyGroupMember" | "member">
  | Pick<Prisma.TransactionClient, "familyGroupMember" | "member">;

export type LinkedBookingMember = {
  id: string;
  ageTier: AgeTier;
  active?: boolean | null;
  canLogin?: boolean | null;
  firstName?: string | null;
  lastName?: string | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  dateOfBirth?: Date | null;
  streetAddressLine1?: string | null;
  streetAddressLine2?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalAddressLine2?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
  role?: string | null;
  accessRoles?: Array<{ role: string | null }>;
  profileCompletedAt?: Date | null;
  detailsConfirmedAt?: Date | null;
  detailsConfirmedByMemberId?: string | null;
  onboardingConfirmedAt?: Date | null;
};

export class BookingGuestValidationError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

const GUEST_PROFILE_REQUIRED_ERROR_CODE = "GUEST_PROFILE_REQUIRED";

export type BookingGuestProfileAction =
  | "complete_details"
  | "own_login_required"
  | "pending_admin_approval"
  | "contact_admin";

export type GuestProfileRequiredMember = {
  memberId: string;
  name: string;
  canCurrentUserResolve: boolean;
  needsOwnLoginConfirmation: boolean;
  missingFields: string[];
  action: BookingGuestProfileAction;
};

// test seam
export class BookingGuestProfileRequiredError extends BookingGuestValidationError {
  public code = GUEST_PROFILE_REQUIRED_ERROR_CODE;

  constructor(public members: GuestProfileRequiredMember[]) {
    super(
      "Some member guests need their details completed or confirmed before booking.",
      403
    );
  }

  toResponseBody() {
    return {
      code: this.code,
      error: this.message,
      members: this.members,
    };
  }
}

export type LinkedBookingMemberProfileGateContext = {
  actorRole?: string | null;
  onBehalfOfMemberId?: string | null;
};

function skipsMemberProfileGateForAdminOnBehalf(
  context?: LinkedBookingMemberProfileGateContext
) {
  return context?.actorRole === "ADMIN" && Boolean(context.onBehalfOfMemberId);
}

export function getBookingGuestValidationErrorResponse(
  error: BookingGuestValidationError
) {
  if (error instanceof BookingGuestProfileRequiredError) {
    return error.toResponseBody();
  }

  return { error: error.message };
}

function normalizeMemberIds(memberIds: Array<string | null | undefined>): string[] {
  return [...new Set(
    memberIds
      .map((memberId) => memberId?.trim())
      .filter((memberId): memberId is string => Boolean(memberId))
  )];
}

/**
 * Where each requested member sits relative to the booker's family boundary
 * ("+ Add Member Guest", epic #2305, MG1 #2306).
 *
 * The boundary is EXACTLY the set `getAllowedGuestMemberIds` already computes —
 * the booker plus every co-member of their family groups — so this introduces
 * no second, drifting definition of "family" and adds no extra query on the
 * authorized path: the caller computes it once and the authorization check
 * below reuses the same result.
 */
export async function computeMemberGuestBoundary(
  db: BookingGuestLookupDb,
  bookingMemberId: string,
  normalizedMemberIds: readonly string[],
): Promise<MemberGuestBoundaryState> {
  const allowedMemberIds = await getAllowedGuestMemberIds(db, bookingMemberId);
  const scopeByMemberId = new Map<string, MemberGuestBoundaryScope>();
  const beyondFamilyMemberIds: string[] = [];

  for (const memberId of normalizedMemberIds) {
    const scope: MemberGuestBoundaryScope = allowedMemberIds.has(memberId)
      ? "FAMILY"
      : "BEYOND_FAMILY";
    scopeByMemberId.set(memberId, scope);
    if (scope === "BEYOND_FAMILY") {
      beyondFamilyMemberIds.push(memberId);
    }
  }

  return { scopeByMemberId, beyondFamilyMemberIds };
}

export interface ResolvedLinkedBookingMembers {
  members: Map<string, LinkedBookingMember>;
  boundary: MemberGuestBoundaryState;
}

/**
 * `resolveLinkedBookingMembers`, plus the family-boundary state it computed.
 *
 * MG2 (#2307) switches the seven call sites onto this variant so each one can
 * persist the right `consentStatus` per guest. MG1 leaves every call site on the
 * map-only wrapper below, so this release changes no call-site code at all.
 *
 * THE STRUCTURAL RULE OF MG1, and the thing to check first in review: the
 * boundary is computed OUTSIDE the `skipAuthorization` branch, unconditionally,
 * on every path.
 *
 * SIX of the seven call-site files can pass `skipAuthorization: true`, not four
 * — three of them do it through a runtime flag rather than a literal, which is
 * how the earlier count missed them:
 *   * `admin-booking-copy.ts` hard-codes `true`;
 *   * `booking-modify-plan.ts` passes `role === "ADMIN"`;
 *   * `api/bookings/[id]/guests/route.ts` and
 *     `api/bookings/[id]/modify-quote/route.ts` pass `isAdmin`;
 *   * `api/bookings/route.ts` and `api/bookings/quote/route.ts` pass
 *     `isAuthorizedOnBehalf` (an admin or booking officer acting for a member).
 * Only `group-booking.ts` can never skip: it passes no options at all, which is
 * owner decision MG1-D-a.
 *
 * If the boundary were computed only where authorization is enforced, none of
 * those six would have a boundary value to persist the day MG2 goes live — and
 * the cheapest way to make the code compile would be to give them a null
 * consent status, i.e. to mint consent-free cross-family guest rows through
 * every admin and on-behalf path, permanently and silently. Computing it here
 * costs those paths two small `FamilyGroupMember` reads and removes that whole
 * failure mode.
 *
 * It also cannot be verified from behaviour: in this release the outcome is
 * identical either way, by design. So it is asserted directly — see
 * `member-guest-dark-guarantee.test.ts`, which reads the returned boundary on a
 * `skipAuthorization` call.
 */
export async function resolveLinkedBookingMembersWithBoundary(
  db: BookingGuestLookupDb,
  bookingMemberId: string,
  memberIds: Array<string | null | undefined>,
  options?: { skipAuthorization?: boolean }
): Promise<ResolvedLinkedBookingMembers> {
  const normalizedMemberIds = normalizeMemberIds(memberIds);

  if (normalizedMemberIds.length === 0) {
    return {
      members: new Map(),
      boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
    };
  }

  // Computed on EVERY path, admin included. Do not move this inside the
  // authorization branch below — see the note above.
  const boundary = await computeMemberGuestBoundary(
    db,
    bookingMemberId,
    normalizedMemberIds,
  );

  if (!options?.skipAuthorization) {
    // The refusal is gated on MEMBER_GUEST_WIDENING_ENABLED, not on the
    // memberGuests module flag: an admin switching the module on in this
    // release must change nothing, or they could strand capacity-holding
    // PENDING rows that no released code can resolve or expire. The error is
    // byte-for-byte the pre-existing one — same message, same 403 — so
    // module-on is not observable here and D-8's neutral refusal surface is
    // still MG2's to design.
    if (!MEMBER_GUEST_WIDENING_ENABLED && boundary.beyondFamilyMemberIds.length > 0) {
      throw new BookingGuestValidationError("Invalid guest member reference", 403);
    }
  }

  const members = await resolveLinkedMemberRecords(db, normalizedMemberIds);
  return { members, boundary };
}

export async function resolveLinkedBookingMembers(
  db: BookingGuestLookupDb,
  bookingMemberId: string,
  memberIds: Array<string | null | undefined>,
  options?: { skipAuthorization?: boolean }
): Promise<Map<string, LinkedBookingMember>> {
  const { members } = await resolveLinkedBookingMembersWithBoundary(
    db,
    bookingMemberId,
    memberIds,
    options,
  );
  return members;
}

async function resolveLinkedMemberRecords(
  db: BookingGuestLookupDb,
  normalizedMemberIds: string[],
): Promise<Map<string, LinkedBookingMember>> {
  const linkedMembers = await db.member.findMany({
    where: { id: { in: normalizedMemberIds }, active: true },
    select: {
      id: true,
      ageTier: true,
      active: true,
      canLogin: true,
      firstName: true,
      lastName: true,
      phoneCountryCode: true,
      phoneAreaCode: true,
      phoneNumber: true,
      dateOfBirth: true,
      streetAddressLine1: true,
      streetAddressLine2: true,
      streetCity: true,
      streetRegion: true,
      streetPostalCode: true,
      streetCountry: true,
      postalAddressLine1: true,
      postalAddressLine2: true,
      postalCity: true,
      postalRegion: true,
      postalPostalCode: true,
      postalCountry: true,
      role: true,
      accessRoles: { select: { role: true } },
      profileCompletedAt: true,
      detailsConfirmedAt: true,
      detailsConfirmedByMemberId: true,
      onboardingConfirmedAt: true,
    },
  });

  const linkedMemberMap = new Map(linkedMembers.map((member) => [member.id, member]));
  for (const memberId of normalizedMemberIds) {
    if (!linkedMemberMap.has(memberId)) {
      throw new BookingGuestValidationError("Linked member is inactive or not found", 400);
    }
  }

  // Guests are people with a real age tier. NOT_APPLICABLE is the age-exempt
  // tier (#1440, #2106): organisations/schools AND any age-exempt human account
  // (e.g. an admin on an age-exempt membership type) carry it. It has no season
  // rate, no age restrictions, and no bed-group semantics, so linking such an
  // account would silently misprice the booking. The attending people are
  // listed as guests instead.
  for (const member of linkedMemberMap.values()) {
    if (member.ageTier === "NOT_APPLICABLE") {
      throw new BookingGuestValidationError(
        "This account is age-exempt (N/A) and cannot be added as a booking guest. Add the people attending instead.",
        400
      );
    }
  }

  return linkedMemberMap;
}

function hasProfileGateFields(member: LinkedBookingMember) {
  return (
    "canLogin" in member &&
    "detailsConfirmedAt" in member &&
    "detailsConfirmedByMemberId" in member
  );
}

function getMemberDisplayName(member: LinkedBookingMember) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || "Member";
}

function getBlockedGuestAction(params: {
  member: LinkedBookingMember;
  status: MemberProfileCompletenessResult;
  currentUserId: string;
  canCurrentUserResolve: boolean;
}): BookingGuestProfileAction {
  const { member, status, currentUserId, canCurrentUserResolve } = params;

  if (status.confirmationMode === "not_allowed") {
    return "contact_admin";
  }

  if (member.canLogin === true && member.id !== currentUserId) {
    return "own_login_required";
  }

  if (canCurrentUserResolve) {
    return "complete_details";
  }

  if (status.needsOwnLoginConfirmation) {
    return "own_login_required";
  }

  return "contact_admin";
}

export async function assertLinkedBookingMembersCanBeBooked(
  db: BookingGuestLookupDb,
  linkedMembers: Map<string, LinkedBookingMember>,
  currentUserId: string,
  context?: LinkedBookingMemberProfileGateContext
) {
  if (skipsMemberProfileGateForAdminOnBehalf(context)) {
    return;
  }

  const members = [...linkedMembers.values()].filter(hasProfileGateFields);
  if (members.length === 0) {
    return;
  }

  const confirmerIds = normalizeMemberIds(
    members.map((member) => member.detailsConfirmedByMemberId)
  );
  const participantIds = normalizeMemberIds([
    currentUserId,
    ...members.map((member) => member.id),
    ...confirmerIds,
  ]);

  const [familyLinks, resolverMembers] = await Promise.all([
    db.familyGroupMember.findMany({
      where: { memberId: { in: participantIds } },
      select: { memberId: true, familyGroupId: true },
    }),
    db.member.findMany({
      where: { id: { in: normalizeMemberIds([currentUserId, ...confirmerIds]) }, active: true },
      select: { id: true, active: true, canLogin: true, ageTier: true },
    }),
  ]);

  const groupsByMemberId = new Map<string, Set<string>>();
  for (const link of familyLinks) {
    const groups = groupsByMemberId.get(link.memberId) ?? new Set<string>();
    groups.add(link.familyGroupId);
    groupsByMemberId.set(link.memberId, groups);
  }

  const resolverMemberMap = new Map(
    resolverMembers.map((member) => [member.id, member])
  );

  function sharesFamilyGroup(memberId: string, otherMemberId: string) {
    const groups = groupsByMemberId.get(memberId);
    const otherGroups = groupsByMemberId.get(otherMemberId);
    if (!groups || !otherGroups) {
      return false;
    }

    for (const groupId of groups) {
      if (otherGroups.has(groupId)) {
        return true;
      }
    }
    return false;
  }

  function isActiveLoginAdult(memberId: string) {
    const member = resolverMemberMap.get(memberId);
    return (
      member?.active === true &&
      member.canLogin === true &&
      member.ageTier === "ADULT"
    );
  }

  const blockedMembers: GuestProfileRequiredMember[] = [];

  for (const member of members) {
    const delegatedConfirmationValid =
      member.canLogin === false &&
      Boolean(member.detailsConfirmedByMemberId) &&
      isActiveLoginAdult(member.detailsConfirmedByMemberId!) &&
      sharesFamilyGroup(member.id, member.detailsConfirmedByMemberId!);

    const status = getMemberProfileCompleteness(member, {
      delegatedConfirmationValid,
    });

    if (status.canBeBookedAsMember) {
      continue;
    }

    const canCurrentUserConfirmDelegatedDetails =
      member.canLogin === false &&
      isActiveLoginAdult(currentUserId) &&
      sharesFamilyGroup(member.id, currentUserId);
    const canCurrentUserResolve =
      (member.canLogin === true && member.id === currentUserId) ||
      canCurrentUserConfirmDelegatedDetails;

    blockedMembers.push({
      memberId: member.id,
      name: getMemberDisplayName(member),
      canCurrentUserResolve,
      needsOwnLoginConfirmation: status.needsOwnLoginConfirmation,
      missingFields: status.missingFields.map(formatMemberProfileMissingField),
      action: getBlockedGuestAction({
        member,
        status,
        currentUserId,
        canCurrentUserResolve,
      }),
    });
  }

  if (blockedMembers.length > 0) {
    throw new BookingGuestProfileRequiredError(blockedMembers);
  }
}

async function getAllowedGuestMemberIds(
  db: BookingGuestLookupDb,
  bookingMemberId: string
): Promise<Set<string>> {
  const allowedMemberIds = new Set<string>([bookingMemberId]);
  const familyLinks = await db.familyGroupMember.findMany({
    where: { memberId: bookingMemberId },
    select: { familyGroupId: true },
  });

  const groupIds = familyLinks
    .map((link) => link.familyGroupId)
    .filter((familyGroupId): familyGroupId is string => Boolean(familyGroupId));

  if (groupIds.length === 0) {
    return allowedMemberIds;
  }

  const familyMembers = await db.familyGroupMember.findMany({
    where: { familyGroupId: { in: groupIds } },
    select: { memberId: true },
  });

  for (const familyMember of familyMembers) {
    if (familyMember.memberId) {
      allowedMemberIds.add(familyMember.memberId);
    }
  }

  return allowedMemberIds;
}

export function normalizeBookingGuestPricingInputs(
  guests: BookingGuestPricingInput[],
  linkedMembers: Map<string, LinkedBookingMember>
): BookingGuestPricingInput[] {
  return guests.map((guest) => {
    const memberId = guest.memberId?.trim();
    if (!memberId) {
      return { ...guest, isMember: false, memberId: undefined };
    }

    const linkedMember = linkedMembers.get(memberId);
    if (!linkedMember) {
      return { ...guest, isMember: false, memberId: undefined };
    }

    return {
      ...guest,
      ageTier: linkedMember.ageTier,
      isMember: true,
      memberId,
    };
  });
}

// Generic over the caller's parsed guest shape (bookable-tier zod inputs,
// #1440): linking a member can widen the tier to the member's stored AgeTier,
// so only the ageTier field is re-typed on the way out.
export function normalizeBookingGuestInputs<T extends BookingGuestInput>(
  guests: T[],
  linkedMembers: Map<string, LinkedBookingMember>
): Array<Omit<T, "ageTier"> & { ageTier: AgeTier }> {
  return guests.map((guest) => {
    const memberId = guest.memberId?.trim();
    if (!memberId) {
      return { ...guest, isMember: false, memberId: undefined };
    }

    const linkedMember = linkedMembers.get(memberId);
    if (!linkedMember) {
      return { ...guest, isMember: false, memberId: undefined };
    }

    return {
      ...guest,
      firstName: linkedMember.firstName || guest.firstName,
      lastName: linkedMember.lastName || guest.lastName,
      ageTier: linkedMember.ageTier,
      isMember: true,
      memberId,
    };
  });
}

export function getBookingGuestDisplayAgeTier(
  guest: BookingGuestAgeTierSource
): AgeTier {
  return (guest.member?.ageTier ?? guest.ageTier) as AgeTier;
}
