import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  reconcileAllEmailInheritance,
  unreachableMemberWhere,
} from "@/lib/member-email-inheritance";

/**
 * Daily convergence sweep for email inheritance (#2716).
 *
 * WHY A SWEEP EXISTS AT ALL, given every address write already re-resolves in
 * its own transaction. Because "every" is a claim about a codebase, and this
 * feature decides which adult receives a minor's notifications — a claim that
 * is wrong for one write path is a family quietly hearing nothing. The hazard
 * the issue names is precisely a re-resolution that fires on the wrong event or
 * fails partway, leaving a pointer naming somebody nobody chose: the original
 * defect with extra steps. The in-transaction calls make the common case
 * immediate; this makes the guarantee hold anyway.
 *
 * It is safe to run at any time, from anywhere, as often as you like, because
 * the rule it applies is a pure function of the family tree
 * (`effectiveEmailSourceId`). Running it twice changes nothing the first run
 * did not; running it after a crashed run finishes the job. That is the whole
 * reason the design was allowed to re-point pointers WITHOUT an admin
 * confirming each one: there is no queue to drain and no partial state to
 * reconcile by hand, so the failure mode of the automation is "run it again"
 * rather than "work out what it did".
 *
 * It also reports the accepted cost of the direct-parent rule out loud. Where a
 * middle generation has no address the descendant now inherits nobody, and a
 * gap is only the right failure direction if somebody can see it — so the run
 * logs how many members are left with a recorded choice that resolves to
 * nobody, and how many the club currently has no way to reach at all. The same
 * two numbers are what the admin surfaces show.
 */
export async function reconcileEmailInheritanceSweep(): Promise<{
  examined: number;
  repointed: number;
  cleared: number;
  unresolved: number;
  unreachable: number;
}> {
  const result = await reconcileAllEmailInheritance(prisma);
  const unreachable = await prisma.member.count({
    where: unreachableMemberWhere(),
  });

  const summary = {
    examined: result.examined,
    repointed: result.repointed,
    cleared: result.cleared,
    unresolved: result.unresolved.length,
    unreachable,
  };

  // At INFO rather than DEBUG, and unconditionally rather than only when
  // something moved: a run that changes nothing is the evidence that the
  // in-transaction re-resolutions are keeping up, and a run that suddenly
  // starts moving rows is the first sign one of them has stopped.
  logger.info(
    { job: "email-inheritance-reconcile", ...summary },
    "Email inheritance reconciliation complete",
  );

  return summary;
}
