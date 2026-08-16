import { NextRequest, NextResponse } from "next/server";
import {
  getAdminOccupancyMonth,
  parseOccupancyMonth,
} from "@/lib/admin-occupancy";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";

/**
 * GET /api/admin/occupancy?month=YYYY-MM
 * Returns operational guest occupancy per lodge night for one calendar month.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const parsedMonth = parseOccupancyMonth(req.nextUrl.searchParams.get("month"));
  if (!parsedMonth.ok) {
    return NextResponse.json({ error: parsedMonth.error }, { status: 400 });
  }
  const requestedLodgeId = req.nextUrl.searchParams.get("lodgeId");
  const lodgeId = requestedLodgeId
    ? await resolveOptionalActiveLodgeId(prisma, requestedLodgeId)
    : null;
  if (!lodgeId) {
    return NextResponse.json({ error: "A valid lodgeId is required." }, { status: 400 });
  }

  return NextResponse.json(await getAdminOccupancyMonth({ ...parsedMonth, lodgeId }));
}
