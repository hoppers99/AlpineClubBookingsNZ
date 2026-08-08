// The admin repair for a stranded zero-dollar waitlist confirm (#2649).
//
// This route is a booking-status writer on a capacity-holding status, so the
// things worth pinning are not the happy path but the refusals: which shapes it
// declines, and the proof that a claim lost to a concurrent writer leaves NO
// trace — no allocation reconcile, no audit row, no member email, and no
// waitlist sweep.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    booking: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(),
    requireAdmin: vi.fn(),
    acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
    reconcile: vi.fn(),
    sendWaitlistOfferExpiredEmail: vi.fn(),
    processWaitlistForDates: vi.fn(),
    loggerError: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: mocks.reconcile,
}));

vi.mock("@/lib/email", () => ({
  sendWaitlistOfferExpiredEmail: mocks.sendWaitlistOfferExpiredEmail,
}));

vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));

import { POST } from "@/app/api/admin/bookings/[id]/return-to-waitlist/route";
import { WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION } from "@/lib/waitlist-confirm-recovery-contract";
import {
  RETURN_TO_WAITLIST_AUDIT_ACTION,
  RETURN_TO_WAITLIST_CLAIM_LOST_MESSAGE,
  RETURN_TO_WAITLIST_PAYMENT_PRESENT_MESSAGE,
  RETURN_TO_WAITLIST_PRICED_MESSAGE,
  RETURN_TO_WAITLIST_STATUS_MESSAGE,
} from "@/lib/waitlist-return-contract";

const CHECK_IN = new Date("2026-07-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-07-03T00:00:00.000Z");

function returnRequest() {
  return new NextRequest(
    "http://localhost/api/admin/bookings/booking-1/return-to-waitlist",
    {
      method: "POST",
      headers: {
        "x-request-id": "request-1",
        "x-forwarded-for": "203.0.113.5",
        "user-agent": "vitest",
      },
    },
  );
}

function routeParams() {
  return { params: Promise.resolve({ id: "booking-1" }) };
}

/** The immutable identity read taken before the lodge lock. */
function keyRow() {
  return {
    lodgeId: "lodge-1",
    memberId: "member-1",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

/** The mutable re-read taken under both locks. */
function strandedRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "PAYMENT_PENDING",
    finalPriceCents: 0,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    waitlistOfferedLodgeId: null,
    member: { email: "member@example.com", firstName: "Alex" },
    payment: null,
    ...overrides,
  };
}

/**
 * The route reads immutable identity first and everything mutable second. Route
 * the two `findUnique` calls by the shape they ask for rather than by call
 * order, so a reordering inside the route shows up as a wrong answer instead of
 * silently passing.
 */
function bookingReads(mutable: Record<string, unknown> | null) {
  mocks.tx.booking.findUnique.mockImplementation(
    async (args: { select?: Record<string, unknown> }) =>
      args.select && "lodgeId" in args.select && !("status" in args.select)
        ? keyRow()
        : mutable,
  );
}

