import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/session-guards";
import {
  canReadLodgeInstructions,
  getSanitizedLodgeInstructions,
} from "@/lib/lodge-instructions";
import { getTodayDateOnly } from "@/lib/date-only";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

/**
 * Resolve which lodge's instructions the member should see when the request
 * does not name one: the lodge of their current or upcoming hut leader
 * assignments when those cover exactly one distinct lodge, else null (the
 * club-wide documents). Assignments with a null lodgeId count as the club's
 * default lodge, matching resolveKioskLodgeId's hut-leader semantics.
 */
async function resolveMemberInstructionLodgeId(
  memberId: string,
): Promise<string | null> {
  const assignments = await prisma.hutLeaderAssignment.findMany({
    where: { memberId, endDate: { gte: getTodayDateOnly() } },
    select: { lodgeId: true },
  });
  if (assignments.length === 0) {
    return null;
  }

  const distinct = new Set<string>();
  let defaultLodgeId: string | null = null;
  for (const assignment of assignments) {
    if (assignment.lodgeId) {
      distinct.add(assignment.lodgeId);
    } else {
      defaultLodgeId ??= await getDefaultLodgeId(prisma);
      distinct.add(defaultLodgeId);
    }
  }
  return distinct.size === 1 ? [...distinct][0] : null;
}

/**
 * GET /api/lodge-instructions?lodgeId=<id>
 * Reader endpoint for the member-facing lodge instructions page.
 * Admins always qualify; members qualify only while they hold a current
 * or upcoming hut leader assignment. Everyone else gets a 403 the page
 * turns into the "you're not currently assigned" state.
 *
 * The optional lodgeId selects which lodge's override documents replace
 * the club-wide ones; when omitted, the member's assignment lodge is used
 * if unambiguous, otherwise the club-wide documents are returned.
 */
export async function GET(request: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }

  const allowed = await canReadLodgeInstructions(
    guard.session.user.id,
    guard.session.user,
  );

  if (!allowed) {
    return NextResponse.json(
      { error: "You are not currently assigned as a hut leader" },
      { status: 403 },
    );
  }

  const lodgeId =
    request.nextUrl.searchParams.get("lodgeId") ||
    (await resolveMemberInstructionLodgeId(guard.session.user.id));

  // Reader surface: the member's lodge documents (club-wide fallback) with
  // text tokens ({{club-name}} etc.) resolved for display.
  const documents = await getSanitizedLodgeInstructions({
    lodgeId,
    resolveTokens: true,
  });
  return NextResponse.json({ documents });
}
