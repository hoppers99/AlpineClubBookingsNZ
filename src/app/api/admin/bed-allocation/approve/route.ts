import { NextResponse } from "next/server";
import { z } from "zod";
import {
  approveBedAllocations,
} from "@/lib/bed-allocation-approval";
import {
  parseBedAllocationDateRange,
} from "@/lib/bed-allocation-date-range";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";

// requireAdmin() is enforced by requireBedAllocationWrite().
const approveSchema = z
  .object({
    allocationIds: z.array(z.string().min(1)).max(250).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    // One booking's draft rows; sufficient without either broader selector.
    bookingId: z.string().min(1).optional(),
    // Board lodge scope. Omitted continues to mean club-wide.
    lodgeId: z.string().min(1).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = approveSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const range =
      body.data.from || body.data.to
        ? parseBedAllocationDateRange({
            from: body.data.from,
            to: body.data.to,
          })
        : undefined;
    // The service owns the approval and its audit in the same transaction.
    const result = await approveBedAllocations({
      approvedByMemberId: guard.session.user.id,
      allocationIds: body.data.allocationIds,
      range,
      bookingId: body.data.bookingId,
      lodgeId: body.data.lodgeId,
    });

    return NextResponse.json({ approvedCount: result.count });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
