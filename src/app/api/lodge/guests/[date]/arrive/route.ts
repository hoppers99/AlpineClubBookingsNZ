import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, getLodgeAuthActorMemberId, kioskLodgeAuthErrorResponse, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { findLodgeGuestForDate } from "@/lib/lodge-date-scoping";
import { isGuestReturningOnDay } from "@/lib/booking-guest-stay-ranges";
import { parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { logAudit, getAuditRequestContext } from "@/lib/audit";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bodySchema = z.object({
  bookingGuestId: z.string().min(1),
});

/**
 * PUT /api/lodge/guests/[date]/arrive
 * Mark a guest as arrived (sets arrivedAt timestamp).
 * Sending again toggles off (clears arrivedAt).
 * Requires tier >= lodge (staying-guest cannot mark arrivals).
 *
 * ONE ATTENDANCE PAIR PER STAY, NOT A LOG (#2628). `arrivedAt`/`departedAt`
 * answers "where is this person now", and a sparse stay arrives more than once:
 * nights {11, 14} means checking out on the 12th and checking back in on the
 * 14th. On that RETURN both stored values are stale — `arrivedAt` from the first
 * segment (so a plain toggle would UN-arrive them) and `departedAt` from the
 * 12th (so the kiosk would grey the row and the next check-out would clear the
 * first one instead of recording the second). So a return is not a toggle: it
 * always marks arrived, and it clears the superseded departure. Everything else
 * is the toggle it has always been, and a contiguous stay can never be a return
 * (`isGuestReturningOnDay` is false for every day of one), so the ordinary path
 * is untouched.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const authResult = await checkLodgeAuth(dateStr, { request: req });
  const { error, status, tier } = authResult;
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  // Staying guests cannot mark arrivals
  if (tier === "staying-guest") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }
  const date = parseDateOnly(dateStr);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const lodgeId = await resolveKioskLodgeId(authResult, prisma);
    const guest = await findLodgeGuestForDate(parsed.data.bookingGuestId, date, lodgeId);

    if (!guest) {
      return NextResponse.json(
        { error: "Guest not found for this date" },
        { status: 404 }
      );
    }

    // A RETURN supersedes the stay's stale attendance pair; anything else is
    // the plain toggle. See the header — this is only ever true on a sparse
    // stay's second or later segment.
    const isReturn =
      Boolean(guest.departedAt) &&
      isGuestReturningOnDay(guest, date, guest.booking);
    const arrivedAt = isReturn || !guest.arrivedAt ? new Date() : null;

    await prisma.bookingGuest.update({
      where: { id: parsed.data.bookingGuestId },
      data: isReturn ? { arrivedAt, departedAt: null } : { arrivedAt },
    });

    const actorMemberId = getLodgeAuthActorMemberId(authResult);
    const auditRequest = getAuditRequestContext(req);
    const markedArrived = Boolean(arrivedAt);
    logAudit({
      action: markedArrived
        ? "lodge.guest.arrived"
        : "lodge.guest.arrival_cleared",
      memberId: actorMemberId,
      targetId: guest.id,
      subjectMemberId: guest.memberId ?? guest.booking.memberId,
      entityType: "BookingGuest",
      entityId: guest.id,
      category: "lodge",
      severity: "important",
      outcome: "success",
      summary: markedArrived
        ? "Guest marked arrived"
        : "Guest arrival cleared",
      details: `${markedArrived ? "Marked guest arrived" : "Cleared guest arrival"} for ${dateStr}`,
      metadata: {
        date: dateStr,
        tier,
        // #2628: a return also cleared a departure recorded on an earlier
        // segment, so say so rather than leaving that write unexplained.
        clearedEarlierDeparture: isReturn,
        bookingId: guest.bookingId,
        bookingGuestId: guest.id,
        bookingMemberId: guest.booking.memberId,
        guestMemberId: guest.memberId,
        guestName: `${guest.firstName} ${guest.lastName}`,
      },
      ipAddress: auditRequest?.ipAddress,
      requestId: auditRequest?.id,
      userAgent: auditRequest?.userAgent,
    });

    // `departedAt` rides back too (#2628): a return clears it, and the kiosk
    // cannot re-derive that from the arrival alone — it would keep rendering
    // the guest as departed until the next poll.
    return NextResponse.json({
      success: true,
      arrivedAt: arrivedAt?.toISOString() ?? null,
      departedAt: isReturn ? null : guest.departedAt?.toISOString() ?? null,
    });
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    logger.error({ err }, "Error marking guest arrival");
    return NextResponse.json({ error: "Failed to update guest" }, { status: 500 });
  }
}
