import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { calculateOverlapDays } from "@/lib/hut-leader-overlap";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { sendHutLeaderAssignmentEmail } from "@/lib/email";
import {
  generateHutLeaderPin,
  hashHutLeaderPin,
} from "@/lib/lodge-pin-session";
import { hasAccessRole } from "@/lib/access-roles";
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { validateCustodianBedHold } from "@/lib/custodian-assignment";
import { custodianBedHoldErrorResponse } from "@/lib/custodian-assignment-routes";
import { isMinorAgeTier } from "@/lib/custodian-occupancy";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";

const createSchema = z.object({
  memberId: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lodgeId: z.string().min(1).optional(),
  // Custodian bed hold (#2286). Optional AND nullable: absent or null is the
  // default "No bed — role only", which behaves exactly as it did before this
  // feature and has zero capacity effect.
  bedId: z.string().min(1).nullable().optional(),
  // #1668-style explicit override of the over-capacity warning.
  confirmOverCapacity: z.boolean().optional(),
}).refine((data) => data.startDate <= data.endDate, {
  message: "startDate must be before or equal to endDate",
});

/**
 * GET /api/admin/hut-leaders
 * List all hut leader assignments.
 */
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const assignments = await prisma.hutLeaderAssignment.findMany({
    include: {
      member: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      lodge: {
        select: { id: true, name: true },
      },
      // Custodian bed hold (#2286): which bed (if any) this assignment holds,
      // so the admin table can show it next to the dates.
      bed: {
        select: { id: true, name: true, room: { select: { name: true } } },
      },
    },
    orderBy: { startDate: "desc" },
  });

  return NextResponse.json({
    assignments: assignments.map((a) => ({
      id: a.id,
      memberId: a.memberId,
      memberName: `${a.member.firstName} ${a.member.lastName}`,
      memberEmail: a.member.email,
      startDate: formatDateOnly(a.startDate),
      endDate: formatDateOnly(a.endDate),
      createdAt: a.createdAt.toISOString(),
      lodgeId: a.lodgeId,
      lodgeName: a.lodge?.name ?? null,
      // #2286: null = role only, with no capacity effect at all.
      bedId: a.bedId,
      bedName: a.bed?.name ?? null,
      bedRoomName: a.bed?.room.name ?? null,
    })),
  });
}

