/**
 * Shared approval-pipeline core for the public non-member booking request flow
 * (src/lib/booking-request.ts, #707) and the SCHOOL group variant
 * (src/lib/school-booking-request.ts, #709).
 *
 * These two pipelines are deliberately separate — they confirm at different
 * booking statuses, invoice differently, and diverge on capacity re-checks — but
 * several regions of their approval transactions are byte-for-byte identical
 * (jscpd, min-tokens 70). Those exact clones live here so a fix to the idempotency
 * guard, the guest-row build + double-book checks, or the owner-substitution admin
 * alert cannot silently land in one pipeline and miss the other (#1529). Regions
 * that only look similar (the substitute/fresh Member creates, whose role and name
 * fields differ; the surrounding logger.warn/logAudit copy) are left in place.
 *
 * Behaviour-preserving: money stays integer cents, booking dates stay NZ
 * date-only, and every extracted region reproduces its original call sequence
 * and arguments exactly.
 */
import {
  AgeTier,
  BookingRequestStatus,
  Prisma,
  type BookingRequest,
} from "@prisma/client";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { computeMemberGuestBoundary } from "@/lib/booking-guests";
import { sendAdminOwnerSubstitutionAlert } from "@/lib/email";
import {
  planMemberGuestConsentWrites,
  type MemberGuestAddPolicy,
  type MemberGuestConsentGuestFields,
  type MemberGuestConsentWritePlan,
} from "@/lib/member-guest-add-policy";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import logger from "@/lib/logger";
import {
  assertMembershipTypeBookingAllowed,
  resolveGuestRateMembershipTypes,
} from "@/lib/membership-type-policy";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";

/** A held booking's owner failed re-validation and a fresh contact was
 * substituted at conversion (issue #1255 residual-risk decision 1). */
export type OwnerSubstitution = {
  invalidMemberId: string;
  substituteMemberId: string;
  reason: string;
};

/**
 * A guest row about to be created (or reassigned in place) on the converted
 * booking. Shared so the guest-build helper and reassignHeldBookingGuests agree
 * on one shape.
 */
export type HeldBookingGuestInput = {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  stayStart: Date;
  stayEnd: Date;
  priceCents: number;
  // Rate-membership-type snapshot (#1930, E4, D3): persisted on the guest row
  // so Xero line building reads the resolved type (an admin-linked member of a
  // custom MEMBER_RATE type keeps that type's item code) instead of relying on
  // the NULL-snapshot isMember fallback forever. Snapshot-only — request
  // prices are admin-set totals and stay exactly as stored.
  rateMembershipTypeId?: string | null;
};

/** Capacity nights that came back oversubscribed, as NZ date-only strings. */
export function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => night.date.toISOString().split("T")[0]);
}

/**
 * Idempotency guard (#1232 double-charge). Under the per-lodge advisory lock —
 * call this AFTER acquireLodgeCapacityLock and BEFORE the status-claim — observe
 * whether a prior approve already converted this request (a concurrent
 * double-accept, or a retry whose caller re-armed the request to PRICED after it
 * had already converted). If so, return the committed booking + owner ids so the
 * caller replays that conversion instead of creating a second booking; when the
 * status had been re-armed away from CONVERTED, re-assert the true terminal
 * status (we hold the lock). Returns null when no prior conversion exists.
 */
export async function claimAlreadyConvertedBookingRequest(
  tx: Prisma.TransactionClient,
  requestId: string
): Promise<{ convertedBookingId: string; convertedMemberId: string } | null> {
  const existing = await tx.bookingRequest.findUnique({
    where: { id: requestId },
    select: { convertedBookingId: true, convertedMemberId: true, status: true },
  });
  if (existing?.convertedBookingId && existing.convertedMemberId) {
    if (existing.status !== BookingRequestStatus.CONVERTED) {
      await tx.bookingRequest.update({
        where: { id: requestId },
        data: { status: BookingRequestStatus.CONVERTED, version: { increment: 1 } },
      });
    }
    return {
      convertedBookingId: existing.convertedBookingId,
      convertedMemberId: existing.convertedMemberId,
    };
  }
  return null;
}

/**
 * Build the converted booking's guest rows from the request guests + the
 * admin-linked member map + the per-guest price split, then run the two
 * pre-write guards both approval pipelines share:
 *   - membership-type booking policy (assertMembershipTypeBookingAllowed)
 *   - admin-mediated double-book prevention across overlapping nights
 *     (assertNoBookingMemberNightConflicts, #1158 / DOMAIN_INVARIANTS.md:35-40),
 *     excluding the held booking's own soon-to-be-deleted guests on the reuse path.
 * Runs inside the caller's approval transaction (tx holds the advisory lock).
 */
