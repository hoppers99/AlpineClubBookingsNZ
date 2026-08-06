/**
 * CHR-01: Chore cleanup on booking date changes.
 *
 * Deletes SUGGESTED ChoreAssignment records for dates no longer in the booking
 * range. CONFIRMED and COMPLETED assignments are NOT auto-deleted; instead they
 * are returned as warnings for admin attention.
 */

import type { PrismaClient } from "@prisma/client";
import { lockRosterDates } from "@/lib/roster-lock";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export interface ChoreCleanupResult {
  deletedCount: number;
  choreWarnings: string[];
}

/**
 * Clean up chore assignments when booking dates change.
 *
 * @param tx - Prisma transaction client
 * @param bookingId - The booking whose dates changed
 * @param newCheckIn - New check-in date
 * @param newCheckOut - New check-out date
 * @returns Count of deleted assignments and warnings for non-deletable ones
 */
export async function cleanupChoreAssignmentsForDateChange(
  tx: Tx,
  bookingId: string,
  newCheckIn: Date,
  newCheckOut: Date,
  options: { rosterDatesAlreadyLocked?: boolean } = {},
): Promise<ChoreCleanupResult> {
  const choreWarnings: string[] = [];
  let deletedCount = 0;

  const where = {
    bookingId,
    OR: [{ date: { lt: newCheckIn } }, { date: { gte: newCheckOut } }],
  };
  if (!options.rosterDatesAlreadyLocked) {
    // The first query derives the advisory keys only. It is not authoritative:
    // a whole-roster Save may reattribute a row while we wait for those locks.
    const lockCandidates = await tx.choreAssignment.findMany({
      where,
      select: { date: true },
    });
    await lockRosterDates(tx, lockCandidates.map((assignment) => assignment.date));
  }

  // Re-read under the date locks. Warnings and deletes must come only from this
  // snapshot, not ids captured before a wait.
  const outOfRangeAssignments = await tx.choreAssignment.findMany({
    where,
    include: { choreTemplate: true },
  });

  for (const assignment of outOfRangeAssignments) {
    if (assignment.status === "SUGGESTED") {
      const deleted = await tx.choreAssignment.deleteMany({
        where: { id: assignment.id, ...where, status: "SUGGESTED" },
      });
      deletedCount += deleted.count;
    } else {
      choreWarnings.push(
        `${assignment.choreTemplate.name} on ${assignment.date.toISOString().split("T")[0]} is ${assignment.status} and was not auto-removed`
      );
    }
  }

  return { deletedCount, choreWarnings };
}

export async function cleanupChoreAssignmentsForGuestStayRanges(
  tx: Tx,
  bookingId: string,
  options: { rosterDatesAlreadyLocked?: boolean } = {},
): Promise<ChoreCleanupResult> {
  const choreWarnings: string[] = [];
  let deletedCount = 0;

  const where = { bookingId, bookingGuestId: { not: null } };
  if (!options.rosterDatesAlreadyLocked) {
    const lockCandidates = await tx.choreAssignment.findMany({
      where,
      select: { date: true },
    });
    await lockRosterDates(tx, lockCandidates.map((assignment) => assignment.date));
  }

  const assignments = await tx.choreAssignment.findMany({
    where,
    include: {
      choreTemplate: true,
      bookingGuest: {
        select: {
          stayStart: true,
          stayEnd: true,
        },
      },
    },
  });

  for (const assignment of assignments) {
    if (!assignment.bookingGuest) {
      continue;
    }

    const assignmentDate = assignment.date.getTime();
    const stayStart = assignment.bookingGuest.stayStart.getTime();
    const stayEnd = assignment.bookingGuest.stayEnd.getTime();
    const isOutsideGuestStay =
      assignmentDate < stayStart || assignmentDate >= stayEnd;

    if (!isOutsideGuestStay) {
      continue;
    }

    if (assignment.status === "SUGGESTED") {
      const deleted = await tx.choreAssignment.deleteMany({
        where: {
          id: assignment.id,
          bookingId,
          bookingGuestId: assignment.bookingGuestId,
          status: "SUGGESTED",
        },
      });
      deletedCount += deleted.count;
    } else {
      choreWarnings.push(
        `${assignment.choreTemplate.name} on ${assignment.date.toISOString().split("T")[0]} is ${assignment.status} and falls outside the guest's stay range`
      );
    }
  }

  return { deletedCount, choreWarnings };
}