describe("POST /api/admin/bookings/[id]/return-to-waitlist (#2649)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.transaction.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(mocks.tx),
    );
    bookingReads(strandedRow());
    mocks.tx.booking.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.booking.count.mockResolvedValue(2);
    mocks.tx.auditLog.findFirst.mockResolvedValue({
      id: "audit-strand-1",
      createdAt: new Date("2026-06-20T00:00:00.000Z"),
    });
    mocks.tx.auditLog.create.mockResolvedValue({});
    mocks.reconcile.mockResolvedValue(undefined);
    mocks.sendWaitlistOfferExpiredEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue({ offeredBookingId: null });
  });

  it("puts the member back in the queue and clears the consumed offer", async () => {
    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      status: "WAITLISTED",
      waitlistPosition: 3,
    });

    // The claim re-asserts BOTH facts that made this booking eligible, so a
    // concurrent re-price or status move matches no row.
    expect(mocks.tx.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: "PAYMENT_PENDING",
        finalPriceCents: 0,
      },
      data: {
        status: "WAITLISTED",
        waitlistPosition: null,
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        waitlistOfferedLodgeId: null,
        waitlistOfferedPriceCents: null,
      },
    });

    expect(mocks.reconcile).toHaveBeenCalledWith({
      bookingId: "booking-1",
      db: mocks.tx,
      previousRange: { checkIn: CHECK_IN, checkOut: CHECK_OUT },
    });
  });

  it("takes the global lock before the lodge lock, and re-reads mutable state after both", async () => {
    await POST(returnRequest(), routeParams());

    const globalLock = mocks.tx.$executeRaw.mock.invocationCallOrder[0];
    const lodgeLock = mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0];
    const mutableRead = mocks.tx.booking.findUnique.mock.invocationCallOrder[1];
    const claim = mocks.tx.booking.updateMany.mock.invocationCallOrder[0];

    expect(globalLock).toBeLessThan(lodgeLock);
    expect(lodgeLock).toBeLessThan(mutableRead);
    expect(mutableRead).toBeLessThan(claim);
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      mocks.tx,
      "lodge-1",
    );
  });

  it("records the audit row that closes the strand's trail", async () => {
    await POST(returnRequest(), routeParams());

    expect(mocks.tx.auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          action: WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION,
          targetId: "booking-1",
        },
      }),
    );
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: RETURN_TO_WAITLIST_AUDIT_ACTION,
        memberId: "admin-1",
        actorMemberId: "admin-1",
        subjectMemberId: "member-1",
        targetId: "booking-1",
        entityType: "Booking",
        entityId: "booking-1",
        category: "booking",
        outcome: "success",
        requestId: "request-1",
        ipAddress: "203.0.113.5",
        userAgent: "vitest",
        metadata: expect.objectContaining({
          previousStatus: "PAYMENT_PENDING",
          nextStatus: "WAITLISTED",
          finalPriceCents: 0,
          waitlistPosition: 3,
          resolvesAuditLogId: "audit-strand-1",
        }),
      }),
    });
  });

  it("still repairs a booking whose strand row has been pruned", async () => {
    mocks.tx.auditLog.findFirst.mockResolvedValue(null);

    const response = await POST(returnRequest(), routeParams());

    expect(response.status).toBe(200);
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          resolvesAuditLogId: null,
          resolvesAuditLogAt: null,
        }),
      }),
    });
  });

  it("tells the member their place is back, and re-offers the beds it freed", async () => {
    await POST(returnRequest(), routeParams());

    expect(mocks.sendWaitlistOfferExpiredEmail).toHaveBeenCalledWith(
      { bookingId: "booking-1", recipientMemberId: "member-1" },
      "member@example.com",
      "Alex",
      CHECK_IN,
      CHECK_OUT,
      3,
      "lodge-1",
    );
    expect(mocks.processWaitlistForDates).toHaveBeenCalledWith({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      lodgeId: "lodge-1",
    });
  });

  it("re-offers at the lodge whose bed was offered on a cross-lodge offer", async () => {
    bookingReads(strandedRow({ waitlistOfferedLodgeId: "lodge-2" }));

    await POST(returnRequest(), routeParams());

    expect(mocks.processWaitlistForDates).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-2" }),
    );
    // The member's own lodge still brands their email.
    expect(mocks.sendWaitlistOfferExpiredEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      CHECK_IN,
      CHECK_OUT,
      3,
      "lodge-1",
    );
  });

  it("a claim lost to a concurrent writer runs NO side effect", async () => {
    // The booking passed every guard when it was re-read, then another writer
    // moved it between the re-read and the claim. This is the case the status
    // guard exists for, and it must leave nothing behind.
    mocks.tx.booking.updateMany.mockResolvedValue({ count: 0 });

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: RETURN_TO_WAITLIST_CLAIM_LOST_MESSAGE });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.sendWaitlistOfferExpiredEmail).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
  });

  it("refuses a booking a concurrent confirm already moved out of PAYMENT_PENDING", async () => {
    bookingReads(strandedRow({ status: "PAID" }));

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: RETURN_TO_WAITLIST_STATUS_MESSAGE });
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.sendWaitlistOfferExpiredEmail).not.toHaveBeenCalled();
  });

  it("refuses a booking a concurrent cancel already took", async () => {
    bookingReads(strandedRow({ status: "CANCELLED" }));

    const response = await POST(returnRequest(), routeParams());

    expect(response.status).toBe(409);
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a priced booking: it has a payment path and is not stranded", async () => {
    bookingReads(strandedRow({ finalPriceCents: 12000 }));

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: RETURN_TO_WAITLIST_PRICED_MESSAGE });
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a booking that already has a payment record", async () => {
    bookingReads(strandedRow({ payment: { id: "payment-1" } }));

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: RETURN_TO_WAITLIST_PAYMENT_PRESENT_MESSAGE,
    });
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("404s an unknown booking before taking the lodge lock", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(null);

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: "Booking not found" });
    expect(mocks.acquireLodgeCapacityLock).not.toHaveBeenCalled();
  });

  it("answers 403 without touching the database when the admin cannot edit bookings", async () => {
    const { NextResponse } = await import("next/server");
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await POST(returnRequest(), routeParams());

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a 500 without claiming the repair happened", async () => {
    mocks.transaction.mockRejectedValue(new Error("lock wait timeout"));

    const response = await POST(returnRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "Failed to return the booking to the waitlist",
    });
    expect(mocks.sendWaitlistOfferExpiredEmail).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalled();
  });
});