export async function buildApprovalGuestCreates(
  tx: Prisma.TransactionClient,
  params: {
    guests: Array<{ firstName: string; lastName: string; ageTier: AgeTier }>;
    linkedMembers: Map<number, string>;
    guestPriceCents: number[];
    checkIn: Date;
    checkOut: Date;
    adminMemberId: string;
    heldBookingId: string | null;
  }
): Promise<HeldBookingGuestInput[]> {
  const {
    guests,
    linkedMembers,
    guestPriceCents,
    checkIn,
    checkOut,
    adminMemberId,
    heldBookingId,
  } = params;

  const unratedGuestCreates = guests.map((guest, index) => {
    const memberId = linkedMembers.get(index);
    return {
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: Boolean(memberId),
      memberId,
      stayStart: checkIn,
      stayEnd: checkOut,
      priceCents: guestPriceCents[index],
    };
  });
  await assertMembershipTypeBookingAllowed(tx, {
    guests: unratedGuestCreates,
    seasonYear: getSeasonYear(checkIn),
    // Finding 2 (privacy re-review of MG3 #2308). Both approval pipelines are
    // admin-only — the converted booking has no member owner yet, which is also
    // why no family boundary could be computed here — so this keeps the detailed
    // refusal an approving officer needs to act on.
    skipAuthorization: true,
  });

  // Persist the rate-membership-type snapshot (#1930, E4, D3) at the same
  // season-year context the policy guard used: an admin-linked member of a
  // custom MEMBER_RATE type records that type; unlinked guests record the
  // built-in NON_MEMBER type. Prices are NOT touched — the admin-set split
  // above stays exactly as stored. rateSource is resolver-internal and is not
  // persisted on the guest row.
  const guestCreates: HeldBookingGuestInput[] = (
    await resolveGuestRateMembershipTypes(tx, {
      seasonYear: getSeasonYear(checkIn),
      guests: unratedGuestCreates,
    })
  ).map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId,
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    priceCents: guest.priceCents,
    rateMembershipTypeId: guest.rateMembershipTypeId,
  }));

  // Block admin-mediated double-books: a request whose guests an admin
  // linked to real members must not put a member on overlapping nights
  // (issue #1158, invariant DOMAIN_INVARIANTS.md:35-40). On the reuse path
  // exclude the held booking's own soon-to-be-deleted guests.
  await assertNoBookingMemberNightConflicts(tx, {
    actorMemberId: adminMemberId,
    actorRole: "ADMIN",
    checkIn,
    checkOut,
    guests: guestCreates,
    excludeBookingId: heldBookingId ?? undefined,
  });

  return guestCreates;
}

/**
 * MG4-D-b (#2309): decide the consent columns for a booking-request pipeline
 * guest list, and collect the notifications the caller owes after it commits.
 *
 * WHY THE PIPELINE NEEDS ITS OWN ENTRY POINT AT ALL. The other five guest-write
 * paths reach `planMemberGuestConsentWrites` through
 * `resolveLinkedBookingMembersWithBoundary`, which resolves member records AND
 * computes the family boundary in one call. This pipeline has already resolved
 * its members — an officer picked them by hand at quote time and
 * `assertLinkedMembersExist` validated them — so all it is missing is the
 * boundary. Calling the full resolver here would re-read every member for
 * nothing and would add an eighth entry to a census whose whole purpose is to
 * enumerate the paths that decide whether a beyond-family member may be
 * resolved. This path does not make that decision; the officer already did.
 *
 * THE BOUNDARY IS COMPUTED, NOT ASSUMED, and that is worth a sentence because
 * the shortcut is tempting. A converted booking's owner is normally a non-login
 * contact minted moments earlier, so every linked member is beyond-family by
 * construction and the answer could be hard-coded. But the owner may instead be
 * a mapped Organisation or School contact (#1255) that has existed for years and
 * could share a family group with a linked member — and, more importantly, a
 * hard-coded boundary is not a boundary. It costs two indexed reads.
 *
 * Returns the caller's guests with `memberGuestConsent` attached where it
 * applies. Callers must strip `crossFamilyMemberGuest` (a display marker, not a
 * column) before handing rows to Prisma.
 */
export async function planBookingRequestGuestConsent<
  Guest extends { memberId?: string | null },
