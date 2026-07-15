import { beforeEach, describe, expect, it, vi } from "vitest";

// F20 (#1887): applyLifecycleTransitions must take the EFFECTIVE (credit-reduced)
// price for its zero-dollar decision so a pre-payment reduction that lands a
// booking fully credit-covered auto-confirms at $0 instead of dead-ending at the
// card-intent guard. This suite exercises that decision in isolation by mocking
// the clamp and the intent-supersede helper.

const mockClamp = vi.fn();
const mockQueueSuperseded = vi.fn();
const mockPaymentUpsert = vi.fn();

vi.mock("@/lib/member-credit", () => ({
  clampAppliedCreditToBookingPrice: (...args: unknown[]) => mockClamp(...args),
}));

vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: (...args: unknown[]) =>
    mockQueueSuperseded(...args),
}));

// applyLifecycleTransitions imports these but does not reach them on the
// all-member, no-review path exercised here.
vi.mock("@/lib/cancellation", () => ({
  calculateDualRefundAmounts: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  getNonMemberHoldPolicy: vi.fn(),
}));
vi.mock("@/lib/booking-payment-state", () => ({
  getRemainingRefundableCents: vi.fn(),
  hasCapturedPayment: vi.fn(),
  hasIssuedPrimaryXeroInvoice: vi.fn(),
  isSettledBookingStatus: vi.fn(),
}));
vi.mock("@/lib/policies/booking-route-decisions", () => ({
  calculateBookingHoldDecision: vi.fn(),
}));

import { applyLifecycleTransitions } from "@/lib/booking-modify-settlement";

function makeTx() {
  return {
    payment: { upsert: mockPaymentUpsert },
  } as any;
}

function baseBooking(creditAppliedCents: number) {
  return {
    id: "bk-1",
    memberId: "member-1",
    status: "PAYMENT_PENDING",
    nonMemberHoldUntil: null,
    lodgeId: "lodge-1",
    payment: { id: "pay-1", creditAppliedCents },
  } as any;
}

describe("applyLifecycleTransitions — F20 applied-credit clamp (#1887)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueSuperseded.mockResolvedValue([]);
    mockPaymentUpsert.mockResolvedValue({ id: "pay-1" });
  });

  it("refunds the over-consumed credit and auto-confirms at $0 when the reprice drops below applied credit", async () => {
    // Applied 5000, reprice to 3000: clamp returns 2000, net applied 3000.
    mockClamp.mockResolvedValue({
      appliedCreditCents: 3000,
      refundedExcessCents: 2000,
    });

    const result = await applyLifecycleTransitions(makeTx(), {
      booking: baseBooking(5000),
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 3000,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    expect(mockClamp).toHaveBeenCalledWith(
      { memberId: "member-1", bookingId: "bk-1", newFinalPriceCents: 3000 },
      expect.anything(),
    );
    expect(result.newStatus).toBe("PAID");
    expect(result.zeroDollarAutoPaid).toBe(true);
    expect(result.appliedCreditCents).toBe(3000);
    expect(result.refundedExcessCreditCents).toBe(2000);
    // The $0 payment mirror keeps amountCents + creditAppliedCents = finalPrice.
    expect(mockPaymentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: "bk-1" },
        create: expect.objectContaining({
          amountCents: 0,
          creditAppliedCents: 3000,
          status: "SUCCEEDED",
        }),
      }),
    );
    // A credit-covered $0 sweeps every positive pending intent (effective 0).
    expect(mockQueueSuperseded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ newFinalPriceCents: 0 }),
    );
  });

  it("does not touch the credit ledger or auto-pay for a no-credit reduction (unchanged behaviour)", async () => {
    const result = await applyLifecycleTransitions(makeTx(), {
      booking: baseBooking(0),
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 3000,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    // No applied-credit mirror -> the clamp is never invoked.
    expect(mockClamp).not.toHaveBeenCalled();
    expect(result.newStatus).toBe("PAYMENT_PENDING");
    expect(result.zeroDollarAutoPaid).toBe(false);
    expect(result.appliedCreditCents).toBe(0);
    expect(mockPaymentUpsert).not.toHaveBeenCalled();
    // Existing #1161 supersede still runs against the full new price.
    expect(mockQueueSuperseded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ newFinalPriceCents: 3000 }),
    );
  });

  it("keeps the legacy no-credit price-to-zero auto-pay ($0 == effective when no credit)", async () => {
    const result = await applyLifecycleTransitions(makeTx(), {
      booking: baseBooking(0),
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 0,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    expect(mockClamp).not.toHaveBeenCalled();
    expect(result.newStatus).toBe("PAID");
    expect(result.zeroDollarAutoPaid).toBe(true);
    expect(mockPaymentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ amountCents: 0, creditAppliedCents: 0 }),
      }),
    );
  });
});
