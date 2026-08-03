/**
 * Which `CronJobRun` rows a cron-health view has to read.
 *
 * Extracted from `src/app/api/admin/health/route.ts` (AID-6A, #2375) so the AI
 * Diagnostics background-job evidence tool and the Admin > Health screen classify
 * job health from the SAME rows. `admin-cron-health.ts` already owns the
 * authoritative CLASSIFICATION (current / stale / failed / skipped / missing /
 * disabled); what lived only in the route was the equally load-bearing question of
 * WHICH runs to hand it, and a second copy of that would let the two surfaces
 * disagree about whether a nightly job is overdue.
 *
 * The selection is deliberately not "the most recent N runs" alone: a
 * 15-minute job produces enough rows to push a daily job's last run out of any
 * global window, so the daily job would read as `missing` on a busy deployment.
 * Each expected job therefore also contributes its own recent history plus its
 * latest success and latest failure.
 *
 * READ-ONLY, and metadata only at the point of use: this returns the whole
 * `CronJobRun` row (the classifier needs `status` and the timestamps), and every
 * consumer projects it. The Diagnostics tool's projection drops `error` and
 * `resultSummary` — raw error text and arbitrary JSON, which ADR-003/ADR-004
 * keep out of the evidence channel entirely.
 */

import { prisma } from "@/lib/prisma";
import type {
  AdminCronJobDefinition,
  AdminCronRun,
} from "@/lib/admin-cron-health";

/** Global recent-run window, for the history table and for untracked job names. */
export const RECENT_CRON_RUN_LIMIT = 200;

/** Per-expected-job history depth, on top of the global window. */
export const EXPECTED_CRON_RUN_HISTORY_LIMIT = 5;

function getCronRunTime(run: AdminCronRun): number {
  return new Date(run.startedAt ?? run.createdAt ?? 0).getTime();
}

function dedupeCronRuns(runs: AdminCronRun[]): AdminCronRun[] {
  const byId = new Map<string, AdminCronRun>();
  for (const run of runs) {
    byId.set(run.id, run);
  }

  return [...byId.values()].sort((a, b) => getCronRunTime(b) - getCronRunTime(a));
}

async function getExpectedJobCronRuns(jobName: string): Promise<AdminCronRun[]> {
  const [recentRuns, latestSuccess, latestFailure] = await Promise.all([
    prisma.cronJobRun.findMany({
      where: { jobName },
      orderBy: { startedAt: "desc" },
      take: EXPECTED_CRON_RUN_HISTORY_LIMIT,
    }),
    prisma.cronJobRun.findMany({
      where: { jobName, status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
      take: 1,
    }),
    prisma.cronJobRun.findMany({
      where: { jobName, status: "FAILURE" },
      orderBy: { startedAt: "desc" },
      take: 1,
    }),
  ]);

  return [...recentRuns, ...latestSuccess, ...latestFailure];
}

/**
 * The runs a cron-health report should be built from, newest first and
 * de-duplicated. Pass the same definitions the report will be built with.
 */
export async function getCronRunsForAdminHealth(
  definitions: AdminCronJobDefinition[],
): Promise<AdminCronRun[]> {
  const expectedJobNames = [
    ...new Set(
      definitions
        .filter((definition) => definition.recordsRuns)
        .map((definition) => definition.jobName),
    ),
  ];

  const [recentRuns, expectedJobRuns] = await Promise.all([
    prisma.cronJobRun.findMany({
      orderBy: { startedAt: "desc" },
      take: RECENT_CRON_RUN_LIMIT,
    }),
    Promise.all(expectedJobNames.map(getExpectedJobCronRuns)),
  ]);

  return dedupeCronRuns([...recentRuns, ...expectedJobRuns.flat()]);
}
