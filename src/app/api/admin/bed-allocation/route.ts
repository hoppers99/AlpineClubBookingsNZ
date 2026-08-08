import { NextRequest, NextResponse } from "next/server";
import {
  getBedAllocationDashboard,
  parseBedAllocationDateRange,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationRead,
} from "@/lib/admin-bed-allocation-routes";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";

// requireAdmin() is enforced by requireBedAllocationRead().
export async function GET(request: NextRequest) {
  const guard = await requireBedAllocationRead();
  if (!guard.ok) return guard.response;

  try {
    const range = parseBedAllocationDateRange({
      from: request.nextUrl.searchParams.get("from"),
      to: request.nextUrl.searchParams.get("to"),
    });
    const bookingId = request.nextUrl.searchParams.get("bookingId");
    // #2678: A NAMED BOOKING FIXES THE LODGE, AND THE SERVER OWNS IT.
    //
    // `docs/multi-lodge/lodge-scoping-contract.md` already states the rule this
    // now follows: "Editing a booking that already exists is scoped by that
    // booking, not by the editor's own eligibility ... a read that feeds an
    // editor on that booking derives its lodge from `Booking.lodgeId`
    // server-side ... never from a client-supplied `lodgeId`". This was the
    // last booking-scoped read still taking the lodge from the caller, after
    // #2673 (the requested-room picker) and #2677 (the booking wizard).
    //
    // It is not merely a hand-crafted-request concern. `admin-booking-tools-
    // card.tsx` deep-links this board with `bookingId` and NO `lodgeId`, so an
    // admin two clicks from a booking page landed on a CLUB-WIDE board focused
    // on that booking, whose bed pickers offered every lodge's beds for its
    // guests — the exact #2664 symptom, with the write then refused at
    // `admin-bed-allocation.ts` ("Bed belongs to a different lodge than the
    // booking"). Deriving the scope here makes the offer match the write.
    //
    // A `lodgeId` on the query string is IGNORED rather than rejected when a
    // booking is named, matching `requested-room/options` ("ignores a lodgeId a
    // caller tries to smuggle in on the query string"). An unresolvable
    // `bookingId` changes nothing: the caller's own scope still applies, and the
    // focus lookup inside the dashboard already returns nothing for it.
    //
    // Status is deliberately NOT filtered here. The lodge is a fact about the
    // row whatever its status, and a cancelled booking's board still has to be
    // readable; `focusedBooking` keeps its own stricter allocatable/non-deleted
    // filter for the window it snaps onto.
    const bookingLodgeId = bookingId
      ? (
          await prisma.booking.findUnique({
            where: { id: bookingId },
            select: { lodgeId: true },
          })
        )?.lodgeId
      : undefined;

    // Scope the board to one lodge (ADR-003); omitted = club-wide, which
    // preserves single-lodge behaviour.
    const requestedLodgeId =
      request.nextUrl.searchParams.get("lodgeId") ?? undefined;
    // Validate an explicit lodge scope the way the write paths do (400 on
    // unknown/inactive); omitted stays club-wide. Only the scope actually used
    // is validated — a lodge the booking overrode is not the caller's answer to
    // anything, so refusing it would report a fault in a value we ignore.
    if (
      !bookingLodgeId &&
      requestedLodgeId &&
      !(await resolveOptionalActiveLodgeId(prisma, requestedLodgeId))
    ) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      );
    }
    return NextResponse.json(
      await getBedAllocationDashboard({
        range,
        lodgeId: bookingLodgeId ?? requestedLodgeId,
        bookingId,
      }),
    );
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
