/**
 * CHR-01: Chore cleanup on booking date changes.
 *
 * Deletes SUGGESTED ChoreAssignment records for dates no longer in the booking
 * range. CONFIRMED and COMPLETED assignments are NOT auto-deleted; instead they
 * are returned as warnings for admin attention.
 */

import type { PrismaClient } from "@prisma/client";
import { isGuestOperationallyPresentOnDay } from "@/lib/booking-guest-stay-ranges";
import { lockRosterDates } from "@/lib/roster-lock";
import { formatDateOnly } from "@/lib/date-only";

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

  // The booking's OPERATIONAL span is [newCheckIn, newCheckOut] INCLUSIVE
  // (#2622): its guests are here from midday on the check-in day until midday
  // on the check-out day, so a chore dated the check-out day is legitimate and
  // must survive. Hence `gt`, not `gte`.
  //
  // The check-in edge is unchanged and stays `lt`, derived from the same rule
  // rather than by symmetry: presence on the morning of `newCheckIn` would
  // require the night before it to be booked, and if it were, that night would
  // be inside the booking and `newCheckIn` would not be the check-in date.
  const where = {
    bookingId,
    OR: [{ date: { lt: newCheckIn } }, { date: { gt: newCheckOut } }],
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
        `${assignment.choreTemplate.name} on ${formatDateOnly(assignment.date)} is ${assignment.status} and was not auto-removed`
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
          // Owner decision D-M6 (#2622): cleanup loads the CANONICAL night set
          // and asks the same operational-day helper roster eligibility asks,
          // so the two can never disagree about who was in the lodge on a date.
          nights: { select: { stayDate: true } },
        },
      },
      booking: { select: { checkIn: true, checkOut: true } },
    },
  });

  for (const assignment of assignments) {
    if (!assignment.bookingGuest) {
      continue;
    }

    // Replaces the old envelope comparison, which spanned a sparse stay's
    // internal gaps and cut the departure morning off the end. Per segment this
    // now retains every departure morning and — the accepted side effect of
    // D-M6 — starts removing stale SUGGESTED rows stranded on gap dates.
    const isOutsideGuestStay = !isGuestOperationallyPresentOnDay(
      assignment.bookingGuest,
      assignment.date,
      assignment.booking,
    );

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
        `${assignment.choreTemplate.name} on ${formatDateOnly(assignment.date)} is ${assignment.status} and falls outside the guest's stay range`
      );
    }
  }

  return { deletedCount, choreWarnings };
}
