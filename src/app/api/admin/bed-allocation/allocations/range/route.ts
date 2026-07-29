import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assignBedRange,
  summariseNightRuns,
  type AssignBedRangeResult,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { formatDateOnly } from "@/lib/date-only";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const rangeAllocationSchema = z
  .object({
    bookingGuestId: z.string().min(1),
    bedId: z.string().min(1),
    // Date-only lodge nights: `from` is the first night, `to` the check-out
    // date (exclusive), matching every other bed-allocation endpoint.
    from: z.string().min(1),
    to: z.string().min(1),
    // The admin's explicit SECOND action after a refusal (#2251). Never a
    // default: the first attempt is always all-or-nothing.
    freeNightsOnly: z.boolean().optional(),
  })
  .strict();

function countByCategory(result: AssignBedRangeResult) {
  const counts = { EXCLUSIVE_HOLD: 0, GUEST_NOT_BOOKED: 0, BED_TAKEN: 0 };
  for (const refusal of result.refusals) {
    counts[refusal.category] += 1;
  }
  return counts;
}

export async function POST(request: Request) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = rangeAllocationSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const result = await assignBedRange({
      ...body.data,
      approvedByMemberId: guard.session.user.id,
    });

    /*
     * ONE audit entry for the whole operation, whichever way it went (owner
     * decision, 26 Jul 2026) — including the "assign the free nights" path,
     * which is one deliberate action and should read as one. A refused attempt
     * is recorded too, with outcome "failure": someone tried, and the trail
     * should say so and say why.
     *
     * targetId is the BOOKING id so the booking page's "Audit log" deep link
     * (?q=<bookingId>, which matches targetId and never metadata) surfaces range
     * operations — required by #2252, which drives this same endpoint from
     * inside a booking.
     */
    await createAuditLog({
      action: "BED_ALLOCATION_RANGE_SET",
      memberId: guard.session.user.id,
      targetId: result.bookingId,
      entityType: "BedAllocation",
      category: "admin",
      outcome: result.applied ? "success" : "failure",
      summary: result.applied
        ? `Bed assigned across ${result.writtenNights.length} night${result.writtenNights.length === 1 ? "" : "s"}${result.freeNightsOnly ? " (free nights only, admin opted in)" : ""}`
        : "Range bed assignment refused — nothing written",
      metadata: {
        bookingGuestId: result.bookingGuestId,
        guestName: result.guestName,
        bedId: result.bedId,
        bedName: result.bedName,
        roomName: result.roomName,
        requestedFrom: result.fromDate,
        requestedTo: result.toDate,
        requestedNightCount: result.requestedNights.length,
        // Auto-approved (#2251 decision 4): these rows land approved, which is
        // what locks the member's requested-room editing for this booking.
        autoApproved: result.applied,
        freeNightsOnly: result.freeNightsOnly,
        writtenNightCount: result.writtenNights.length,
        writtenNightRuns: summariseNightRuns(result.writtenNights),
        refusedNightCount: result.refusals.length,
        refusedNightCountsByCategory: countByCategory(result),
        refusals: result.refusals,
      },
    });

    // Moving a shared double's primary onto another bed auto-promotes the
    // partner left on the OLD bed-night (#1750). The partner may belong to a
    // different booking, so it gets its own audit entry against that booking —
    // it is a separate state change, not part of the range operation's record.
    for (const promotedPartner of result.promotedPartners) {
      await createAuditLog({
        action: "BED_ALLOCATION_PARTNER_PROMOTED",
        memberId: guard.session.user.id,
        targetId: promotedPartner.bookingId,
        entityType: "BedAllocation",
        entityId: promotedPartner.id,
        category: "admin",
        outcome: "success",
        summary:
          "Second occupant auto-promoted to primary after the shared double's primary was moved to another bed",
        metadata: {
          allocationId: promotedPartner.id,
          bedId: promotedPartner.bedId,
          bookingGuestId: result.bookingGuestId,
          stayDate: formatDateOnly(promotedPartner.stayDate),
        },
      });
    }

    const payload = {
      applied: result.applied,
      freeNightsOnly: result.freeNightsOnly,
      bookingId: result.bookingId,
      bookingGuestId: result.bookingGuestId,
      guestName: result.guestName,
      bedId: result.bedId,
      bedName: result.bedName,
      roomName: result.roomName,
      fromDate: result.fromDate,
      toDate: result.toDate,
      requestedNights: result.requestedNights,
      freeNights: result.freeNights,
      writtenNights: result.writtenNights,
      refusals: result.refusals,
    };

    if (result.applied) {
      return NextResponse.json({ result: payload });
    }

    /*
     * Nothing was written. "Guest is not booked that night" is a BAD REQUEST —
     * the range or the guest is wrong — so it answers 400; a pure clash or
     * whole-lodge hold is a genuine conflict and answers 409. Both carry the
     * SAME refusal report, because the report is the thing the admin acts on.
     */
    const badRequest = result.refusals.some(
      (refusal) => refusal.category === "GUEST_NOT_BOOKED",
    );
    return NextResponse.json(
      {
        error: badRequest
          ? "Nothing was written: the guest is not booked on some of those nights."
          : "Nothing was written: some nights in that range are blocked.",
        result: payload,
      },
      { status: badRequest ? 400 : 409 },
    );
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
