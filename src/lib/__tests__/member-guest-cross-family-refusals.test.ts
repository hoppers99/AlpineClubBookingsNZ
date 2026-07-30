// "+ Add Member Guest" (epic #2305) MG2 (#2307) — OWNER DECISION D-8.
//
// MG2 is the release in which a cross-family memberId first gets past
// authorization, which makes three previously-harmless refusals reachable by
// anybody who can call the booking API, against a member the caller may never have
// met. Each one described that member in detail. This file pins the collapse.
//
// WHAT "COLLAPSE" HAS TO MEAN TO BE WORTH ANYTHING. It is not enough that each
// refusal stops naming the member: the three must become INDISTINGUISHABLE from
// one another. If the unpaid-subscription case returned a different message, or a
// different status, from the person-night case, a caller could still read a
// stranger's financial state off the shape of the refusal. So the last test in
// this file asserts all three produce the same message and the same status, and
// each individual test asserts the detailed FAMILY-scope behaviour is untouched —
// a member adding their own child still gets told exactly which field is missing.
import { describe, expect, it, vi } from "vitest";

// Subscription enforcement is a club/Xero-state question that has nothing to do
// with D-8; forcing it ON is what makes the third refusal reachable in a unit test
// at all. Everything else in this file runs against the real implementations.
vi.mock("@/lib/member-subscription-eligibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/member-subscription-eligibility")>()),
  isSubscriptionEnforcementActive: vi.fn().mockResolvedValue(true),
}));
// The membership-type policy resolver needs far more of the schema than this
// unit test stubs; an empty map means "no type-level exemption", which is the
// case that reaches the refusal.
vi.mock("@/lib/membership-type-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/membership-type-policy")>()),
  resolveMembershipTypePoliciesForMembers: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/age-tier", () => ({
  getAgeTierSettings: vi.fn().mockResolvedValue([
    {
      tier: "ADULT",
      minAge: 18,
      maxAge: null,
      label: "Adult",
      subscriptionRequiredForBooking: true,
      sortOrder: 0,
    },
  ]),
}));

import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestProfileRequiredError,
  BookingGuestValidationError,
  type LinkedBookingMember,
} from "@/lib/booking-guests";
import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";
import { findBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE } from "@/lib/member-guest-refusal";
import { parseDateOnly } from "@/lib/date-only";

const BOOKER = "m-booker";
const CHILD = "m-child";
const OUTSIDER = "m-outsider";

const CHECK_IN = parseDateOnly("2026-09-10");
const CHECK_OUT = parseDateOnly("2026-09-12");

// ---------------------------------------------------------------------------
// 1. The profile-completeness gate
// ---------------------------------------------------------------------------

/** A member who cannot be booked: no login of their own, nothing confirmed. */
function incompleteMember(id: string): LinkedBookingMember {
  return {
    id,
    ageTier: "ADULT",
    active: true,
    canLogin: false,
    firstName: "Dana",
    lastName: "Doe",
    profileCompletedAt: null,
    detailsConfirmedAt: null,
    detailsConfirmedByMemberId: null,
    onboardingConfirmedAt: null,
  };
}

function profileGateDb() {
  return {
    familyGroupMember: { findMany: async () => [] },
    member: { findMany: async () => [] },
  } as unknown as Parameters<typeof assertLinkedBookingMembersCanBeBooked>[0];
}

