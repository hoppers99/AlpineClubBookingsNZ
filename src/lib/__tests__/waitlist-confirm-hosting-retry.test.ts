import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  confirmWaitlistOffer: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentCreate: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacity: vi.fn(),
  reconcileBeds: vi.fn(),
  enqueueHosting: vi.fn(),
  settleHosting: vi.fn(),
  sendConfirmed: vi.fn(),
  sendPending: vi.fn(),
  enqueueXero: vi.fn(),
  kickXero: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/waitlist", () => ({
  confirmWaitlistOffer: mocks.confirmWaitlistOffer,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
  checkCapacityForGuestRanges: mocks.checkCapacity,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: mocks.reconcileBeds,
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: mocks.enqueueHosting,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHosting,
}));
vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: mocks.sendConfirmed,
  sendBookingPendingEmail: mocks.sendPending,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXero,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickXero,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/waitlist-confirm/route";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";

describe("zero-dollar waitlist participant contention (#2597)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.confirmWaitlistOffer.mockResolvedValue({
      success: true,
      newStatus: "PAYMENT_PENDING",
    });
    const booking = {
      id: "booking-1",
      memberId: "member-1",
      lodgeId: "lodge-1",
      status: "PAYMENT_PENDING",
      finalPriceCents: 0,
      discountCents: 0,
      promoAdjustmentCents: 0,
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-22T00:00:00.000Z"),
      nonMemberHoldUntil: null,
      member: { email: "member@example.test", firstName: "Member" },
      guests: [{ id: "guest-1", nights: [] }],
      promoRedemption: null,
    };
    mocks.bookingFindUnique.mockResolvedValue(booking);
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.paymentCreate.mockResolvedValue({ id: "payment-1" });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
    mocks.checkCapacity.mockResolvedValue({ available: true });
    mocks.reconcileBeds.mockResolvedValue(undefined);
    mocks.enqueueHosting.mockRejectedValueOnce(
      new HostingCoverageParticipantRetryError(),
    );
    const tx = {
      $executeRaw: mocks.executeRaw,
      booking: {
        findUnique: mocks.bookingFindUnique,
        updateMany: mocks.bookingUpdateMany,
      },
      payment: { create: mocks.paymentCreate },
    };
    mocks.transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
  });

  it("restores WAITLISTED after phase two rolls back and returns the fixed 409", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/bookings/booking-1/waitlist-confirm",
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: "booking-1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.bookingUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "booking-1", status: "PAYMENT_PENDING" },
      data: {
        status: "WAITLISTED",
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        waitlistOfferedLodgeId: null,
        waitlistOfferedPriceCents: null,
      },
    });
    expect(mocks.reconcileBeds).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1" }),
    );
    expect(mocks.settleHosting).not.toHaveBeenCalled();
    expect(mocks.sendConfirmed).not.toHaveBeenCalled();
    expect(mocks.enqueueXero).not.toHaveBeenCalled();
  });
});
