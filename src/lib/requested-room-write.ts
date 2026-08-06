import { Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

export const REQUESTED_ROOM_LOCKED_MESSAGE =
  "Your beds have been allocated by the lodge and can no longer be changed here.";

export class RequestedRoomWriteError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RequestedRoomWriteError";
  }
}

export async function writeRequestedRoom(input: {
  bookingId: string;
  actorMemberId: string;
  actorIsAdmin: boolean;
  requestedRoomId: string | null;
  auditActorLabel: "Admin" | "Member";
}) {
  // These reads resolve immutable identity keys only. Status, ownership,
  // approved-allocation state and the final write fence are evaluated after the
  // global booking lock and booking row lock inside the transaction.
  const [bookingKey, roomKey] = await Promise.all([
    prisma.booking.findUnique({
      where: { id: input.bookingId },
      select: { lodgeId: true },
    }),
    input.requestedRoomId
      ? prisma.lodgeRoom.findUnique({
          where: { id: input.requestedRoomId },
          select: { id: true, name: true, lodgeId: true },
        })
      : Promise.resolve(null),
  ]);
  if (!bookingKey) {
    throw new RequestedRoomWriteError("Booking not found", 404);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await tx.$queryRaw`
      SELECT "id"
      FROM "Booking"
      WHERE "id" = ${input.bookingId}
      FOR UPDATE
    `;

    const booking = await tx.booking.findUnique({
      where: { id: input.bookingId },
      select: {
        memberId: true,
        status: true,
        lodgeId: true,
        bedAllocations: {
          where: { approvedAt: { not: null } },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!booking) {
      throw new RequestedRoomWriteError("Booking not found", 404);
    }
    if (!input.actorIsAdmin && booking.memberId !== input.actorMemberId) {
      throw new RequestedRoomWriteError("Forbidden", 403);
    }
    // Validate the immutable room key only AFTER ownership/authority. A
    // non-owner must not learn whether an arbitrary room id exists or belongs
    // to this booking's lodge.
    if (input.requestedRoomId && !roomKey) {
      throw new RequestedRoomWriteError("Invalid requested room", 400);
    }
    if (roomKey && roomKey.lodgeId !== booking.lodgeId) {
      throw new RequestedRoomWriteError(
        "Requested room belongs to a different lodge than the booking",
        400,
      );
    }
    if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
      throw new RequestedRoomWriteError(
        "Cannot update requested room for cancelled or completed bookings",
        400,
      );
    }
    if (booking.bedAllocations.length > 0 && !input.actorIsAdmin) {
      throw new RequestedRoomWriteError(REQUESTED_ROOM_LOCKED_MESSAGE, 409);
    }
    const guarded = await tx.booking.updateMany({
      where: {
        id: input.bookingId,
        status: { notIn: ["CANCELLED", "COMPLETED"] },
        ...(input.actorIsAdmin ? {} : { memberId: input.actorMemberId }),
        ...(input.actorIsAdmin
          ? {}
          : { bedAllocations: { none: { approvedAt: { not: null } } } }),
      },
      data: { requestedRoomId: input.requestedRoomId },
    });
    if (guarded.count !== 1) {
      throw new RequestedRoomWriteError(
        "The booking changed while the room request was saving. Nothing was written.",
        409,
      );
    }

    const updated = await tx.booking.findUniqueOrThrow({
      where: { id: input.bookingId },
      select: {
        id: true,
        requestedRoomId: true,
        requestedRoom: { select: { id: true, name: true, active: true } },
      },
    });
    await createAuditLog(
      {
        action: input.requestedRoomId
          ? "booking.requested_room.updated"
          : "booking.requested_room.cleared",
        memberId: input.actorMemberId,
        targetId: input.bookingId,
        details: input.requestedRoomId
          ? `${input.auditActorLabel} set requested room to "${roomKey?.name ?? input.requestedRoomId}"`
          : `${input.auditActorLabel} cleared requested room`,
        category: "booking",
        outcome: "success",
      },
      tx,
    );
    return updated;
  });
}

export function requestedRoomWriteErrorResponse(error: unknown) {
  if (error instanceof RequestedRoomWriteError) {
    return { error: error.message, status: error.status };
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  ) {
    return {
      error:
        "The booking changed while the room request was saving. Nothing was written.",
      status: 409,
    };
  }
  return { error: "Requested room update failed", status: 500 };
}