/**
 * POST /api/admin/hut-leaders
 * Create a new hut leader assignment.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const member = await prisma.member.findUnique({
    where: { id: parsed.data.memberId },
    select: {
      id: true,
      active: true,
      email: true,
      firstName: true,
      // #2286: a minor custodian is never individually named on the lobby TV,
      // so the admin is warned at assignment time.
      ageTier: true,
      accessRoles: { select: { role: true } },
    },
  });

  if (!member || !member.active || !hasAccessRole(member, "USER")) {
    return NextResponse.json(
      { error: "Member not found or not eligible for hut leader assignment" },
      { status: 404 }
    );
  }

  // Check for overlapping assignments — 1 day overlap allowed for handover, 2+ rejected
  if (!isDateOnlyString(parsed.data.startDate) || !isDateOnlyString(parsed.data.endDate)) {
    return NextResponse.json({ error: "Invalid startDate or endDate" }, { status: 400 });
  }
  const newStart = parseDateOnly(parsed.data.startDate);
  const newEnd = parseDateOnly(parsed.data.endDate);

  const lodgeId = await resolveOptionalActiveLodgeId(
    prisma,
    parsed.data.lodgeId,
  );
  if (!lodgeId) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 }
    );
  }

  // Each lodge has its own hut leader, so the overlap check is per lodge;
  // assignments still missing a lodgeId (expand-release tolerance)
  // conservatively conflict at every lodge.
  const potentialOverlaps = await prisma.hutLeaderAssignment.findMany({
    where: {
      startDate: { lte: newEnd },
      endDate: { gte: newStart },
      ...lodgeNullTolerantScope(lodgeId),
    },
    include: {
      member: { select: { firstName: true, lastName: true } },
    },
  });

  for (const existing of potentialOverlaps) {
    const overlapDays = calculateOverlapDays(newStart, newEnd, existing.startDate, existing.endDate);
    if (overlapDays > 1) {
      const name = `${existing.member.firstName} ${existing.member.lastName}`;
      const start = formatDateOnly(existing.startDate);
      const end = formatDateOnly(existing.endDate);
      return NextResponse.json(
        { error: `Assignment overlaps with ${name}'s assignment (${start} to ${end}) by ${overlapDays} days. Maximum 1 day overlap is allowed for handover.` },
        { status: 409 }
      );
    }
  }

  // Custodian bed hold (#2286): a bed can only mean anything while the
  // bed-allocation module is on — rooms and beds exist only under it.
  const bedId = parsed.data.bedId ?? null;
  if (bedId && !(await isEffectiveModuleEnabled("bedAllocation"))) {
    return NextResponse.json(
      {
        error:
          "Bed allocation is turned off for this club, so a bed cannot be held for a hut leader.",
        code: "MODULE_DISABLED",
      },
      { status: 400 },
    );
  }

  try {
    const pin = generateHutLeaderPin();
    const hutLeaderPin = await hashHutLeaderPin(pin);

    // #2286: creating a BED-HOLDING assignment is a capacity-mutating write, so
    // validation and the insert move into one transaction that takes the
    // per-lodge advisory lock first — the same key booking admission and the
    // allocation chokepoints take. A role-only assignment changes no capacity,
    // so it keeps the plain unlocked create it has always used.
    //
    // The PIN email deliberately stays OUTSIDE the transaction (AGENTS.md: no
    // external provider call inside a DB transaction), with its existing
    // failure-tolerant `emailSent` handling untouched.
    const assignment = bedId
      ? await prisma.$transaction(async (tx) => {
          await acquireLodgeCapacityLock(tx, lodgeId);
          await validateCustodianBedHold({
            bedId,
            lodgeId,
            startDate: newStart,
            endDate: newEnd,
            confirmOverCapacity: parsed.data.confirmOverCapacity,
            db: tx,
          });
          return tx.hutLeaderAssignment.create({
            data: {
              memberId: parsed.data.memberId,
              startDate: newStart,
              endDate: newEnd,
              hutLeaderPin,
              lodgeId,
              bedId,
            },
          });
        })
      : await prisma.hutLeaderAssignment.create({
          data: {
            memberId: parsed.data.memberId,
            startDate: newStart,
            endDate: newEnd,
            hutLeaderPin,
            lodgeId,
          },
        });

    let emailSent = true;
    try {
      await sendHutLeaderAssignmentEmail({
        email: member.email,
        firstName: member.firstName,
        startDate: newStart,
        endDate: newEnd,
        pin,
        assignmentId: assignment.id,
      });
    } catch (err) {
      emailSent = false;
      logger.error(
        { err, assignmentId: assignment.id, memberId: member.id },
        "Failed to send hut leader assignment email"
      );
    }

    logger.info(
      { assignmentId: assignment.id, memberId: parsed.data.memberId },
      "Hut leader assignment created"
    );

    return NextResponse.json(
      {
        id: assignment.id,
        emailSent,
        // #2286 privacy guard: a minor holding a bed is never individually
        // named on the lobby TV (the display contract forbids it at every
        // granularity), so the screen shows the role word alone. Tell the admin
        // now rather than letting them expect a name that will never appear.
        minorCustodianWarning:
          bedId && isMinorAgeTier(member.ageTier)
            ? "This member is a minor, so the lodge screen will show the custodian role only and never their name."
            : null,
      },
      { status: 201 }
    );
  } catch (err) {
    const custodianResponse = custodianBedHoldErrorResponse(err);
    if (custodianResponse) return custodianResponse;
    logger.error({ err }, "Error creating hut leader assignment");
    return NextResponse.json({ error: "Failed to create assignment" }, { status: 500 });
  }
}
