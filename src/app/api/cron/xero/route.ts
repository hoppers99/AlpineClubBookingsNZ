import { NextRequest, NextResponse } from "next/server";
import { refreshAllMembershipStatuses, isXeroConnected } from "@/lib/xero";
import { processQueuedXeroOutboxOperations } from "@/lib/xero-operation-outbox";
import { processQueuedXeroOperationRetries } from "@/lib/xero-operation-queue";
import { runXeroInboundReconciliationCycle } from "@/lib/xero-inbound-reconciliation";
import { requireCronSecret } from "@/lib/cron-auth";
import {
  backfillHistoricalXeroObjectLinks,
  cleanupStaleCanonicalXeroObjectLinks,
  sendXeroReconciliationReport,
} from "@/lib/xero-hardening";
import {
  recordCronJobRunSafe,
  type CronJobRunStatus,
} from "@/lib/cron-job-run";
import logger from "@/lib/logger";
import { isXeroDailyMembershipRefreshEnabled } from "@/lib/xero-feature-flags";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";

const xeroCronTasks = [
  "memberships",
  "outbox",
  "retries",
  "inbound",
  "backfill",
  "link-cleanup",
  "report",
] as const;

type XeroCronTask = (typeof xeroCronTasks)[number];

const xeroCronJobNames: Record<XeroCronTask, string> = {
  memberships: "xero-membership-refresh",
  outbox: "xero-outbox",
  retries: "xero-operation-replay",
  inbound: "xero-inbound-reconcile",
  backfill: "xero-link-backfill",
  "link-cleanup": "xero-link-cleanup",
  report: "xero-reconciliation-report",
};

function isXeroCronTask(value: string): value is XeroCronTask {
  return xeroCronTasks.includes(value as XeroCronTask);
}

function tasksToRecord(task: XeroCronTask | "all"): XeroCronTask[] {
  if (task === "all") return [...xeroCronTasks];
  if (task === "backfill") return ["backfill", "link-cleanup"];
  return [task];
}

function cronStatusForResult(result: unknown): CronJobRunStatus {
  return result &&
    typeof result === "object" &&
    "skipped" in result &&
    (result as { skipped?: unknown }).skipped
    ? "SKIPPED"
    : "SUCCESS";
}

async function recordSkippedXeroTasks({
  task,
  reason,
}: {
  task: XeroCronTask | "all";
  reason: string;
}) {
  await Promise.all(
    tasksToRecord(task).map((subtask) =>
      recordCronJobRunSafe({
        jobName: xeroCronJobNames[subtask],
        startedAt: new Date(),
        status: "SKIPPED",
        resultSummary: { skipped: true, reason },
      })
    )
  );
}

async function runRecordedXeroTask<T>(
  task: XeroCronTask,
  work: () => Promise<T> | T
): Promise<T> {
  const startedAt = new Date();
  try {
    const result = await work();
    await recordCronJobRunSafe({
      jobName: xeroCronJobNames[task],
      startedAt,
      status: cronStatusForResult(result),
      resultSummary:
        result && typeof result === "object"
          ? (result as Record<string, unknown>)
          : { result },
    });
    return result;
  } catch (error) {
    await recordCronJobRunSafe({
      jobName: xeroCronJobNames[task],
      startedAt,
      status: "FAILURE",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * POST /api/cron/xero
 * Daily cron endpoint for refreshing membership statuses from Xero.
 * Secured with CRON_SECRET to prevent unauthorized access.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  const taskParam = request.nextUrl.searchParams.get("task") ?? "memberships";
  if (taskParam !== "all" && !isXeroCronTask(taskParam)) {
    return NextResponse.json(
      { error: "Invalid task. Expected memberships, outbox, retries, inbound, backfill, link-cleanup, report, or all." },
      { status: 400 }
    );
  }
  const task = taskParam as XeroCronTask | "all";

  if (!(await isEffectiveModuleEnabled("xeroIntegration"))) {
    const reason = "Operational Xero effective module state is disabled";
    await recordSkippedXeroTasks({ task, reason });
    return NextResponse.json({
      message: "Xero cron tasks skipped",
      task,
      connected: false,
      skipped: true,
      reason,
      membershipRefresh: null,
      queuedOutboxOperations: null,
      queuedRetries: null,
      inboundReconciliation: null,
      linkBackfill: null,
      linkCleanup: null,
      reconciliationReport: null,
    });
  }

  const connected = await isXeroConnected();

  try {
    const membershipRefresh =
      task === "memberships" || task === "all"
        ? await runRecordedXeroTask("memberships", async () =>
            !isXeroDailyMembershipRefreshEnabled()
              ? {
                  skipped: true,
                  reason:
                    "Daily membership refresh disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH",
                }
              : connected
                ? await refreshAllMembershipStatuses()
                : { skipped: true, reason: "Xero not connected" }
          )
        : null;
    const queuedOutboxOperations =
      task === "outbox" || task === "all"
        ? await runRecordedXeroTask("outbox", async () =>
            connected
              ? await processQueuedXeroOutboxOperations()
              : { skipped: true, reason: "Xero not connected" }
          )
        : null;
    const queuedRetries =
      task === "retries" || task === "all"
        ? await runRecordedXeroTask("retries", async () =>
            connected
              ? await processQueuedXeroOperationRetries()
              : { skipped: true, reason: "Xero not connected" }
          )
        : null;
    const inboundReconciliation =
      task === "inbound" || task === "all"
        ? await runRecordedXeroTask("inbound", async () =>
            connected
              ? await runXeroInboundReconciliationCycle()
              : { skipped: true, reason: "Xero not connected" }
          )
        : null;
    const linkBackfill =
      task === "backfill" || task === "all"
        ? await runRecordedXeroTask("backfill", () =>
            backfillHistoricalXeroObjectLinks()
          )
        : null;
    const linkCleanup =
      task === "backfill" || task === "link-cleanup" || task === "all"
        ? await runRecordedXeroTask("link-cleanup", () =>
            cleanupStaleCanonicalXeroObjectLinks()
          )
        : null;
    const reconciliationReport =
      task === "report" || task === "all"
        ? await runRecordedXeroTask("report", () =>
            sendXeroReconciliationReport()
          )
        : null;

    return NextResponse.json({
      message:
        task === "all"
          ? "Xero cron tasks completed"
          : task === "report"
            ? "Xero reconciliation report completed"
            : task === "backfill"
              ? "Historical Xero link maintenance completed"
              : task === "link-cleanup"
                ? "Stale Xero canonical links cleaned up"
              : task === "inbound"
                ? "Xero inbound reconciliation cycle completed"
                : task === "outbox"
                  ? "Queued Xero outbox operations processed"
                  : task === "retries"
                ? "Queued Xero retries processed"
                : "Membership status refresh completed",
      task,
      connected,
      membershipRefresh,
      queuedOutboxOperations,
      queuedRetries,
      inboundReconciliation,
      linkBackfill,
      linkCleanup,
      reconciliationReport,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron job failed";
    logger.error({ err: message, task }, "Xero cron job error");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
