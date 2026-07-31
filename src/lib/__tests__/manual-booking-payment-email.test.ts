import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B5 (#2262) M4 — the manual mark-paid confirmation email must carry the SAME
 * options shape as every comparable settle-time send (the Xero-inbound settle
 * at invoice-paid-effects, cron-confirm-pending, charge-saved-method): in
 * particular the split-booking parent's `provisionalGuests` summary, so a
 * cash-settled split parent is told about the separate later charge for their
 * provisionally-held non-member guests exactly like every other settled member.
 */

const mocks = vi.hoisted(() => ({
  markBookingPaymentManuallySettled: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
  getProvisionalNonMemberChildSummary: vi.fn(),
  bookingFindUnique: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
  },
}));
vi.mock("@/lib/payment-reconciliation", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/payment-reconciliation")
  >("@/lib/payment-reconciliation");
  return {
    ManualBookingPaymentError: actual.ManualBookingPaymentError,
    markBookingPaymentManuallySettled: (...a: unknown[]) =>
      mocks.markBookingPaymentManuallySettled(...a),
    reverseManualBookingPayment: vi.fn(),
  };
});
vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: (...a: unknown[]) =>
    mocks.sendBookingConfirmedEmail(...a),
}));
vi.mock("@/lib/booking-split-summary", () => ({
  getProvisionalNonMemberChildSummary: (...a: unknown[]) =>
    mocks.getProvisionalNonMemberChildSummary(...a),
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/booking-events", () => ({ recordBookingEvent: vi.fn() }));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { applyManualBookingPayment } from "@/lib/manual-booking-payment";

const HOLD_UNTIL = new Date("2026-08-01T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.markBookingPaymentManuallySettled.mockResolvedValue({
    bookingId: "booking-1",
    paymentId: "payment-1",
    effectiveAmountCents: 10000,
    creditAppliedCents: 0,
    previousStatus: "PAYMENT_PENDING",
    settledAt: new Date("2026-07-29T00:00:00Z"),
    outstandingIntentIds: [],
    memberFirstName: "Ada",
    memberEmail: "ada@example.org",
  });
  mocks.bookingFindUnique.mockResolvedValue({
    lodgeId: "lodge-1",
    memberId: "member-1",
    checkIn: new Date("2026-08-10"),
    checkOut: new Date("2026-08-12"),
    finalPriceCents: 10000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    member: { email: "ada@example.org", firstName: "Ada" },
    promoRedemption: null,
    _count: { guests: 2 },
  });
  mocks.sendBookingConfirmedEmail.mockResolvedValue({ status: "sent" });
  mocks.getProvisionalNonMemberChildSummary.mockResolvedValue(null);
});

describe("applyManualBookingPayment — confirmation email parity (M4)", () => {
  it("threads the split-parent provisionalGuests summary into the confirmation, matching the other settle-time sends", async () => {
    mocks.getProvisionalNonMemberChildSummary.mockResolvedValue({
      guestCount: 2,
      holdUntil: HOLD_UNTIL,
    });

    const result = await applyManualBookingPayment({
      bookingId: "booking-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
      expectedAmountCents: 10000,
    });

    expect(result.receipt).toBe("queued");
    expect(mocks.getProvisionalNonMemberChildSummary).toHaveBeenCalledWith({
      id: "booking-1",
      memberId: "member-1",
    });
    expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledWith(
      { bookingId: "booking-1" },
      "ada@example.org",
      "Ada",
      expect.any(Date),
      expect.any(Date),
      2,
      10000,
      expect.objectContaining({
        lodgeId: "lodge-1",
        provisionalGuests: { guestCount: 2, holdUntil: HOLD_UNTIL },
      }),
    );
  });

  it("omits the provisionalGuests option entirely for a non-split booking", async () => {
    await applyManualBookingPayment({
      bookingId: "booking-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
      expectedAmountCents: 10000,
    });

    const options = mocks.sendBookingConfirmedEmail.mock.calls[0][7] as Record<
      string,
      unknown
    >;
    expect("provisionalGuests" in options).toBe(false);
  });
});
