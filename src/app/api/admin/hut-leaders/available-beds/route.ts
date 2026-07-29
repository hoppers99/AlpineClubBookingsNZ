import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { listCustodianBedOptions } from "@/lib/custodian-assignment";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";

/**
 * GET /api/admin/hut-leaders/available-beds
 *   ?lodgeId=&startDate=&endDate=&assignmentId=
 *
 * Feeds the Hut Leaders form's optional bed picker (#2286). Returns EVERY
 * active bed at the lodge grouped by room, each with whether it can be held for
 * the requested inclusive night range and, when it cannot, exactly which nights
 * block it. Unavailable beds are returned rather than filtered out on purpose:
 * an admin who cannot see why a bed is missing has no way to unblock it.
 *
 * Read-only and lodge-scoped; `assignmentId` (when editing) excludes the
 * assignment's own hold so its current bed stays selectable.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  if (!(await isEffectiveModuleEnabled("bedAllocation"))) {
    // Consistent with the rest of the bed-allocation surface: the module being
    // off means the feature does not exist, not that the caller lacks access.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  if (
    !startDate ||
    !endDate ||
    !isDateOnlyString(startDate) ||
    !isDateOnlyString(endDate) ||
    startDate > endDate
  ) {
    return NextResponse.json(
      { error: "startDate and endDate are required (YYYY-MM-DD, start <= end)" },
      { status: 400 },
    );
  }

  const lodgeId = await resolveOptionalActiveLodgeId(
    prisma,
    searchParams.get("lodgeId") ?? undefined,
  );
  if (!lodgeId) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 },
    );
  }

  const options = await listCustodianBedOptions({
    lodgeId,
    startDate: parseDateOnly(startDate),
    endDate: parseDateOnly(endDate),
    assignmentId: searchParams.get("assignmentId") ?? undefined,
  });

  // Grouped by room so the picker reads the way the board does.
  const rooms: Array<{
    roomId: string;
    roomName: string;
    beds: typeof options;
  }> = [];
  for (const option of options) {
    let room = rooms.find((entry) => entry.roomId === option.roomId);
    if (!room) {
      room = { roomId: option.roomId, roomName: option.roomName, beds: [] };
      rooms.push(room);
    }
    room.beds.push(option);
  }

  return NextResponse.json({ lodgeId, rooms });
}
