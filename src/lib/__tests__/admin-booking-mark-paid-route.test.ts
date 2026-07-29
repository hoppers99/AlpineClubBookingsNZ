import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * B5 (#2262) — the mark-paid route's contract.
 *
 * Two shapes are refused with 422 rather than guessed, both because an
 * ambiguous money action is worse than a refused one:
 *  * #2260 notifyMember — required on "paid", rejected on "unpaid";
 *  * expectedAmountCents — required on "paid" (there is nothing to reconcile the
 *    admin's figure against without it), rejected on "unpaid".
 * And the route is gated finance:edit, not bookings:edit, despite its
 * bookings-shaped path.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  applyManualBookingPayment: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/manual-booking-payment", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/manual-booking-payment")
  >("@/lib/manual-booking-payment");
  return { ...actual, applyManualBookingPayment: mocks.applyManualBookingPayment };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendBookingConfirmedEmail: vi.fn() }));
vi.mock("@/lib/booking-events", () => ({ recordBookingEvent: vi.fn() }));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: vi.fn(),
}));

import { POST } from "@/app/api/admin/bookings/[id]/mark-paid/route";

const params = Promise.resolve({ id: "booking-1" });

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(
    "https://example.test/api/admin/bookings/booking-1/mark-paid",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.applyManualBookingPayment.mockResolvedValue({
    bookingId: "booking-1",
    paymentId: "payment-1",
    direction: "paid",
    memberNotified: false,
    receipt: "not_requested",
    amountCents: 10000,
    bookingStatus: "PAID",
  });
});

describe("POST /api/admin/bookings/[id]/mark-paid", () => {
  it("is gated on finance:edit, not bookings:edit", async () => {
    await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
  });

  it("422s when marking paid without saying whether to email the member", async () => {
    const response = await POST(
      makeRequest({ direction: "paid", confirmed: true, expectedAmountCents: 1 }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/notifyMember is required/);
    expect(mocks.applyManualBookingPayment).not.toHaveBeenCalled();
  });

  it("422s when a reversal carries notifyMember", async () => {
    const response = await POST(
      makeRequest({ direction: "unpaid", confirmed: true, notifyMember: false }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/never emails the member/);
    expect(mocks.applyManualBookingPayment).not.toHaveBeenCalled();
  });

  it("422s when marking paid without the amount the admin was shown", async () => {
    const response = await POST(
      makeRequest({ direction: "paid", confirmed: true, notifyMember: true }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/expectedAmountCents is required/);
  });

  it("422s when a reversal carries expectedAmountCents", async () => {
    const response = await POST(
      makeRequest({
        direction: "unpaid",
        confirmed: true,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/settles no amount/);
  });

  it("400s without the explicit confirmation, so a money action is never a single click", async () => {
    const response = await POST(
      makeRequest({
        direction: "paid",
        notifyMember: false,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(response.status).toBe(400);
  });

  it("reports the receipt honestly rather than claiming a delivery", async () => {
    mocks.applyManualBookingPayment.mockResolvedValue({
      bookingId: "booking-1",
      paymentId: "payment-1",
      direction: "paid",
      memberNotified: true,
      receipt: "not_delivered",
      amountCents: 10000,
      bookingStatus: "PAID",
    });

    const response = await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: true,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).message).toMatch(
      /could not be sent — check the booking's email settings/,
    );
  });

  it("surfaces a domain refusal with its own status and message", async () => {
    const { ManualBookingPaymentError } = await vi.importActual<
      typeof import("@/lib/payment-reconciliation")
    >("@/lib/payment-reconciliation");
    mocks.applyManualBookingPayment.mockRejectedValue(
      new ManualBookingPaymentError(
        "This booking has an outstanding Xero invoice — record the payment against the invoice in Xero instead.",
        409,
      ),
    );

    const response = await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/outstanding Xero invoice/);
  });
});
