import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgeTier } from "@prisma/client";

// booking-request.ts creates a PrismaClient at import time; stub it so importing
// the module under test never touches a real database.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { reassignHeldBookingGuests } from "@/lib/booking-request";
import type { MemberGuestAddPolicy } from "@/lib/member-guest-add-policy";

/**
 * The transaction double.
 *
 * `familyGroupMember` and `member` are here because MG4 (#2309) computes the
 * family boundary inside this function: the held booking's owner is a non-login
 * contact in no family group, so both reads legitimately come back empty and
 * every linked member classifies BEYOND_FAMILY. Returning empty arrays is the
 * REAL production shape, not a shortcut — see `computeMemberGuestBoundary`.
 */
function makeTx() {
  return {
    bookingGuest: {
      findMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
    },
    familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
    member: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

const guest = (overrides: Record<string, unknown> = {}) => ({
  firstName: "Tara",
  lastName: "Tester",
  ageTier: AgeTier.ADULT,
  isMember: false,
  memberId: undefined,
  stayStart: new Date("2026-08-01T00:00:00.000Z"),
  stayEnd: new Date("2026-08-03T00:00:00.000Z"),
  priceCents: 5000,
  ...overrides,
});

const MODULE_ON: MemberGuestAddPolicy = {
  wideningEnabled: true,
  approvalRequired: true,
  pendingHoldExpiryDays: 7,
};
const MODULE_OFF: MemberGuestAddPolicy = {
  wideningEnabled: false,
  approvalRequired: true,
  pendingHoldExpiryDays: 0,
};

const NOW = new Date("2026-07-01T09:00:00.000Z");

const memberGuest = (policy: MemberGuestAddPolicy = MODULE_ON) => ({
  bookingOwnerMemberId: "owner-1",
  actor: { kind: "BOOKING_REQUEST" as const, adminMemberId: "admin-1" },
  policy,
  bookingCheckIn: new Date("2026-08-01T00:00:00.000Z"),
  now: NOW,
});

describe("reassignHeldBookingGuests (issue #1254 bed preservation)", () => {
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
  });

  it("updates the existing rows in place (stable ids) when counts match", async () => {
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: null, consentStatus: null },
      { id: "g2", memberId: "m-1", consentStatus: "CONFIRMED" },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [
        guest({ priceCents: 3000 }),
        guest({ firstName: "Sam", isMember: true, memberId: "m-1", priceCents: 7000 }),
      ],
      memberGuest(),
    );

    expect(result.preservedInPlace).toBe(true);
    expect(result.displacedMemberIds).toEqual([]);
    // No destructive delete — that is what preserves BedAllocation / #713 nights /
    // promo targets / chores that cascade off bookingGuest ids.
    expect(tx.bookingGuest.deleteMany).not.toHaveBeenCalled();
    expect(tx.bookingGuest.createMany).not.toHaveBeenCalled();
    expect(tx.bookingGuest.update).toHaveBeenCalledTimes(2);
    expect(tx.bookingGuest.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: "g1" },
        data: expect.objectContaining({ priceCents: 3000, memberId: null }),
      })
    );
    expect(tx.bookingGuest.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "g2" },
        data: expect.objectContaining({ memberId: "m-1", isMember: true }),
      })
    );
  });

  it("falls back to delete+recreate when the row count diverges", async () => {
    tx.bookingGuest.findMany
      .mockResolvedValueOnce([{ id: "g1", memberId: null, consentStatus: null }])
      // The read-back after createMany, so the notification plan can be matched
      // to rows that only exist once the write has happened.
      .mockResolvedValueOnce([
        { id: "g9", memberId: null },
        { id: "g10", memberId: null },
      ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest(), guest({ firstName: "Sam" })],
      memberGuest(),
    );

    expect(result.preservedInPlace).toBe(false);
    expect(tx.bookingGuest.deleteMany).toHaveBeenCalledWith({
      where: { bookingId: "held-1" },
    });
    expect(tx.bookingGuest.createMany).toHaveBeenCalledTimes(1);
    expect(tx.bookingGuest.update).not.toHaveBeenCalled();
  });
});

describe("reassignHeldBookingGuests — MG4-D-b consent stamping (#2309)", () => {
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
  });

  it("stamps a cross-family member link CONFIRMED against the approving officer, and owes them a notice", async () => {
    // The row was created by the hold with no member on it, so nobody has been
    // told anything yet: this approval is the moment Sam is placed.
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: null, consentStatus: null },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sam", isMember: true, memberId: "m-sam" })],
      memberGuest(),
    );

    expect(tx.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "g1" },
        data: expect.objectContaining({
          memberId: "m-sam",
          // ADMIN_ASSIGNED: consent-free, immediately CONFIRMED, naming the
          // officer who stood behind it. NOT a PENDING request — MG4-D-b.
          consentStatus: "CONFIRMED",
          consentRequestedAt: null,
          consentRespondedAt: NOW,
          consentRespondedByMemberId: "admin-1",
          consentExpiresAt: null,
        }),
      })
    );
    expect(result.memberGuestNotificationRows).toEqual([
      { bookingGuestId: "g1", targetMemberId: "m-sam", notification: "ADDED_NOTICE" },
    ]);
  });

  it("tells BOTH people when one member guest is substituted for another in place", async () => {
    // The subtle case: the row id is preserved, so nothing about the write
    // looks like a removal — but the person on it has changed.
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: "m-priya", consentStatus: "CONFIRMED" },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sione", isMember: true, memberId: "m-sione" })],
      memberGuest(),
    );

    expect(result.preservedInPlace).toBe(true);
    // The newcomer is told they are on it...
    expect(result.memberGuestNotificationRows).toEqual([
      { bookingGuestId: "g1", targetMemberId: "m-sione", notification: "ADDED_NOTICE" },
    ]);
    // ...and the person quietly swapped out is told they are not.
    expect(result.displacedMemberIds).toEqual(["m-priya"]);
  });

  it("does not tell a member twice when the swap leaves them exactly where they were", async () => {
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: "m-sam", consentStatus: "CONFIRMED" },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sam", isMember: true, memberId: "m-sam" })],
      memberGuest(),
    );

    // The columns are still re-stamped — the approval-time list is
    // authoritative — but Sam was told at hold time and is not told again.
    expect(result.memberGuestNotificationRows).toEqual([]);
    expect(result.displacedMemberIds).toEqual([]);
  });

  it("clears a stale consent record when a row is reused for somebody who was never asked", async () => {
    // Module OFF: no consent columns are planned for the incoming row. The row
    // being reused carries the previous occupant's CONFIRMED, and leaving it
    // there would claim consent for a person who was never asked and never told.
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: "m-priya", consentStatus: "CONFIRMED" },
    ]);

    await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sione", isMember: true, memberId: "m-sione" })],
      memberGuest(MODULE_OFF),
    );

    expect(tx.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberId: "m-sione",
          consentStatus: null,
          consentRequestedAt: null,
          consentRespondedAt: null,
          consentRespondedByMemberId: null,
          consentExpiresAt: null,
        }),
      })
    );
  });

  it("writes no consent columns and owes no notice while the module is off", async () => {
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: null, consentStatus: null },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sam", isMember: true, memberId: "m-sam" })],
      memberGuest(MODULE_OFF),
    );

    expect(result.memberGuestNotificationRows).toEqual([]);
    expect(tx.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ consentStatus: null }),
      })
    );
  });
});