describe("D-8 leak 1 — the profile-completeness gate", () => {
  it("collapses to the neutral refusal for a cross-family target, disclosing nothing about them", async () => {
    const error = await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([[OUTSIDER, incompleteMember(OUTSIDER)]]),
      BOOKER,
      { crossFamilyMemberIds: [OUTSIDER] },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BookingGuestValidationError);
    // Not the detailed body: that shape carries name, missingFields and canLogin.
    expect(error).not.toBeInstanceOf(BookingGuestProfileRequiredError);
    const refusal = error as BookingGuestValidationError;
    expect(refusal.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(refusal.status).toBe(403);
    // Nothing about the member survives anywhere in the error.
    const serialised = JSON.stringify({
      message: refusal.message,
      ...(refusal as unknown as Record<string, unknown>),
    });
    expect(serialised).not.toContain("Dana");
    expect(serialised).not.toContain("Doe");
    expect(serialised).not.toContain("canLogin");
  });

  it("keeps the detailed, actionable error for a family-scope target", async () => {
    const error = await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([[CHILD, incompleteMember(CHILD)]]),
      BOOKER,
      // No cross-family ids: everybody requested is inside the booker's family.
      { crossFamilyMemberIds: [] },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BookingGuestProfileRequiredError);
    const detailed = error as BookingGuestProfileRequiredError;
    expect(detailed.members[0].name).toBe("Dana Doe");
    expect(detailed.members[0].missingFields.length).toBeGreaterThan(0);
  });

  it("a cross-family target wins over a family one blocked in the same request", async () => {
    // Reporting the family member in full while staying silent about the stranger
    // would leak by omission, and a caller could read the same oracle one id at a
    // time.
    const error = await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([
        [CHILD, incompleteMember(CHILD)],
        [OUTSIDER, incompleteMember(OUTSIDER)],
      ]),
      BOOKER,
      { crossFamilyMemberIds: [OUTSIDER] },
    ).catch((err: unknown) => err);

    expect(error).not.toBeInstanceOf(BookingGuestProfileRequiredError);
    expect((error as BookingGuestValidationError).message).toBe(
      MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
    );
  });

  it("is unreachable when nothing is blocked, cross-family or not", async () => {
    await expect(
      assertLinkedBookingMembersCanBeBooked(
        profileGateDb(),
        new Map(),
        BOOKER,
        { crossFamilyMemberIds: [OUTSIDER] },
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. The person-night conflict
// ---------------------------------------------------------------------------

function conflictDb(conflictMemberId: string) {
  return {
    bookingGuest: {
      findMany: async () => [
        {
          id: "bg-other",
          memberId: conflictMemberId,
          firstName: "Dana",
          lastName: "Doe",
          stayStart: CHECK_IN,
          stayEnd: CHECK_OUT,
          nights: [{ stayDate: CHECK_IN }],
          member: { firstName: "Dana", lastName: "Doe" },
          booking: {
            id: "bk-other",
            memberId: "m-stranger",
            status: "CONFIRMED",
            checkIn: CHECK_IN,
            checkOut: CHECK_OUT,
            member: { firstName: "Sam", lastName: "Stranger" },
            guests: [{ id: "bg-other", memberId: conflictMemberId }, { id: "bg-2", memberId: null }],
          },
        },
      ],
    },
  } as unknown as Parameters<typeof findBookingMemberNightConflicts>[0];
}

describe("D-8 leak 2 — the person-night conflict", () => {
  it("refuses neutrally instead of returning a cross-family member's booked nights", async () => {
    const error = await findBookingMemberNightConflicts(conflictDb(OUTSIDER), {
      actorMemberId: BOOKER,
      actorRole: "USER",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guests: [
        {
          memberId: OUTSIDER,
          stayStart: CHECK_IN,
          stayEnd: CHECK_OUT,
          crossFamilyMemberGuest: true,
        },
      ],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BookingGuestValidationError);
    const refusal = error as BookingGuestValidationError;
    expect(refusal.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(refusal.status).toBe(403);
    // The message the ordinary conflict would have produced names the member and
    // the nights; this one names neither.
    expect(refusal.message).not.toContain("Dana");
    expect(refusal.message).not.toContain("2026-09-10");
  });

  it("returns the ordinary detailed conflict for an unmarked (family-scope) guest", async () => {
    const conflicts = await findBookingMemberNightConflicts(conflictDb(CHILD), {
      actorMemberId: BOOKER,
      actorRole: "USER",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guests: [{ memberId: CHILD, stayStart: CHECK_IN, stayEnd: CHECK_OUT }],
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].memberName).toBe("Dana Doe");
    expect(conflicts[0].conflictingNights.length).toBeGreaterThan(0);
    // #2250's disclosure gate is untouched: this viewer is not entitled to the
    // other booking, so none of its fields are attached.
    expect(conflicts[0].bookingId).toBeUndefined();
  });

  it("says nothing when a marked cross-family guest has no clash at all", async () => {
    // The marker must not turn into a refusal on its own — only a real conflict
    // refuses.
    const conflicts = await findBookingMemberNightConflicts(
      { bookingGuest: { findMany: async () => [] } } as unknown as Parameters<
        typeof findBookingMemberNightConflicts
      >[0],
      {
        actorMemberId: BOOKER,
        actorRole: "USER",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [
          {
            memberId: OUTSIDER,
            stayStart: CHECK_IN,
            stayEnd: CHECK_OUT,
            crossFamilyMemberGuest: true,
          },
        ],
      },
    );

    expect(conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The unpaid-subscription refusal
// ---------------------------------------------------------------------------

function subscriptionDb(memberId: string) {
  return {
    memberSubscription: {
      findMany: async () => [
        {
          memberId,
          status: "AWAITING_PAYMENT",
          xeroOnlineInvoiceUrl: "https://invoice.example/secret",
          xeroInvoiceNumber: "INV-4242",
        },
      ],
    },
    member: {
      findMany: async () => [
        { id: memberId, firstName: "Dana", lastName: "Doe", ageTier: "ADULT" },
      ],
    },
    membershipType: { findMany: async () => [] },
    memberSubscriptionYear: { findMany: async () => [] },
  } as unknown as Parameters<typeof findUnpaidMemberGuests>[0];
}

describe("D-8 leak 3 — the unpaid-subscription refusal", () => {
  it("refuses neutrally instead of returning a cross-family member's name, status and invoice", async () => {
    const error = await findUnpaidMemberGuests(subscriptionDb(OUTSIDER), {
      bookingMemberId: BOOKER,
      checkIn: CHECK_IN,
      guests: [
        { isMember: true, memberId: OUTSIDER, crossFamilyMemberGuest: true },
      ],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BookingGuestValidationError);
    const refusal = error as BookingGuestValidationError;
    expect(refusal.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(refusal.status).toBe(403);
    expect(refusal.message).not.toContain("Dana");
    expect(refusal.message).not.toContain("INV-4242");
  });

  it("returns the detailed rows for a family-scope member guest", async () => {
    const result = await findUnpaidMemberGuests(subscriptionDb(CHILD), {
      bookingMemberId: BOOKER,
      checkIn: CHECK_IN,
      guests: [{ isMember: true, memberId: CHILD }],
    }).catch((err: unknown) => err);

    expect(Array.isArray(result)).toBe(true);
    const rows = result as Awaited<ReturnType<typeof findUnpaidMemberGuests>>;
    expect(rows[0].name).toBe("Dana Doe");
    expect(rows[0].invoiceNumber).toBe("INV-4242");
  });
});

// ---------------------------------------------------------------------------
// The property that makes the collapse worth doing
// ---------------------------------------------------------------------------

describe("the three refusals are indistinguishable", () => {
  it("share one message and one status", async () => {
    const fromProfileGate = await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([[OUTSIDER, incompleteMember(OUTSIDER)]]),
      BOOKER,
      { crossFamilyMemberIds: [OUTSIDER] },
    ).catch((err: BookingGuestValidationError) => err);

    const fromNightConflict = await findBookingMemberNightConflicts(
      conflictDb(OUTSIDER),
      {
        actorMemberId: BOOKER,
        actorRole: "USER",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [
          {
            memberId: OUTSIDER,
            stayStart: CHECK_IN,
            stayEnd: CHECK_OUT,
            crossFamilyMemberGuest: true,
          },
        ],
      },
    ).catch((err: BookingGuestValidationError) => err);

    expect(fromProfileGate.message).toBe(fromNightConflict.message);
    expect(fromProfileGate.status).toBe(fromNightConflict.status);
    // And the message says nothing at all about which invariant refused.
    expect(fromProfileGate.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
  });
});
