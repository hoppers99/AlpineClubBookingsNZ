import { NextRequest, NextResponse } from "next/server";
import {
  getBedAllocationDashboard,
  parseBedAllocationDateRange,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";

// requireAdmin() is enforced by requireBedAllocationAdmin().
export async function GET(request: NextRequest) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const range = parseBedAllocationDateRange({
      from: request.nextUrl.searchParams.get("from"),
      to: request.nextUrl.searchParams.get("to"),
    });
    // Scope the board to one lodge (ADR-003); omitted = club-wide, which
    // preserves single-lodge behaviour.
    const lodgeId = request.nextUrl.searchParams.get("lodgeId") ?? undefined;
    return NextResponse.json(await getBedAllocationDashboard({ range, lodgeId }));
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
