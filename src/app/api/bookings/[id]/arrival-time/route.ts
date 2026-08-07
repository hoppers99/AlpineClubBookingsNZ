import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { getTodayDateOnly, normalizeDateOnlyForTimeZone } from "@/lib/date-only";
import { hasAdminAccess } from "@/lib/access-roles";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { ARRIVAL_TIME_ERROR_MESSAGE, ARRIVAL_TIME_PATTERN } from "@/lib/arrival-time";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";

// #2621 — WHY THERE IS NO ADVISORY LOCK ON THIS ROUTE.
//
// Every other write on a booking that this route's neighbours perform takes the
// per-booking advisory lock, because those writes read state, decide something
// from it, and write a derived result — so two concurrent requests can compute
// from the same stale read and both be wrong. This route does none of that. It
// writes ONE scalar column to a value supplied whole by the caller, and that
// column is display-only information (owner decision, 8 Aug): it gates no
// capacity, no money, no chore assignment and no state machine. Two admins
// setting a time at the same instant should end with one of the two times, and
// last-write-wins gives exactly that. A lock here would buy a stricter ordering
// nobody can observe, at the cost of taking the booking's lock — and blocking a
// payment or a modification behind it — for a field that decides nothing.
//
// The pre-write guards (status, check-in date) are read outside the update and
// so are advisory rather than atomic. That is the pre-existing shape and it is
// tolerable for the same reason: the worst outcome of losing that race is an
// arrival time recorded on a booking that was cancelled a millisecond ago,
// which displays nowhere because every reader filters on status.

// #2621: the accepted-value rule is `ARRIVAL_TIME_PATTERN`, imported rather
// than re-spelled here. The literal that used to live on this line read
// `[0-5]0` and so accepted :10/:20/:40/:50 while the message beside it promised
// 30-minute increments.
const arrivalTimeSchema = z.object({
  expectedArrivalTime: z
    .string()
    .regex(ARRIVAL_TIME_PATTERN, ARRIVAL_TIME_ERROR_MESSAGE),
});

/**
 * PUT /api/bookings/[id]/arrival-time
 * Set or update the expected arrival time on a booking.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    // #2621: `expectedArrivalTime` is selected only so the audit entry can
    // record the old→new pair. An audit row that says "changed" without saying
    // what it changed from cannot answer the question it exists for.
    select: {
      memberId: true,
      checkIn: true,
      status: true,
      expectedArrivalTime: true,
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Only booking owner or admin can update
  // Issue #1313 (option A2): owner, Full Admin, or Booking Officer
  // (bookings:edit) may set/clear the expected arrival time on any booking.
  if (
    booking.memberId !== session.user.id &&
    !hasAdminAccess(session.user) &&
    !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return NextResponse.json(
      { error: "Cannot update arrival time for cancelled or completed bookings" },
      { status: 400 }
    );
  }

  // Cannot update after check-in date has passed
  const today = getTodayDateOnly();
  if (normalizeDateOnlyForTimeZone(booking.checkIn) < today) {
    return NextResponse.json(
      { error: "Cannot update arrival time after check-in date has passed" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = arrivalTimeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { expectedArrivalTime: parsed.data.expectedArrivalTime },
    select: { id: true, expectedArrivalTime: true },
  });

  // #2621: this route wrote to a booking and recorded nothing. It is reachable
  // by a Booking Officer on ANY member's booking (#1313 option A2), so a member
  // seeing a time they did not set had no way to find out who set it. `memberId`
  // is the actor, `subjectMemberId` the booking owner, so an officer edit and a
  // self-edit are distinguishable at a glance. `previous` may be null — that is
  // the first-ever set, and it is a fact worth recording.
  logAudit({
    action: "booking.arrival-time.set",
    memberId: session.user.id,
    targetId: id,
    subjectMemberId: booking.memberId,
    entityType: "Booking",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary: "Expected arrival time set",
    details: `${booking.expectedArrivalTime ?? "(not set)"} → ${updated.expectedArrivalTime}`,
    metadata: {
      bookingId: id,
      previousArrivalTime: booking.expectedArrivalTime,
      newArrivalTime: updated.expectedArrivalTime,
      byOwner: booking.memberId === session.user.id,
    },
    ipAddress: getClientIp(req),
  });

  return NextResponse.json(updated);
}

/**
 * DELETE /api/bookings/[id]/arrival-time
 * Clear the expected arrival time.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    // #2621: the cleared value, so the audit entry can say what was removed.
    select: {
      memberId: true,
      checkIn: true,
      status: true,
      expectedArrivalTime: true,
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Issue #1313 (option A2): owner, Full Admin, or Booking Officer
  // (bookings:edit) may set/clear the expected arrival time on any booking.
  if (
    booking.memberId !== session.user.id &&
    !hasAdminAccess(session.user) &&
    !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return NextResponse.json(
      { error: "Cannot update arrival time for cancelled or completed bookings" },
      { status: 400 }
    );
  }

  const today = getTodayDateOnly();
  if (normalizeDateOnlyForTimeZone(booking.checkIn) < today) {
    return NextResponse.json(
      { error: "Cannot update arrival time after check-in date has passed" },
      { status: 400 }
    );
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { expectedArrivalTime: null },
    select: { id: true, expectedArrivalTime: true },
  });

  // #2621: a clear is recorded on the same terms as a set — the same action
  // family, so one query over `booking.arrival-time.*` returns the whole history
  // of the field on a booking rather than only the halves that added a value.
  logAudit({
    action: "booking.arrival-time.clear",
    memberId: session.user.id,
    targetId: id,
    subjectMemberId: booking.memberId,
    entityType: "Booking",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary: "Expected arrival time cleared",
    details: `${booking.expectedArrivalTime ?? "(not set)"} → (not set)`,
    metadata: {
      bookingId: id,
      previousArrivalTime: booking.expectedArrivalTime,
      newArrivalTime: null,
      byOwner: booking.memberId === session.user.id,
    },
    ipAddress: getClientIp(req),
  });

  return NextResponse.json(updated);
}
