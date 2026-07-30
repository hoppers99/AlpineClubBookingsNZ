// "+ Add Member Guest" (epic #2305) MG2 (#2307) — THE CONSENT REMOVAL AUTHORITY.
//
// `removeBookingGuestInTransaction` admits the booking owner, an `ADMIN`, or the
// guest themselves. Two of the three consent removals are none of those: a
// DELEGATE answering for a target who cannot log in (owner decisions D-5/D-10) is
// a fourth party, and the EXPIRY SWEEP has no actor at all. `consentAuthority` is
// the narrow grant that lets exactly those two reach this function — which makes
// it the most security-sensitive thing MG2 adds, because a grant that widened by
// one field would let one member take another off a stranger's booking.
//
// SO EVERY BOUNDARY OF IT IS ASSERTED SEPARATELY, against the REAL removal
// service rather than a stand-in:
//
//   * it authorizes exactly the one guest id it names, and no other;
//   * it applies only once the row ALREADY carries the terminal consent status the
//     caller claims, which is what binds it to the status-guarded claim earlier in
//     the same transaction — so it cannot remove a live PENDING or CONFIRMED row;
//   * it applies only when the row's `memberId` is the target it names;
//   * it grants nothing on any pre-existing path;
//   * and it routes to the SELF-REMOVAL gate set rather than the owner gate set,
//     which is what makes owner decision D-14 hold to the letter.
//
// The last one is asserted DIFFERENTIALLY, on one fixture, because that is the
// only way to show a routing decision rather than a coincidence: a DRAFT booking
// is self-removable but is NOT in the owner path's narrower status list, so the
// same guest on the same booking is refused for an owner and released for the
// sweep.
//
// The harness keeps the REAL pricing, settlement and lifecycle machinery and fakes
// only the database and the leaf side-effect modules — the same arrangement
// `partial-stay-edit-pricing.test.ts` uses, which is also where the pre-existing
// owner/admin removal behaviour is pinned end-to-end (its "#1093" cases). This
// file deliberately does not repeat that money math; it tests the gate.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capacity", () => ({
  checkCapacity: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  getOccupiedBedsForNight: vi.fn().mockReturnValue(0),
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  LODGE_CAPACITY: 29,
}));
vi.mock("@/lib/cancellation", () => ({
  daysUntilDate: vi.fn().mockReturnValue(30),
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
  getNonMemberHoldPolicy: vi.fn().mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "default",
  }),
  calculateDualRefundAmounts: vi.fn((basisAmountCents: number) => ({
    cardRefundAmountCents: basisAmountCents,
    cardRefundPercentage: 100,
    creditRefundAmountCents: basisAmountCents,
    creditRefundPercentage: 100,
  })),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  validateAndCalculatePromoDiscount: vi.fn().mockResolvedValue({
    discount: {
      discountCents: 0,
      priceAdjustmentCents: 0,
      freeNightsUsed: 0,
      eligibleGuestCount: 0,
      allocations: [],
    },
    beneficiaryMemberIds: [],
  }),
  calculatePromoDiscountForGuestRates: vi.fn().mockReturnValue({
    discountCents: 0,
    priceAdjustmentCents: 0,
    freeNightsUsed: 0,
    eligibleGuestCount: 0,
    allocations: [],
  }),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(true),
  redeemPromoCode: vi.fn(),
  replacePromoRedemptionAllocations: vi.fn(),
  deletePromoRedemptionAndAdjustCount: vi.fn(),
  getMemberFreeNightsUsed: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/stripe", () => ({
  processRefund: vi.fn().mockResolvedValue({ id: "re_1" }),
  createPaymentIntent: vi.fn().mockResolvedValue({ id: "pi_1", client_secret: "secret" }),
  findOrCreateCustomer: vi.fn().mockResolvedValue({ id: "cus_1" }),
  getPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  listRefundsForCharge: vi.fn().mockResolvedValue([]),
  cancelPaymentIntentIfCancellable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: vi.fn().mockResolvedValue({}),
  refundPaymentTransactions: vi.fn().mockResolvedValue({ refunds: [] }),
  findPaymentTransactionByIntentId: vi.fn().mockResolvedValue(null),
  markPaymentIntentTransactionSucceeded: vi.fn().mockResolvedValue({}),
  markPaymentIntentTransactionFailed: vi.fn().mockResolvedValue({}),
  syncRefundsFromStripeCharge: vi.fn(),
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "rec_1" }),
  completeCanceledSupersededPaymentIntentRecovery: vi.fn().mockResolvedValue(undefined),
  queueSupersededPaymentIntentRefundRecovery: vi.fn().mockResolvedValue(undefined),
  queueRefundRecoveryOperation: vi.fn().mockResolvedValue(undefined),
  getStripePaymentMethodId: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededAdditionalIntentCancellations: vi.fn().mockResolvedValue([]),
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/member-credit", () => ({
  createBookingModificationCredit: vi.fn().mockResolvedValue({ id: "credit-1" }),
}));
vi.mock("@/lib/xero", () => ({
  createXeroSupplementaryInvoice: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNoteForModification: vi.fn().mockResolvedValue(undefined),
  isXeroConnected: vi.fn().mockResolvedValue(false),
  createXeroInvoiceForBooking: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNote: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: vi.fn().mockResolvedValue(null) },
    member: { count: vi.fn().mockResolvedValue(1), findUnique: vi.fn().mockResolvedValue(null) },
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { BookingStatus } from "@prisma/client";

import {
  BookingGuestRemovalError,
  removeBookingGuestInTransaction,
} from "@/lib/booking-guest-removal-service";
import { SELF_REMOVABLE_GUEST_BOOKING_STATUSES } from "@/lib/booking-guest-self-removal";

const BOOKING = "bk-1";
const OWNER = "m-owner";
const TARGET = "m-target";
const COMPANION = "m-companion";
const DELEGATE = "m-delegate";
const ADMIN = "m-admin";
const TARGET_GUEST = "g-target";
const COMPANION_GUEST = "g-companion";

// Well in the future, so the self-removal future check passes and the stay is
// nowhere near a rate boundary.
const CHECK_IN = new Date("2026-11-02T00:00:00.000Z");
const CHECK_OUT = new Date("2026-11-04T00:00:00.000Z"); // 2 nights

const SEASONS = [
  {
    id: "s1",
    startDate: new Date("2026-04-01T00:00:00.000Z"),
    endDate: new Date("2027-03-31T00:00:00.000Z"),
    membershipTypeRates: [
      { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: 6000 },
      { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 8000 },
    ],
  },
];

function night(day: string, priceCents: number) {
  return { stayDate: new Date(`2026-11-0${day}T00:00:00.000Z`), priceCents };
}

type ConsentStatus = "PENDING" | "CONFIRMED" | "DECLINED" | "EXPIRED" | null;

function guestRow(
  id: string,
  memberId: string,
  consentStatus: ConsentStatus,
  firstName: string,
) {
  return {
    id,
    bookingId: BOOKING,
    firstName,
    lastName: "Person",
    ageTier: "ADULT",
    isMember: true,
    memberId,
    priceCents: 12000,
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
    nights: [night("2", 6000), night("3", 6000)],
    consentStatus,
    consentRequestedAt: consentStatus === null ? null : new Date("2026-10-01T00:00:00.000Z"),
    consentRespondedAt: null,
    consentRespondedByMemberId: null,
    consentExpiresAt: consentStatus === null ? null : new Date("2026-11-01T11:00:00.000Z"),
  };
}

/**
 * A booking with the consent target and one companion, so a removal is never the
 * last guest. `targetConsent` is what the status-guarded claim would already have
 * written by the time the authority is used.
 */
function makeBooking(options: {
  status?: string;
  targetConsent?: ConsentStatus;
  targetMemberId?: string;
  extraGuests?: ReturnType<typeof guestRow>[];
} = {}) {
  const guests = [
    guestRow(TARGET_GUEST, options.targetMemberId ?? TARGET, options.targetConsent ?? "EXPIRED", "Tania"),
    guestRow(COMPANION_GUEST, COMPANION, null, "Cass"),
    ...(options.extraGuests ?? []),
  ];
  return {
    id: BOOKING,
    memberId: OWNER,
    lodgeId: "lodge-1",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    status: options.status ?? BookingStatus.CONFIRMED,
    totalPriceCents: 24000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 24000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    requiresAdminReview: false,
    adminReviewStatus: null,
    adminReviewReason: null,
    memberReviewJustification: null,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    guests,
    // No captured payment: a settled booking would need a refund-vs-credit
    // election, which is its own D-14 trap and is covered in
    // member-guest-consent-service.test.ts.
    payment: null,
    member: { id: OWNER, email: "owner@example.com", firstName: "Ophelia", lastName: "Owner" },
    promoRedemption: null,
  };
}

function makeTx(booking: ReturnType<typeof makeBooking>) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    booking: {
      findUnique: vi.fn().mockResolvedValue(booking),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...booking, ...data, guests: booking.guests, payment: booking.payment }),
      ),
    },
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    bookingGuestNight: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    bookingModification: { create: vi.fn().mockResolvedValue({ id: "mod-1" }) },
    // Not a quote-priced booking: no booking request holds or converted to it.
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    payment: { update: vi.fn().mockResolvedValue({}) },
    season: { findMany: vi.fn().mockResolvedValue(SEASONS) },
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    promoRedemption: { update: vi.fn().mockResolvedValue({}) },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    member: {
      findMany: vi.fn().mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({
          id,
          firstName: "Member",
          lastName: "Test",
          email: `${id}@example.com`,
          role: "MEMBER",
          ageTier: "ADULT",
        })),
      ),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(1),
    },
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "type-full",
          key: "FULL",
          bookingBehavior: "MEMBER_RATE",
          subscriptionBehavior: "REQUIRED",
          name: "Full",
          isActive: true,
          isBuiltIn: true,
        },
        {
          id: "type-nonmember",
          key: "NON_MEMBER",
          bookingBehavior: "NON_MEMBER_RATE",
          subscriptionBehavior: "NOT_REQUIRED",
          name: "Non-Member",
          isActive: true,
          isBuiltIn: true,
        },
      ]),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

