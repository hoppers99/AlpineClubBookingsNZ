import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdateMany: vi.fn(),
  cancelBooking: vi.fn(),
  sendApprovedEmail: vi.fn(),
  sendRejectedEmail: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      updateMany: mocks.bookingUpdateMany,
    },
  },
}));

vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: mocks.cancelBooking,
}));

vi.mock("@/lib/email", () => ({
  sendBookingReviewApprovedEmail: mocks.sendApprovedEmail,
  sendBookingReviewRejectedEmail: mocks.sendRejectedEmail,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { PATCH } from "@/app/api/admin/bookings/[id]/review/route";

function makeRequest(body: unknown) {
  return new NextRequest("https://example.test/api/admin/bookings/b1/review", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const adminSession = {
  ok: true as const,
  session: { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
};

const params = Promise.resolve({ id: "b1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(adminSession);
  mocks.sendApprovedEmail.mockResolvedValue(undefined);
  mocks.sendRejectedEmail.mockResolvedValue(undefined);
});

describe("PATCH /api/admin/bookings/[id]/review", () => {
  it("rejects a REJECTED decision missing adminNotes", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
      member: { email: "a@b.co", firstName: "A" },
      checkIn: new Date(),
      checkOut: new Date(),
    });
    const res = await PATCH(makeRequest({ status: "REJECTED", adminNotes: "" }), { params });
    expect(res.status).toBe(400);
  });

  it("approves without adminNotes and stores null review notes", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
      member: { email: "a@b.co", firstName: "A" },
      checkIn: new Date(),
      checkOut: new Date(),
    });
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(makeRequest({ status: "APPROVED" }), { params });

    expect(res.status).toBe(200);
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ adminReviewNotes: null }),
      }),
    );
  });

  it("409s when booking is not pending review", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "APPROVED",
      status: "PAYMENT_PENDING",
      member: { email: "a@b.co", firstName: "A" },
      checkIn: new Date(),
      checkOut: new Date(),
    });
    const res = await PATCH(
      makeRequest({ status: "APPROVED", adminNotes: "ok" }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("approves: transitions to PAYMENT_PENDING and emails member", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
      member: { email: "member@example.com", firstName: "Alex" },
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
    });
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makeRequest({ status: "APPROVED", adminNotes: "Approved on the condition that..." }),
      { params },
    );
    expect(res.status).toBe(200);

    const updateArgs = mocks.bookingUpdateMany.mock.calls[0][0];
    expect(updateArgs.where).toMatchObject({
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
    });
    expect(updateArgs.data).toMatchObject({
      adminReviewStatus: "APPROVED",
      status: "PAYMENT_PENDING",
      adminReviewedById: "admin1",
    });

    expect(mocks.sendApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "member@example.com",
        bookingId: "b1",
        adminNotes: "Approved on the condition that...",
      }),
    );
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("approves a flagged paid booking without touching its status (#1100)", async () => {
    // A removal left this PAID booking minors-only: it is flagged
    // (adminReviewStatus PENDING) but not parked. Approval clears the review
    // and must never release captured money into PAYMENT_PENDING.
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "PAID",
      member: { email: "member@example.com", firstName: "Alex" },
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
    });
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makeRequest({ status: "APPROVED", adminNotes: "Supervisor confirmed." }),
      { params },
    );
    expect(res.status).toBe(200);

    const updateArgs = mocks.bookingUpdateMany.mock.calls[0][0];
    expect(updateArgs.where).toMatchObject({
      adminReviewStatus: "PENDING",
      status: "PAID",
    });
    expect(updateArgs.data).toMatchObject({ adminReviewStatus: "APPROVED" });
    expect(updateArgs.data.status).toBeUndefined();
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("rejects a flagged paid booking by cancelling through the shared flow (#1100)", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "PAID",
      member: { email: "member@example.com", firstName: "Alex" },
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
    });
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.cancelBooking.mockResolvedValue({ status: 200, data: { success: true } });

    const res = await PATCH(
      makeRequest({ status: "REJECTED", adminNotes: "No adult attending." }),
      { params },
    );
    expect(res.status).toBe(200);
    // The shared cancel flow handles the policy refund for the captured payment.
    expect(mocks.cancelBooking).toHaveBeenCalledWith(
      "b1",
      "admin1",
      "ADMIN",
      expect.anything(),
      "card",
    );
  });

  it("rejects: records decision, cancels booking, sends rejection email", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
      member: { email: "member@example.com", firstName: "Alex" },
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
    });
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.cancelBooking.mockResolvedValue({
      status: 200,
      data: { success: true, refundAmountCents: 0, refundPercentage: 0, refundMethod: "card" },
    });

    const res = await PATCH(
      makeRequest({ status: "REJECTED", adminNotes: "Need an adult on the booking — sorry." }),
      { params },
    );
    expect(res.status).toBe(200);

    expect(mocks.bookingUpdateMany.mock.calls[0][0].data).toMatchObject({
      adminReviewStatus: "REJECTED",
      adminReviewNotes: "Need an adult on the booking — sorry.",
    });
    expect(mocks.cancelBooking).toHaveBeenCalledWith(
      "b1",
      "admin1",
      "ADMIN",
      expect.any(String),
      "card",
    );
    expect(mocks.sendRejectedEmail).toHaveBeenCalled();
  });

  it("rejects a legacy DRAFT-status queue entry without 500ing (#2266)", async () => {
    // Pre-#2266 rows only: a member draft edit that tripped the no-adult rule
    // used to write adminReviewStatus PENDING while the booking stayed DRAFT.
    // cancelBooking rightly refuses DRAFT, so the route must cancel the draft
    // directly (guarded DRAFT -> CANCELLED) instead of recording-then-500ing.
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "DRAFT",
      member: { email: "member@example.com", firstName: "Alex" },
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
    });
    // First updateMany: the review claim; second: the DRAFT -> CANCELLED flip.
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makeRequest({ status: "REJECTED", adminNotes: "No adult attending." }),
      { params },
    );
    expect(res.status).toBe(200);

    expect(mocks.cancelBooking).not.toHaveBeenCalled();
    const flipArgs = mocks.bookingUpdateMany.mock.calls[1][0];
    expect(flipArgs.where).toMatchObject({ id: "b1", status: "DRAFT" });
    expect(flipArgs.data).toMatchObject({
      status: "CANCELLED",
      draftExpiresAt: null,
    });
    expect(mocks.sendRejectedEmail).toHaveBeenCalled();
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.review.reject" }),
    );
  });

  it("409s (not 500s) when the legacy DRAFT vanished before the cancel flip (#2266)", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "DRAFT",
      member: { email: "member@example.com", firstName: "Alex" },
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
    });
    mocks.bookingUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // review claim
      .mockResolvedValueOnce({ count: 0 }); // draft moved concurrently

    const res = await PATCH(
      makeRequest({ status: "REJECTED", adminNotes: "No adult attending." }),
      { params },
    );
    expect(res.status).toBe(409);
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("returns 409 if another admin already claimed the review (race)", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
      member: { email: "a@b.co", firstName: "A" },
      checkIn: new Date(),
      checkOut: new Date(),
    });
    mocks.bookingUpdateMany.mockResolvedValue({ count: 0 });

    const res = await PATCH(
      makeRequest({ status: "APPROVED", adminNotes: "noted" }),
      { params },
    );
    expect(res.status).toBe(409);
  });
});
