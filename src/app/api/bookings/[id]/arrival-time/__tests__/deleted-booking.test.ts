import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2674 — the expected-arrival-time route and soft-deleted bookings.
 *
 * WHAT THIS SUITE IS ACTUALLY PINNING, because the issue that filed it claimed
 * more than was true and the tests should not repeat the claim.
 *
 * The issue said a soft-deleted booking could be WRITTEN through this route.
 * It could not. `Booking.deletedAt` has exactly one writer in the repo —
 * `softDeleteCancelledBooking` in `src/lib/booking-delete.ts` — and it refuses
 * anything whose status is not `CANCELLED`; nothing anywhere moves a booking
 * back out of `CANCELLED`. So every soft-deleted booking is a cancelled one,
 * and this route's status gate already refused these requests with a 400 before
 * the transaction. No write landed and no audit row was written, on `main`,
 * before this change.
 *
 * What WAS wrong is the answer and the contract. A record the club considers
 * gone read back as merely "cancelled", and the route's safety rested on a gate
 * about something else — so the two properties worth pinning are:
 *
 *  - a soft-deleted booking answers **404**, not 400, for EVERY role, so the
 *    absence of a Full Admin exemption is asserted rather than incidental; and
 *  - the check sits AFTER authorisation, so a caller with no claim on the
 *    booking still gets 403 and cannot use this route as a deleted-or-live
 *    oracle.
 *
 * The mutation proof is the 400: delete the guard and these tests fail with
 * `expected 400 to be 404`, which is exactly the observable difference the fix
 * makes. That is only meaningful because the fixtures are honest — a deleted
 * booking here is always CANCELLED too, the only shape production can emit.
 *
 * `@/lib/access-roles` and `@/lib/admin-permissions` are left UN-mocked so the
 * real role resolution runs.
 */
const {
  mockAuth,
  mockRequireActiveSessionUser,
  mockBookingFindUnique,
  mockTransaction,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireActiveSessionUser: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) =>
    mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mockBookingFindUnique },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const OWNER = {
  user: { id: "owner-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const STRANGER = {
  user: { id: "stranger-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const FULL_ADMIN = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
// A Booking Officer: `bookings:edit` through the ADMIN_BOOKINGS bundle and no
// Full Admin role. #1313 option A2 lets all three of these write this field.
const BOOKING_OFFICER = {
  user: {
    id: "officer-1",
    role: "MEMBER",
    accessRoles: [{ role: "ADMIN_BOOKINGS" }],
  },
};

const WRITERS: ReadonlyArray<[string, typeof OWNER]> = [
  ["the owner", OWNER],
  ["a bookings:edit Booking Officer", BOOKING_OFFICER],
  ["a Full Admin", FULL_ADMIN],
];

/**
 * A soft-deleted booking, which is necessarily CANCELLED — see the header. The
 * check-in is far in the future so the date gate cannot be what refuses, and
 * the status is the one production would really carry so the 400 the old code
 * returned is the one being replaced.
 */
function deletedBooking() {
  return {
    memberId: "owner-1",
    checkIn: new Date("2099-01-02T00:00:00.000Z"),
    status: "CANCELLED",
    deletedAt: new Date("2026-08-01T00:00:00.000Z"),
  };
}

/** The same booking still live: confirmed, future, never deleted. */
function liveBooking() {
  return {
    memberId: "owner-1",
    checkIn: new Date("2099-01-02T00:00:00.000Z"),
    status: "CONFIRMED",
    deletedAt: null,
  };
}

async function callPut(session: unknown, booking: unknown) {
  mockAuth.mockResolvedValue(session);
  mockBookingFindUnique.mockResolvedValue(booking);
  const { PUT } = await import("@/app/api/bookings/[id]/arrival-time/route");
  return PUT(
    new NextRequest("http://localhost/api/bookings/booking-1/arrival-time", {
      method: "PUT",
      body: JSON.stringify({ expectedArrivalTime: "18:00" }),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

async function callDelete(session: unknown, booking: unknown) {
  mockAuth.mockResolvedValue(session);
  mockBookingFindUnique.mockResolvedValue(booking);
  const { DELETE } = await import("@/app/api/bookings/[id]/arrival-time/route");
  return DELETE(
    new NextRequest("http://localhost/api/bookings/booking-1/arrival-time", {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

const CALLS: ReadonlyArray<[string, typeof callPut]> = [
  ["PUT", callPut],
  ["DELETE", callDelete],
];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireActiveSessionUser.mockResolvedValue(null);
  // If a refused request ever reaches the write, this records it loudly rather
  // than quietly returning a plausible body.
  mockTransaction.mockImplementation(async () => {
    throw new Error("the write must not be reached on a refused request");
  });
});

describe("arrival-time on a soft-deleted booking (#2674)", () => {
  for (const [callName, call] of CALLS) {
    for (const [roleName, session] of WRITERS) {
      it(`${callName} answers 404 to ${roleName}`, async () => {
        const res = await call(session, deletedBooking());

        // 404, not the 400 the status gate used to answer with. Asserting the
        // body too, because "Booking not found" is the sentence that makes the
        // record read as gone rather than as cancelled.
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "Booking not found" });
      });
    }
  }

  it("selects deletedAt beside the authority fields, on both halves", async () => {
    // The guard cannot be right if the column never arrives. Pinning the select
    // stops a later narrowing of it from turning the guard into dead code that
    // reads `undefined` and passes.
    await callPut(OWNER, deletedBooking());
    expect(mockBookingFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ deletedAt: true }),
      }),
    );

    vi.clearAllMocks();
    mockRequireActiveSessionUser.mockResolvedValue(null);
    await callDelete(OWNER, deletedBooking());
    expect(mockBookingFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ deletedAt: true }),
      }),
    );
  });

  for (const [callName, call] of CALLS) {
    it(`${callName} writes no audit row when it refuses`, async () => {
      await call(FULL_ADMIN, deletedBooking());

      // The issue's stated harm was audit entries accruing against a deleted
      // booking. Nothing is recorded on a refusal — and nothing reached the
      // transaction either, which `mockTransaction` would have thrown over.
      expect(mockLogAudit).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  }

  for (const [callName, call] of CALLS) {
    it(`${callName} still answers 403 to a caller with no claim on the booking`, async () => {
      // ORDERING. The deletion check sits after authorisation, so a stranger
      // learns only that they may not touch this booking — never whether it
      // exists and is deleted. Flip the two and this becomes 404 and the route
      // turns into a deleted-or-live oracle for anyone who can guess an id.
      const res = await call(STRANGER, deletedBooking());

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });
  }

  it("leaves a live booking alone: the guard refuses nothing it should not", async () => {
    // The complement, so the tests above cannot be satisfied by a route that
    // refuses everything. A live booking reaches the write.
    mockTransaction.mockImplementation(async () => ({
      previous: null,
      updated: { id: "booking-1", expectedArrivalTime: "18:00" },
    }));

    const res = await callPut(OWNER, liveBooking());

    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalled();
  });
});
