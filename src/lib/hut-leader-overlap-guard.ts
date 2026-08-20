import { calculateOverlapDays } from "@/lib/hut-leader-overlap";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { formatDateOnly } from "@/lib/date-only";
import { HutLeaderAssignmentSource } from "@prisma/client";
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
 * `lodgeNullTolerantScope` is a STRICT per-lodge match, despite the name. The
 * name is a leftover from the expand-release phase when `lodgeId` was nullable;
 * `HutLeaderAssignment.lodgeId` is NOT NULL now (`prisma/schema.prisma`) and the
 * helper returns a plain `{ lodgeId }` — see its own comment in `lodges.ts`.
 * There are no null-lodge rows to tolerate, and if one somehow existed it would
 * be EXCLUDED from this read rather than treated as conflicting everywhere.
 * (This docblock claimed the opposite on both counts, inherited from the PUT
 * comment it was extracted from, where it was already wrong.)
 *
 * School-teacher records ARE excluded (#2926, owner decision 17 Aug 2026), and
 * the exclusion is keyed on `HutLeaderAssignment.source`, the provenance the
 * CREATING writer stamps on the row. Approving a school booking creates one
 * assignment per teacher, deliberately overlapping each other, and those rows
 * used to block a later manual or cron assignment for those nights while never
 * being blocked themselves — the school path runs no overlap read at all.
 * Only that one direction changed: whether an existing assignment blocks a
 * TEACHER is untouched, because the school path still asks nothing.
 *
 * WHY `source` AND NOT THE MEMBER. This has to be a property of the ROW, never
 * of the member's current classification, and the first attempt got that wrong
 * in a way that is worth naming so it is not repeated. It filtered on
 * `member.role != "SCHOOL"`. `Member.role` is DERIVED and admin-writable:
 * `legacyRoleFromAccessRoles` maps the ORG access role to `"SCHOOL"`, and the
 * member editor's User Type control grants ORG. So reclassifying an ordinary
 * member as an organisation made their LIVE assignment vanish from this
 * predicate, and an admin or the cron could then create a second overlapping
 * leader for those nights. Reading the ACCESS ROLE here instead fails the same
 * way and one step earlier: `accessRoleTokensForUserType("organisation")`
 * returns `["ORG"]`, dropping `USER`. `source` is written once by the insert and
 * by nothing afterwards, so no membership edit can move it.
 *
 * `Member.role = "SCHOOL"` is also the SCHOOL CONTACT member, not only a
 * teacher, which is a second reason it never identified the rows it was being
 * asked about.
 */
export async function findHutLeaderOverlapRefusal(
  tx: Pick<Prisma.TransactionClient, "hutLeaderAssignment">,
  input: {
    lodgeId: string;
    startDate: Date;
    endDate: Date;
    /** The row being edited, excluded from its own overlap check. */
    excludeAssignmentId?: string;
    /**
     * Whether a SCHOOL_BOOKING row may be overlapped (#2926).
     *
     * DEFAULTS TO FALSE, and the default is the load-bearing part. The carve-out
     * answers "may a DELIBERATE assignment stand here?" — an officer choosing to
     * put a leader beside a school group is not to be refused. It does NOT answer
     * "should an automatic job plant one?", and conflating the two is a real
     * defect rather than a theoretical one:
     *
     *   teachers 10-14 Aug at a lodge; a sole adult member's stay is 12-20 Aug;
     *   the nightly job reaches 15 Aug, whose coverage probe finds nothing; with
     *   the carve-out applied the span read over 12-20 Aug skips the teacher rows
     *   and the job plants a CRON row across 12-20 — including the school nights
     *   it is documented never to reach. That row is MANUAL-equivalent, so it then
     *   blocks officers across the whole span too.
     *
     * So an AUTOMATIC caller omits this and keeps refusing, which is exactly the
     * behaviour that existed before the carve-out; only the two deliberate admin
     * routes opt in. Omitting it is always the safe answer, which is why the flag
     * is opt-in rather than opt-out.
     */
    allowOverlappingSchoolRows?: boolean;
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
      // The teacher carve-out, keyed on the row's own provenance, and applied
      // only for a DELIBERATE caller. `source` is NOT NULL with a database
      // default, so `not` has no three-valued-logic hole: every row is either
      // SCHOOL_BOOKING or it is not.
      ...(input.allowOverlappingSchoolRows
        ? { source: { not: HutLeaderAssignmentSource.SCHOOL_BOOKING } }
        : {}),
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
