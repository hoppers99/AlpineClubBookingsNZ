import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2265 (epic #2245, E1) — saving as a draft must REMEMBER the member's credit
 * election.
 *
 * The bug: the wizard sent `applyCreditCents` on Save as draft, the create
 * route's draft branch never named the field, and the election vanished with no
 * message to the member. These tests pin the persistence half of the fix at the
 * service boundary — the row `createDraftBooking` writes — and pin the other
 * half of the promise just as hard: a draft consumes NO credit.
 */

const mocks = vi.hoisted(() => ({
  bookingCreate: vi.fn(),
  applyCreditToBooking: vi.fn(),
  getMemberCreditBalance: vi.fn().mockResolvedValue(50_000),
  memberCreditCreate: vi.fn(),
}));

const tx = {
  $executeRaw: vi.fn().mockResolvedValue(1),
  booking: { create: mocks.bookingCreate },
  season: { findMany: vi.fn().mockResolvedValue([]) },
  memberCredit: { create: mocks.memberCreditCreate, aggregate: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(
      async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    ),
    member: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: vi.fn().mockResolvedValue("lodge-1"),
  lodgeNullTolerantScope: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/lodge-access", () => ({
  assertMemberMayBookLodge: vi.fn().mockResolvedValue(undefined),
  LodgeBookingEligibilityError: class extends Error {},
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  checkCapacityForGuestRanges: vi.fn().mockResolvedValue({
    available: true,
    nightDetails: [],
  }),
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  assertNoBookingMemberNightConflicts: vi.fn().mockResolvedValue(undefined),
  BookingMemberNightConflictError: class extends Error {},
  DUPLICATE_STAY_BOOKING_STATUSES: [],
}));
vi.mock("@/lib/membership-type-policy", () => ({
  priceBookingGuestsWithMembershipTypePolicy: vi.fn().mockResolvedValue({
    totalPriceCents: 10_000,
    guests: [
      {
        priceCents: 10_000,
        perNightCents: [5_000, 5_000],
        nightDates: [new Date("2026-08-14"), new Date("2026-08-15")],
      },
    ],
  }),
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  MembershipTypeBookingPolicyError: class extends Error {},
}));
vi.mock("@/lib/booking-create-promo", () => ({
  resolveEffectivePromoSource: vi.fn().mockResolvedValue(null),
  resolvePromoInTransaction: vi.fn(),
  getPromoTargetBookingGuestIds: vi.fn().mockReturnValue([]),
  remapPromoIndexesToSubset: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/email", () => ({
  sendAdminNewBookingAlert: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendWaitlistConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/member-credit", () => ({
  applyCreditToBooking: mocks.applyCreditToBooking,
  getMemberCreditBalance: mocks.getMemberCreditBalance,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { createDraftBooking } from "@/lib/booking-create";

const GUESTS = [
  {
    firstName: "Aroha",
    lastName: "Ngata",
    ageTier: "ADULT" as const,
    isMember: true,
    memberId: "member-1",
  },
];

function draftInput(overrides: Record<string, unknown> = {}) {
  return {
    effectiveMemberId: "member-1",
    isOnBehalf: false,
    sessionUserId: "member-1",
    checkIn: new Date("2026-08-14"),
    checkOut: new Date("2026-08-16"),
    guests: GUESTS,
    ...overrides,
  };
}

function createdRow() {
  return mocks.bookingCreate.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingCreate.mockResolvedValue({
    id: "draft-1",
    status: "DRAFT",
    checkIn: new Date("2026-08-14"),
    checkOut: new Date("2026-08-16"),
    finalPriceCents: 10_000,
    guests: [],
  });
  mocks.getMemberCreditBalance.mockResolvedValue(50_000);
});

describe("#2265 createDraftBooking remembers the credit election", () => {
  it("stores the elected amount on the draft, in integer cents", async () => {
    await createDraftBooking(draftInput({ applyCreditCents: 8_650 }));

    expect(createdRow().creditElectionCents).toBe(8_650);
  });

  it("consumes no credit at all while the booking is only a draft", async () => {
    await createDraftBooking(draftInput({ applyCreditCents: 8_650 }));

    // No ledger row, no balance movement: an abandoned or expired draft leaves
    // the member's balance exactly where it was. This is the reason the
    // election is stored rather than applied.
    expect(mocks.applyCreditToBooking).not.toHaveBeenCalled();
    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    expect(createdRow().status).toBe("DRAFT");
  });

  it("records an explicit election of zero as zero, not as 'never asked'", async () => {
    await createDraftBooking(draftInput({ applyCreditCents: 0 }));

    expect(createdRow().creditElectionCents).toBe(0);
  });

  it("omits the column entirely when the member made no election", async () => {
    await createDraftBooking(draftInput());

    // The create payload stays byte-identical to the pre-#2265 shape for a
    // member who never touched the credit control.
    expect(createdRow()).not.toHaveProperty("creditElectionCents");
  });
});
