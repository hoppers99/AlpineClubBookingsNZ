import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2674 — the refund appeal must not be writable on a SOFT-DELETED booking.
 *
 * Why this route rather than the arrival-time write the issue was filed about:
 * the arrival-time handler already refuses a deleted booking as a side effect of
 * a status gate it has for another reason. This one INVERTS that gate — it
 * *requires* `status === "CANCELLED"` — and a soft-deleted booking is CANCELLED
 * permanently (`softDeleteCancelledBooking` is `deletedAt`'s only writer, it
 * refuses anything not already CANCELLED, it never clears the column, and
 * nothing moves a booking back out of CANCELLED). So the appeal passed by
 * construction and wrote a RefundRequest row, a `refund-request.create` audit
 * entry and an admin alert email against a deleted booking.
 *
 * The fixtures use the ONLY shape production can emit — `status: "CANCELLED"`
 * WITH `deletedAt` set — so nothing here is proved against an impossible row.
 *
 * `@/lib/access-roles` is left UN-mocked so the real role resolution decides who
 * reaches the write; the two roles that can are the booking's owner and a Full
 * Admin (`hasAdminAccess`).
 */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  bookingFindUnique: vi.fn(),
  refundRequestFindFirst: vi.fn(),
  refundRequestCreate: vi.fn(),
  logAudit: vi.fn(),
  sendAdminRefundRequestAlert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    },
    refundRequest: {
      findFirst: (...args: unknown[]) => mocks.refundRequestFindFirst(...args),
      create: (...args: unknown[]) => mocks.refundRequestCreate(...args),
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mocks.logAudit(...args),
}));
vi.mock("@/lib/email", () => ({
  sendAdminRefundRequestAlert: (...args: unknown[]) =>
    mocks.sendAdminRefundRequestAlert(...args),
}));

import { POST } from "@/app/api/bookings/[id]/refund-request/route";

const OWNER = {
  user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const FULL_ADMIN = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
const STRANGER = {
  user: { id: "stranger-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

/**
 * A cancelled booking whose PAYMENT MIRROR still shows money left to refund.
 * This is the producible shape, not a contrivance: soft-delete is blocked by
 * `getCancelledBookingDeleteBlockers`, which counts the PaymentTransaction
 * LEDGER, while `getRemainingRefundableCents` reads this MIRROR — so a legacy
 * mirror-only payment (a shape booking-cancel.ts names explicitly) is deletable
 * and refundable-looking at the same time. Delete-then-appeal is also the exact
 * ordering the blocker list cannot cover: it refuses a delete while a
 * RefundRequest exists, so only the appeal AFTER the delete gets through.
 */
function cancelledBooking(deletedAt: Date | null) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "CANCELLED",
    deletedAt,
    checkIn: new Date("2026-07-01"),
    checkOut: new Date("2026-07-03"),
    payment: {
      amountCents: 9000,
      refundedAmountCents: 2000,
      status: "PARTIALLY_REFUNDED",
    },
    member: { firstName: "Alex", lastName: "Example" },
  };
}

const DELETED_AT = new Date("2026-06-01T00:00:00.000Z");

function appealRequest() {
  return new NextRequest(
    "http://localhost/api/bookings/booking-1/refund-request",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "The lodge closed the week we had booked.",
        requestedAmountCents: 5000,
      }),
    },
  );
}

function callRoute() {
  return POST(appealRequest(), {
    params: Promise.resolve({ id: "booking-1" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.refundRequestFindFirst.mockResolvedValue(null);
  mocks.sendAdminRefundRequestAlert.mockResolvedValue(undefined);
  // The write is armed to EXPLODE. A refusal that leaked through would not
  // quietly return the wrong status, it would fail loudly on the write itself.
  mocks.refundRequestCreate.mockImplementation(() => {
    throw new Error(
      "refundRequest.create must never run on a soft-deleted booking",
    );
  });
});

describe("POST /api/bookings/[id]/refund-request — soft-deleted booking (#2674)", () => {
  // 404 for every role, with no Full Admin exemption. The page at
  // bookings/[id]/page.tsx exempts admins because it is a record-VIEWING
  // surface; this is a write, and nothing downstream can act on the row it
  // would create.
  it.each([
    ["the booking's owner", OWNER],
    ["a Full Admin", FULL_ADMIN],
  ])("refuses the appeal with 404 for %s", async (_who, session) => {
    mocks.auth.mockResolvedValue(session);
    mocks.bookingFindUnique.mockResolvedValue(cancelledBooking(DELETED_AT));

    const res = await callRoute();

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Booking not found" });
    // No write, no audit row, no admin alert — and the refusal lands before the
    // route does any further work on the booking at all.
    expect(mocks.refundRequestCreate).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.sendAdminRefundRequestAlert).not.toHaveBeenCalled();
    expect(mocks.refundRequestFindFirst).not.toHaveBeenCalled();
  });

  it("still answers 403, not 404, to a caller with no claim on the booking", async () => {
    // Pins the ORDERING. The deletion check sits after the authorisation check
    // on purpose: checked first it would answer 404 for a deleted booking and
    // 403 for a live one, handing a stranger a deleted-or-live oracle on a
    // booking they have no claim to.
    mocks.auth.mockResolvedValue(STRANGER);
    mocks.bookingFindUnique.mockResolvedValue(cancelledBooking(DELETED_AT));

    const res = await callRoute();

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.refundRequestCreate).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("gives a stranger the same 403 on a booking that is NOT deleted", async () => {
    // The other half of the oracle argument: the unauthorised answer does not
    // move with the booking's deletion state.
    mocks.auth.mockResolvedValue(STRANGER);
    mocks.bookingFindUnique.mockResolvedValue(cancelledBooking(null));

    const res = await callRoute();

    expect(res.status).toBe(403);
    expect(mocks.refundRequestCreate).not.toHaveBeenCalled();
  });

  // The complement. Without these the suite would be satisfied by a route that
  // refused every appeal, which is not the fix.
  it.each([
    ["the booking's owner", OWNER],
    ["a Full Admin", FULL_ADMIN],
  ])(
    "still accepts the appeal on an identical booking that is NOT deleted, for %s",
    async (_who, session) => {
      mocks.auth.mockResolvedValue(session);
      mocks.bookingFindUnique.mockResolvedValue(cancelledBooking(null));
      mocks.refundRequestCreate.mockResolvedValue({ id: "rr-1" });

      const res = await callRoute();

      expect(res.status).toBe(201);
      expect(mocks.refundRequestCreate).toHaveBeenCalledTimes(1);
      expect(mocks.logAudit).toHaveBeenCalledTimes(1);
      expect(mocks.logAudit.mock.calls[0][0]).toMatchObject({
        action: "refund-request.create",
      });
      expect(mocks.sendAdminRefundRequestAlert).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat a missing deletedAt field as deleted", async () => {
    // Defensive: the route reads the booking with `include`, so `deletedAt` is
    // always present in production. A fixture without it must still be live.
    mocks.auth.mockResolvedValue(OWNER);
    const withoutColumn: Record<string, unknown> = cancelledBooking(null);
    delete withoutColumn.deletedAt;
    mocks.bookingFindUnique.mockResolvedValue(withoutColumn);
    mocks.refundRequestCreate.mockResolvedValue({ id: "rr-1" });

    const res = await callRoute();

    expect(res.status).toBe(201);
  });
});
