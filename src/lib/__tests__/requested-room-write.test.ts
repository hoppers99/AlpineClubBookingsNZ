import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, prismaMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  prismaMock: {
    booking: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    lodgeRoom: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { writeRequestedRoom } from "@/lib/requested-room-write";

describe("requested room authoritative write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock),
    );
    prismaMock.booking.findUnique
      .mockResolvedValueOnce({ id: "booking-1" })
      .mockResolvedValueOnce({
        memberId: "owner-1",
        status: "PAID",
        lodgeId: "lodge-1",
        bedAllocations: [],
      });
    prismaMock.lodgeRoom.findUnique.mockResolvedValue({
      id: "room-1",
      name: "Room 1",
      lodgeId: "lodge-1",
    });
    prismaMock.booking.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.booking.findUniqueOrThrow.mockResolvedValue({
      id: "booking-1",
      requestedRoomId: "room-1",
      requestedRoom: { id: "room-1", name: "Room 1", active: true },
    });
    auditMock.mockResolvedValue(undefined);
  });

  it.each(["missing", "cross-lodge"])(
    "returns forbidden to a non-owner before exposing a %s room",
    async () => {
      await expect(
        writeRequestedRoom({
          bookingId: "booking-1",
          actorMemberId: "stranger-1",
          actorIsAdmin: false,
          requestedRoomId: "room-probe",
          auditActorLabel: "Member",
        }),
      ).rejects.toMatchObject({ status: 403, message: "Forbidden" });
      expect(prismaMock.lodgeRoom.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    },
  );

  it("re-reads ownership, status and final-approved state after the global and row locks", async () => {
    await writeRequestedRoom({
      bookingId: "booking-1",
      actorMemberId: "owner-1",
      actorIsAdmin: false,
      requestedRoomId: "room-1",
      auditActorLabel: "Member",
    });

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
    const [bookingIdentityRead, authoritativeBookingRead] =
      prismaMock.booking.findUnique.mock.invocationCallOrder;
    const [globalLockCall, bookingRowLockCall] =
      prismaMock.$executeRaw.mock.invocationCallOrder;
    const [authoritativeRoomRead] =
      prismaMock.lodgeRoom.findUnique.mock.invocationCallOrder;
    expect(bookingIdentityRead).toBeLessThan(globalLockCall);
    expect(globalLockCall).toBeLessThan(bookingRowLockCall);
    expect(bookingRowLockCall).toBeLessThan(authoritativeBookingRead);
    expect(authoritativeBookingRead).toBeLessThan(authoritativeRoomRead);
    expect(authoritativeRoomRead).toBeLessThan(
      prismaMock.booking.updateMany.mock.invocationCallOrder[0],
    );
    expect(prismaMock.booking.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      auditMock.mock.invocationCallOrder[0],
    );
    expect(prismaMock.booking.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "booking-1",
        memberId: "owner-1",
        bedAllocations: { none: { approvedAt: { not: null } } },
      }),
      data: { requestedRoomId: "room-1" },
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it("returns invalid room when the authoritative under-lock read finds it deleted", async () => {
    prismaMock.lodgeRoom.findUnique.mockResolvedValueOnce(null);

    await expect(
      writeRequestedRoom({
        bookingId: "booking-1",
        actorMemberId: "owner-1",
        actorIsAdmin: false,
        requestedRoomId: "room-1",
        auditActorLabel: "Member",
      }),
    ).rejects.toMatchObject({ status: 400, message: "Invalid requested room" });

    expect(prismaMock.lodgeRoom.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("uses the authoritative under-lock room name in the committed audit", async () => {
    prismaMock.lodgeRoom.findUnique.mockResolvedValueOnce({
      id: "room-1",
      name: "Room renamed under lock",
      lodgeId: "lodge-1",
    });
    prismaMock.booking.findUniqueOrThrow.mockResolvedValueOnce({
      id: "booking-1",
      requestedRoomId: "room-1",
      requestedRoom: {
        id: "room-1",
        name: "Room renamed under lock",
        active: true,
      },
    });

    await writeRequestedRoom({
      bookingId: "booking-1",
      actorMemberId: "owner-1",
      actorIsAdmin: false,
      requestedRoomId: "room-1",
      auditActorLabel: "Member",
    });

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        details: 'Member set requested room to "Room renamed under lock"',
      }),
      prismaMock,
    );
  });

  it("refuses a member write after an approved allocation appears", async () => {
    prismaMock.booking.findUnique.mockReset();
    prismaMock.booking.findUnique
      .mockResolvedValueOnce({ id: "booking-1" })
      .mockResolvedValueOnce({
        memberId: "owner-1",
        status: "PAID",
        lodgeId: "lodge-1",
        bedAllocations: [{ id: "approved-1" }],
      });

    await expect(
      writeRequestedRoom({
        bookingId: "booking-1",
        actorMemberId: "owner-1",
        actorIsAdmin: false,
        requestedRoomId: "room-1",
        auditActorLabel: "Member",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
  });
});
