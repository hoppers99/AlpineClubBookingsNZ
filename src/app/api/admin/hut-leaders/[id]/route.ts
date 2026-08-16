import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { calculateOverlapDays } from "@/lib/hut-leader-overlap";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { validateCustodianBedHold } from "@/lib/custodian-assignment";
import { custodianBedHoldErrorResponse } from "@/lib/custodian-assignment-routes";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";

const updateSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lodgeId: z.string().min(1).optional(),
  // Custodian bed hold (#2286), THREE-state and deliberately so:
  //   absent          -> leave the bed exactly as it is
  //   null            -> CLEAR the bed (back to role only; the bed is bookable
  //                      again from the moment this commits)
  //   a bed id string -> set/replace the bed
  // `.nullable()` as well as `.optional()` is what makes "clear" expressible at
  // all — without it there would be no way to undo a hold except deleting the
  // whole assignment.
  bedId: z.string().min(1).nullable().optional(),
  // #1668-style explicit override of the over-capacity warning.
  confirmOverCapacity: z.boolean().optional(),
});

/**
 * PUT /api/admin/hut-leaders/[id]
 * Update a hut leader assignment.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.hutLeaderAssignment.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }

  const updateData: {
    startDate?: Date;
    endDate?: Date;
    lodgeId?: string;
    bedId?: string | null;
  } = {};
  if (parsed.data.startDate) {
    if (!isDateOnlyString(parsed.data.startDate)) {
      return NextResponse.json({ error: "Invalid startDate" }, { status: 400 });
    }
    updateData.startDate = parseDateOnly(parsed.data.startDate);
  }
  if (parsed.data.endDate) {
    if (!isDateOnlyString(parsed.data.endDate)) {
      return NextResponse.json({ error: "Invalid endDate" }, { status: 400 });
    }
    updateData.endDate = parseDateOnly(parsed.data.endDate);
  }
  if (parsed.data.lodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: parsed.data.lodgeId },
      select: { id: true, active: true },
    });
    if (!lodge || !lodge.active) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 }
      );
    }
    updateData.lodgeId = lodge.id;
  }

  // Validate start <= end
  const finalStart = updateData.startDate ?? existing.startDate;
  const finalEnd = updateData.endDate ?? existing.endDate;
  if (finalStart > finalEnd) {
    return NextResponse.json(
      { error: "startDate must be before or equal to endDate" },
      { status: 400 }
    );
  }

  const finalLodgeId = updateData.lodgeId ?? existing.lodgeId;

  // Custodian bed hold (#2286). Three-state: absent leaves the hold alone,
  // explicit null clears it, a string sets it. `bedIdProvided` is the only way
  // to tell "not sent" from "sent as null", which is exactly the distinction
  // between "don't touch the bed" and "release the bed".
  // JSON has no `undefined`, so zod's three parsed values map one-to-one onto
  // the three intents: undefined = key absent, null = explicit clear, string =
  // set. No separate "was the key present" probe is needed or wanted.
  const bedIdProvided = parsed.data.bedId !== undefined;
  const nextBedId = bedIdProvided ? parsed.data.bedId : existing.bedId;
  if (bedIdProvided) {
    updateData.bedId = parsed.data.bedId ?? null;
  }
  if (nextBedId && !(await isEffectiveModuleEnabled("bedAllocation"))) {
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
    /*
      EVERY edit runs under the target lodge's capacity key (#2887), not just a
      bed-holding one.

      #2286 locked only the bed path, reasoning that clearing a bed or never
      having one moves no capacity. True of capacity, false of the OVERLAP
      predicate — and this route decides that predicate too. The overlap read
      used to run on `prisma`, outside any transaction, and the role-only branch
      then wrote with a bare `prisma.update`, so two concurrent edits (or an
      edit racing a POST) could each read a clean overlap set and both commit,
      leaving one lodge two hut leaders for a night. Nothing behind it: there is
      no unique constraint on the range. A bedless edit can still MOVE DATES,
      which is exactly how it creates an overlap.

      So: take the key, re-read the overlap set under it, re-validate any
      surviving hold against the FINAL dates and lodge, then write.
    */
    const refusal = await prisma.$transaction(async (tx) => {
      await acquireLodgeCapacityLock(tx, finalLodgeId);

      // Excluding self — 1 day overlap allowed for handover, 2+ rejected. Each
      // lodge has its own hut leader, so the check is per lodge; a row still
      // missing a lodgeId (expand-release tolerance) conservatively conflicts
      // at every lodge.
      const potentialOverlaps = await tx.hutLeaderAssignment.findMany({
        where: {
          id: { not: id },
          startDate: { lte: finalEnd },
          endDate: { gte: finalStart },
          ...lodgeNullTolerantScope(finalLodgeId),
        },
        include: {
          member: { select: { firstName: true, lastName: true } },
        },
      });
      for (const other of potentialOverlaps) {
        const overlapDays = calculateOverlapDays(
          finalStart,
          finalEnd,
          other.startDate,
          other.endDate,
        );
        if (overlapDays > 1) {
          const name = `${other.member.firstName} ${other.member.lastName}`;
          const start = formatDateOnly(other.startDate);
          const end = formatDateOnly(other.endDate);
          return {
            status: 409,
            error: `Assignment overlaps with ${name}'s assignment (${start} to ${end}) by ${overlapDays} days. Maximum 1 day overlap is allowed for handover.`,
          };
        }
      }

      if (nextBedId) {
        await validateCustodianBedHold({
          bedId: nextBedId,
          lodgeId: finalLodgeId,
          startDate: finalStart,
          endDate: finalEnd,
          assignmentId: id,
          confirmOverCapacity: parsed.data.confirmOverCapacity,
          db: tx,
        });
      }
      await tx.hutLeaderAssignment.update({ where: { id }, data: updateData });
      return null;
    });

    if (refusal) {
      return NextResponse.json(
        { error: refusal.error },
        { status: refusal.status },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const custodianResponse = custodianBedHoldErrorResponse(err);
    if (custodianResponse) return custodianResponse;
    logger.error({ err }, "Error updating hut leader assignment");
    return NextResponse.json({ error: "Failed to update assignment" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/hut-leaders/[id]
 * Delete a hut leader assignment.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const existing = await prisma.hutLeaderAssignment.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }

  try {
    await prisma.hutLeaderAssignment.delete({ where: { id } });
    logger.info({ assignmentId: id }, "Hut leader assignment deleted");
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error deleting hut leader assignment");
    return NextResponse.json({ error: "Failed to delete assignment" }, { status: 500 });
  }
}
