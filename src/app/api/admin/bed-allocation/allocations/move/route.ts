import { NextResponse } from "next/server";
import { z } from "zod";
import {
  BED_ALLOCATION_MOVE_SCOPES,
  BedAllocationMoveError,
  previewBedAllocationMove,
  type BedAllocationMoveRequest,
} from "@/lib/bed-allocation-move";
import {
  bedAllocationErrorResponse,
  requireBedAllocationRead,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";

const previewSchema = z
  .object({
    anchorAllocationId: z.string().min(1),
    destinationBedId: z.string().min(1),
    scope: z.enum(BED_ALLOCATION_MOVE_SCOPES),
  })
  .strict();

function moveErrorResponse(error: unknown) {
  if (error instanceof BedAllocationMoveError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        ...(error.refreshedPreview
          ? { refreshedPreview: error.refreshedPreview }
          : {}),
      },
      { status: error.status },
    );
  }
  return bedAllocationErrorResponse(error);
}

/** Read-only authoritative preview; explicit bookings:view is sufficient. */
export async function POST(request: Request) {
  const guard = await requireBedAllocationRead();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;
    const parsed = previewSchema.safeParse(json.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    return NextResponse.json(
      await previewBedAllocationMove(parsed.data as BedAllocationMoveRequest),
    );
  } catch (error) {
    return moveErrorResponse(error);
  }
}