>(
  tx: Prisma.TransactionClient,
  params: {
    bookingOwnerMemberId: string;
    guests: readonly Guest[];
    actor: MemberGuestAddActor;
    policy: MemberGuestAddPolicy;
    bookingCheckIn: Date;
    now?: Date;
  }
): Promise<MemberGuestConsentWritePlan<Guest>> {
  if (!params.policy.wideningEnabled) {
    // MODULE OFF — the shipped default (D-2), and the state most clubs stay in
    // forever. `planMemberGuestConsentWrites` already returns the guests
    // untouched in this case, so the two `FamilyGroupMember` reads below would
    // compute a boundary nothing then consults. Skipping them keeps a
    // non-adopting club's approval pipeline byte-for-byte the query sequence it
    // was before MG4 — the same reasoning the owner applied to
    // `markCrossFamilyGuestsOnBooking`'s gate.
    //
    // The call is still made, rather than skipped by the caller, so the module
    // decision lives in one place and the returned shape is identical either
    // way.
    return planMemberGuestConsentWrites({
      guests: params.guests,
      boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
      actor: params.actor,
      now: params.now ?? new Date(),
      bookingCheckIn: params.bookingCheckIn,
      policy: params.policy,
    });
  }

  const boundary = await computeMemberGuestBoundary(
    tx,
    params.bookingOwnerMemberId,
    params.guests
      .map((guest) => guest.memberId)
      .filter((memberId): memberId is string => Boolean(memberId))
  );
  return planMemberGuestConsentWrites({
    guests: params.guests,
    boundary,
    actor: params.actor,
    now: params.now ?? new Date(),
    bookingCheckIn: params.bookingCheckIn,
    policy: params.policy,
  });
}

/**
 * Strip the two MG2 planning fields off a planned guest row, leaving exactly the
 * Prisma-writable shape plus the consent columns.
 *
 * `crossFamilyMemberGuest` is a D-8 DISPLAY marker that never had a column, and
 * spreading a planned guest straight into `bookingGuest.create` would hand
 * Prisma an unknown field. Doing the strip in one named place means the three
 * pipeline write points cannot each forget it differently.
 */
export function toPipelineGuestCreateData<Guest extends object>(
  guest: Guest & MemberGuestConsentGuestFields
): Omit<Guest, keyof MemberGuestConsentGuestFields> {
  const { memberGuestConsent, crossFamilyMemberGuest, ...rest } = guest;
  void crossFamilyMemberGuest;
  return { ...rest, ...(memberGuestConsent ?? {}) } as Omit<
    Guest,
    keyof MemberGuestConsentGuestFields
  >;
}

/**
 * Fire-and-forget admin email alert that a held booking's owner was invalid at
 * conversion and a fresh non-login contact was substituted (F20 residual #2 /
 * #1377). Best-effort name lookups run outside the caller's transaction; ids are
 * the source of truth if a name is missing. A failed alert must NOT fail the
 * conversion (the booking is already committed), so it is caught and logged with
 * the caller-supplied message (each pipeline keeps its own log text).
 */
export async function sendOwnerSubstitutionAdminAlert(params: {
  request: Pick<
    BookingRequest,
    | "id"
    | "contactFirstName"
    | "contactLastName"
    | "contactEmail"
    | "checkIn"
    | "checkOut"
  >;
  bookingId: string;
  ownerSubstitution: OwnerSubstitution;
  failureLogMessage: string;
}): Promise<void> {
  const { request, bookingId, ownerSubstitution, failureLogMessage } = params;
  try {
    const [intendedMember, substituteMember] = await Promise.all([
      prisma.member
        .findUnique({
          where: { id: ownerSubstitution.invalidMemberId },
          select: { firstName: true, lastName: true },
        })
        .catch(() => null),
      prisma.member
        .findUnique({
          where: { id: ownerSubstitution.substituteMemberId },
          select: { firstName: true, lastName: true },
        })
        .catch(() => null),
    ]);
    const fullName = (
      member: { firstName?: string | null; lastName?: string | null } | null
    ): string | null => {
      const name = [member?.firstName, member?.lastName]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join(" ")
        .trim();
      return name.length > 0 ? name : null;
    };
    await sendAdminOwnerSubstitutionAlert({
      requestId: request.id,
      bookingId,
      intendedMemberId: ownerSubstitution.invalidMemberId,
      intendedMemberName: fullName(intendedMember),
      substituteMemberId: ownerSubstitution.substituteMemberId,
      substituteMemberName: fullName(substituteMember),
      reason: ownerSubstitution.reason,
      requesterName:
        `${request.contactFirstName} ${request.contactLastName}`.trim(),
      requesterEmail: request.contactEmail,
      checkIn: request.checkIn,
      checkOut: request.checkOut,
    });
  } catch (err) {
    logger.error(
      {
        err,
        bookingRequestId: request.id,
        bookingId,
      },
      failureLogMessage
    );
  }
}
