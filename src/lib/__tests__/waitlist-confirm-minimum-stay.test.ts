import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

// #2363. Confirming a same-lodge waitlist offer turns a queue placeholder into
// capacity-holding status — a fresh commitment to those nights — but it used to
// run no minimum-stay check at all. An offer lives 48 hours, and an admin or a
// config import can tighten or add a rule inside that window, so this is the
// same "the club's state moved under a staged request" shape as the public
// group-join verification stage, and it fails closed the same way: the offer is
// NOT consumed, the entry goes back on the waitlist, and the member reads a
// plain sentence while the frozen review snapshot stays server-side.

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  prismaBookingFindUnique: vi.fn(),
  txBookingFindUnique: vi.fn(),
  txBookingUpdateMany: vi.fn(),
  validateMinimumStay: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  logAudit: vi.fn(),
  warn: vi.fn(),
}));

const txClient = {
  $executeRaw: vi.fn(),
  booking: {
    findUnique: h.txBookingFindUnique,
    updateMany: h.txBookingUpdateMany,
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: h.transaction,
    booking: { findUnique: h.prismaBookingFindUnique },
  },
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
  checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: h.reconcileBedAllocations,
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
vi.mock("@/lib/waitlist-cross-lodge", () => ({
  confirmCrossLodgeWaitlistOffer: vi.fn(),
  getWaitlistCrossLodgeOrder: vi.fn(),
  quoteWaitlistEntryAtLodge: vi.fn(),
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldPolicy: vi
    .fn()
    .mockResolvedValue({ enabled: false, holdDays: 0, source: "default" }),
}));
vi.mock("@/lib/email", () => ({
  sendWaitlistOfferEmail: vi.fn(),
  sendWaitlistOfferExpiredEmail: vi.fn(),
  sendAdminWaitlistOfferAlert: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: h.warn },
}));

import { confirmWaitlistOffer } from "@/lib/waitlist";

const LODGE = "lodge-a";
const CHECK_IN = new Date("2026-07-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-07-12T00:00:00.000Z");

/** A realistic frozen violation — the real evaluator's exact shape. */
const violation = {
  reasonCode: "MINIMUM_STAY",
  policyId: "policy-winter-weekends",
  policyVersion: 5,
  policyName: "Winter weekends",
  resolvedScope: {
    kind: "CLUB_WIDE",
    lodgeId: null,
    effectiveLodgeId: LODGE,
  },
  affectedNights: ["2026-07-10", "2026-07-11"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message:
    "Bookings including a Friday night require a minimum stay of 3 nights (Winter weekends). Your booking is 2 nights.",
  triggerDay: "Friday",
  minimumNights: 3,
  actualNights: 2,
  requirements: {
    kind: "MINIMUM_STAY",
    minimumNights: 3,
    actualNights: 2,
    triggerDays: [5],
  },
};

function offer(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: LODGE,
    status: BookingStatus.WAITLIST_OFFERED,
    waitlistOfferedLodgeId: null,
    waitlistOfferExpiresAt: new Date(Date.now() + 86_400_000),
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: [{ id: "g1", isMember: true, nights: [] }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.transaction.mockImplementation(
    async (callback: (tx: typeof txClient) => unknown) => callback(txClient),
  );
  h.prismaBookingFindUnique.mockResolvedValue(offer());
  // Reset, not just clear: a `...Once` queue survives `clearAllMocks`, and the
  // refusal cases return before the main transaction ever drains theirs.
  h.txBookingFindUnique.mockReset();
  h.txBookingFindUnique
    .mockResolvedValueOnce({ lodgeId: LODGE })
    .mockResolvedValue(offer());
  h.txBookingUpdateMany.mockResolvedValue({ count: 1 });
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.checkCapacityForGuestRanges.mockResolvedValue({ available: true });
  h.reconcileBedAllocations.mockResolvedValue(undefined);
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
});

describe("confirmWaitlistOffer minimum-stay guard (#2363)", () => {
  it("refuses a confirm after an admin tightens the rule, and puts the entry back on the waitlist instead of consuming the offer", async () => {
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(result.success).toBe(false);
    expect(result.code).toBe("MINIMUM_STAY_VIOLATION");
    expect(result.newStatus).toBeUndefined();
    // Evaluated for the booking's own lodge, on the offered nights.
    expect(h.validateMinimumStay).toHaveBeenCalledWith(
      CHECK_IN,
      CHECK_OUT,
      LODGE,
    );
    // The offer is not burnt: the entry is returned to WAITLISTED under the
    // lodge's capacity lock, status-guarded, and bed allocations reconciled.
    expect(h.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      LODGE,
    );
    expect(h.txBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", status: BookingStatus.WAITLIST_OFFERED },
      data: expect.objectContaining({ status: BookingStatus.WAITLISTED }),
    });
    expect(h.reconcileBedAllocations).toHaveBeenCalledTimes(1);
    // Nothing was ever flipped to a capacity-holding status.
    expect(h.checkCapacityForGuestRanges).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("gives the member a plain sentence and keeps the frozen snapshot server-side", async () => {
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(result.error).toBe(
      "The minimum stay for these nights has changed since you joined the waitlist, " +
        "so this offer can no longer be confirmed. You've been returned to the waitlist.",
    );
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("Winter weekends");
    expect(wire).not.toContain("policy-winter-weekends");
    expect(wire).not.toContain("minimum stay of 3 nights");
    // The detail the member does not get is still logged for the club.
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        violations: [{ policyId: "policy-winter-weekends", policyVersion: 5 }],
      }),
      expect.stringContaining("minimum-stay policy no longer satisfied"),
    );
  });

  it("leaves a compliant confirm untouched", async () => {
    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(h.validateMinimumStay).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.newStatus).toBe(BookingStatus.PAYMENT_PENDING);
    expect(result.code).toBeUndefined();
  });

  it("never reads policy for somebody else's offer — the Forbidden answer is unchanged", async () => {
    // There is no admin confirm path: the transaction refuses any actor that is
    // not the booking's own member, so the only actor that can ever reach the
    // policy check is a non-admin confirming their own offer.
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmWaitlistOffer("booking-1", "someone-else");

    expect(h.validateMinimumStay).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: "Forbidden" });
  });

  it("leaves an already-expired offer with its own answer", async () => {
    h.prismaBookingFindUnique.mockResolvedValue(
      offer({ waitlistOfferExpiresAt: new Date(Date.now() - 1_000) }),
    );
    h.txBookingFindUnique.mockReset();
    h.txBookingFindUnique
      .mockResolvedValueOnce({ lodgeId: LODGE })
      .mockResolvedValue(
        offer({ waitlistOfferExpiresAt: new Date(Date.now() - 1_000) }),
      );
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(h.validateMinimumStay).not.toHaveBeenCalled();
    expect(result.error).toContain("expired");
  });
});
