import { calculateOverlapDays } from "@/lib/hut-leader-overlap";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { formatDateOnly } from "@/lib/date-only";
import type { Prisma } from "@prisma/client";

/**
 * May a hut-leader assignment occupy these nights at this lodge? (#2887)
 *
 * The three writers that DECIDE this predicate — `POST /api/admin/hut-leaders`,
 * its `PUT`, and `cron-hut-leader-auto-assign` — each held their own copy of
 * the read and the >1-day comparison. Three copies of one rule is how the rule
 * drifts: `docs/CONCURRENCY_AND_LOCKING.md` states the guarantee they jointly
 * provide, and it is only true while all three agree. There is one now.
 *
 * Call it with the TRANSACTION client, after `acquireLodgeCapacityLock`. It is
 * a read, so it is only authoritative under that key — outside it the answer is
 * a guess that a concurrent insert can invalidate before the caller writes.
 *
 * A row still missing a lodgeId (expand-release tolerance) conservatively
 * conflicts at every lodge, which is what `lodgeNullTolerantScope` encodes.
 *
 * SCHOOL-sourced rows are excluded (#2887, owner decision). Approving a school
 * booking creates one assignment per teacher — same dates, same lodge,
 * deliberately overlapping, because several teachers do supervise one group
 * together. Those rows used to BLOCK any later manual or cron assignment for
 * those nights while never being blocked themselves, which nothing had decided
 * and nothing stated. The owner decided teachers should not block.
 *
 * The discriminator is the member's `role`, and it needs no schema change:
 * `SCHOOL` is set only by `school-booking-request.ts`, and among members that
 * can actually HOLD an assignment it means "teacher" exactly. Two independent
 * reasons — the school flow only ever creates assignments for teacher members,
 * and the admin POST refuses any member without the `USER` access role, which
 * no SCHOOL member has. `hut-leader-overlap-guard.test.ts` pins both.
 *
 * ONE DIRECTION ONLY. Teachers no longer block independent assignments.
 * Whether an existing assignment blocks a TEACHER is unchanged — the school
 * path still runs no overlap read at all — and that stays as it is.
 */
export async function findHutLeaderOverlapRefusal(
  tx: Pick<Prisma.TransactionClient, "hutLeaderAssignment">,
  input: {
    lodgeId: string;
    startDate: Date;
    endDate: Date;
    /** The row being edited, excluded from its own overlap check. */
    excludeAssignmentId?: string;
  },
): Promise<{ error: string } | null> {
  const overlaps = await tx.hutLeaderAssignment.findMany({
    where: {
      ...(input.excludeAssignmentId
        ? { id: { not: input.excludeAssignmentId } }
        : {}),
      startDate: { lte: input.endDate },
      endDate: { gte: input.startDate },
      ...lodgeNullTolerantScope(input.lodgeId),
      // See the SCHOOL carve-out above.
      member: { role: { not: "SCHOOL" } },
    },
    include: { member: { select: { firstName: true, lastName: true } } },
  });

  for (const other of overlaps) {
    // One day of overlap is allowed, deliberately: it is the handover.
    const overlapDays = calculateOverlapDays(
      input.startDate,
      input.endDate,
      other.startDate,
      other.endDate,
    );
    if (overlapDays > 1) {
      const name = `${other.member.firstName} ${other.member.lastName}`;
      return {
        error: `Assignment overlaps with ${name}'s assignment (${formatDateOnly(other.startDate)} to ${formatDateOnly(other.endDate)}) by ${overlapDays} days. Maximum 1 day overlap is allowed for handover.`,
      };
    }
  }
  return null;
}
