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