/** The authority the consent service builds for a decline or a lapse. */
function authority(
  kind: "CONSENT_DECLINE" | "CONSENT_EXPIRY",
  overrides: { guestId?: string; targetMemberId?: string } = {},
) {
  return {
    kind,
    guestId: overrides.guestId ?? TARGET_GUEST,
    targetMemberId: overrides.targetMemberId ?? TARGET,
  };
}

async function remove(
  tx: ReturnType<typeof makeTx>,
  params: {
    guestId: string;
    actorMemberId: string;
    actorRole?: string;
    consentAuthority?: ReturnType<typeof authority>;
    settlementMethod?: "card" | "credit";
  },
) {
  return removeBookingGuestInTransaction({
    tx: tx as never,
    bookingId: BOOKING,
    guestId: params.guestId,
    actorMemberId: params.actorMemberId,
    actorRole: params.actorRole ?? "MEMBER",
    ...(params.settlementMethod ? { settlementMethod: params.settlementMethod } : {}),
    ...(params.consentAuthority ? { consentAuthority: params.consentAuthority } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("consentAuthority authorizes exactly one guest row", () => {
  it("lets the sweep remove the guest whose consent lapsed", async () => {
    // The baseline the refusals below are refusals FROM. The sweep has no actor, so
    // it passes the booking owner (the party whose booking is repriced and who
    // receives the credit) and the authority is what admits it at all.
    const booking = makeBooking({ targetConsent: "EXPIRED" });
    const tx = makeTx(booking);

    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
      consentAuthority: authority("CONSENT_EXPIRY"),
    });

    expect(tx.bookingGuest.delete).toHaveBeenCalledWith({ where: { id: TARGET_GUEST } });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
    // The booking is repriced down to the one remaining guest, so the bed is
    // genuinely released rather than merely unlinked.
    expect(result.oldGuestCount).toBe(2);
    expect(result.priceDiffCents).toBeLessThan(0);
  });

  it("refuses to remove a DIFFERENT guest than the one it names", async () => {
    // The IDOR shape that matters most: hold a valid authority for your own lapsed
    // row and aim it at somebody else's place on the same booking. The authority is
    // checked against the POST-LOCK re-read, so nothing the caller says about the
    // guest id can widen it.
    const booking = makeBooking({ targetConsent: "EXPIRED" });
    const tx = makeTx(booking);

    await expect(
      remove(tx, {
        guestId: COMPANION_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY", { guestId: TARGET_GUEST }),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
  });

  it("refuses when the authority names the guest but the caller asks for another", async () => {
    // The mirror of the case above — authority for the companion, request for the
    // target — so neither field can be the one that matters by itself.
    const booking = makeBooking({ targetConsent: "EXPIRED" });
    const tx = makeTx(booking);

    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY", { guestId: COMPANION_GUEST }),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
  });
});

describe("consentAuthority applies only to a row already in its terminal status", () => {
  // This conjunct is what BINDS the authority to the status-guarded claim in
  // `member-guest-consent-service.ts`. The claim runs first, in the same
  // transaction; if it lost its race the row is not in the claimed status and the
  // authority simply does not apply. Without this, an authority object would be a
  // standing permission to remove a live guest.
  it("cannot remove a live PENDING row", async () => {
    const booking = makeBooking({ targetConsent: "PENDING" });
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
  });

  it("cannot remove a CONFIRMED row", async () => {
    // D-13: an approved consent is terminal. A stale authority must not be able to
    // undo a member's yes.
    const booking = makeBooking({ targetConsent: "CONFIRMED" });
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_DECLINE"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });

  it("cannot remove a consent-free (NULL) row", async () => {
    // Every ordinary guest in the database has a NULL consentStatus. If the
    // authority applied to them, it would be a general removal permission.
    const booking = makeBooking({ targetConsent: null });
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_DECLINE"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });

  it("will not accept a decline authority for an expired row, or the reverse", async () => {
    // The two kinds are not interchangeable: each one asserts what already happened
    // to the row, and a mismatch means the caller is describing a transition that
    // did not occur.
    const expired = makeTx(makeBooking({ targetConsent: "EXPIRED" }));
    await expect(
      remove(expired, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_DECLINE"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });

    const declined = makeTx(makeBooking({ targetConsent: "DECLINED" }));
    await expect(
      remove(declined, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });

  it("lets a delegate's DECLINE through on a DECLINED row", async () => {
    // The matching case, so the four refusals above are about the mismatch rather
    // than about declines never working. The delegate is neither the owner, nor an
    // admin, nor the guest — the three parties this function otherwise admits.
    const booking = makeBooking({ targetConsent: "DECLINED" });
    const tx = makeTx(booking);
    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: DELEGATE,
      consentAuthority: authority("CONSENT_DECLINE"),
    });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
    // The truthful actor is recorded on the modification: the delegate who
    // refused, not the target they answered for.
    expect(tx.bookingModification.create.mock.calls[0][0].data.memberId).toBe(DELEGATE);
  });
});

describe("consentAuthority applies only to the target it names", () => {
  it("refuses when the row belongs to a different member", async () => {
    // A guest row's `memberId` is the person whose consent was asked for. An
    // authority naming somebody else is not authority over this row, whatever else
    // matches.
    const booking = makeBooking({ targetConsent: "EXPIRED", targetMemberId: COMPANION });
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY", { targetMemberId: TARGET }),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
  });

  it("refuses a non-member guest row even with a matching status", async () => {
    // A row with no `memberId` is a plain named guest: nobody's consent to give, so
    // no authority can be about it.
    const booking = makeBooking({ targetConsent: "EXPIRED" });
    booking.guests[0].memberId = null as unknown as string;
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });
});

describe("consentAuthority grants nothing on the paths that already existed", () => {
  // The pre-existing owner/admin/self behaviour is pinned end-to-end (including
  // the money math) by partial-stay-edit-pricing.test.ts's #1093 cases; what is
  // asserted here is only that adding the authority parameter left the GATE alone.
  it("still lets the booking owner remove a guest with no authority at all", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    const result = await remove(tx, { guestId: TARGET_GUEST, actorMemberId: OWNER });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
  });

  it("still lets an admin remove a guest with no authority at all", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: ADMIN,
      actorRole: "ADMIN",
    });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
  });

  it("still lets a linked guest take themselves off", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    const result = await remove(tx, { guestId: TARGET_GUEST, actorMemberId: TARGET });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
  });

  it("still refuses a stranger", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    await expect(
      remove(tx, { guestId: TARGET_GUEST, actorMemberId: "m-nobody" }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });

  it("still refuses a linked guest aiming at somebody else's place", async () => {
    // The pre-existing rule that a guest may remove only THEMSELVES. A caller who
    // holds a guest row on the booking is a "linked guest viewer", which gets them
    // past the first gate and no further.
    const tx = makeTx(makeBooking({ targetConsent: null }));
    await expect(
      remove(tx, { guestId: COMPANION_GUEST, actorMemberId: TARGET }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });
});

describe("a consent removal runs the SELF-REMOVAL gate set (D-14)", () => {
  // THE DIFFERENTIAL TEST, and the reason D-14 holds to the letter: the cases in
  // which a never-consented member is trapped on a booking are exactly the cases in
  // which they could not have taken themselves off, and those refusals are what
  // D-15 routes to the admin exception list. A DRAFT booking is the cleanest
  // demonstration available — it IS in the self-removal status set and is NOT in
  // the owner path's narrower ["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"]
  // list — so the same guest on the same booking goes two different ways.
  it("expires a guest off a DRAFT booking that the owner path would refuse on status", async () => {
    expect(SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(BookingStatus.DRAFT)).toBe(true);

    const tx = makeTx(makeBooking({ status: BookingStatus.DRAFT, targetConsent: "EXPIRED" }));
    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
      consentAuthority: authority("CONSENT_EXPIRY"),
    });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
  });

  it("refuses the SAME removal on the SAME booking when it comes from the owner path", async () => {
    // Same fixture, same guest, no authority — and now the owner's own status gate
    // applies and refuses. This is what proves the authority ROUTES rather than
    // merely permits.
    const tx = makeTx(makeBooking({ status: BookingStatus.DRAFT, targetConsent: "EXPIRED" }));
    await expect(
      remove(tx, { guestId: TARGET_GUEST, actorMemberId: OWNER }),
    ).rejects.toMatchObject({
      message: "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
      status: 400,
    });
  });

  it("is refused by the self-removal status gate on a status a member could not leave", async () => {
    // The other side of the routing: a status that is not self-removable refuses the
    // consent removal too, with the self-removal sentence — which is the sentence
    // `classifyConsentRemovalRefusal` reads to file the row as BOOKING_STATUS.
    expect(SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(BookingStatus.CANCELLED)).toBe(false);

    const tx = makeTx(makeBooking({ status: BookingStatus.CANCELLED, targetConsent: "EXPIRED" }));
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: OWNER,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({
      message: "You cannot remove yourself from this booking in its current status",
      status: 400,
    });
  });

  it("is refused once check-in is no longer in the future", async () => {
    // The `STAY_NOT_FUTURE` gate, and the reason the expiry clamp is set a day
    // BEFORE check-in: a deadline landing on check-in morning would fire here.
    const tx = makeTx(makeBooking({ targetConsent: "EXPIRED" }));
    tx.booking.findUnique.mockResolvedValue({
      ...makeBooking({ targetConsent: "EXPIRED" }),
      checkIn: new Date("2020-01-01T00:00:00.000Z"),
      checkOut: new Date("2020-01-03T00:00:00.000Z"),
    });
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: OWNER,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({
      message: "Only future booking guests can remove themselves from another member's booking",
      status: 400,
    });
  });

  it("is refused when the guest is the booking's last one", async () => {
    // No exemption, exactly as D-14 was ticked: a booking cannot be emptied by a
    // lapse. The row is left for a human to decide whether the booking should exist
    // at all.
    const booking = makeBooking({ targetConsent: "EXPIRED" });
    booking.guests = [booking.guests[0]];
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: OWNER,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toBeInstanceOf(BookingGuestRemovalError);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: OWNER,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({
      message: "Cannot remove the last guest. Cancel the booking instead.",
      status: 400,
    });
  });

  it("settles the reduction as account credit when the sweep elects it (D-15)", async () => {
    // The election is passed straight through to the shared settlement machinery
    // rather than being re-implemented for consent, so a lapse and an ordinary edit
    // settle a paid booking the same way.
    const tx = makeTx(makeBooking({ targetConsent: "EXPIRED" }));
    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
      consentAuthority: authority("CONSENT_EXPIRY"),
      settlementMethod: "credit",
    });
    // Nothing was captured on this fixture, so nothing is refunded to a card —
    // which is the point: the sweep never issues a card refund.
    expect(result.refundAmountCents).toBe(0);
    expect(result.priceDiffCents).toBeLessThan(0);
  });
});
