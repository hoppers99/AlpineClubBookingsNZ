import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { redactExpiredIssueReportSensitiveData } from "@/lib/issue-report-retention";
import { redactExpiredMaintenanceReportSensitiveData } from "@/lib/maintenance-report-retention";
import logger from "@/lib/logger";

/**
 * The report-retention sweep. Daily, cron-secret gated.
 *
 * It redacts TWO populations, deliberately from one route (#2780): expired
 * in-app issue-report screenshots and browser info, and expired maintenance
 * photos and submitter fingerprints. A second cron entry would be a second thing
 * an operator has to be told to schedule, and a club that missed the memo would
 * keep photos for ever with nothing saying so.
 *
 * The two are awaited independently rather than in a `Promise.all`, so a failure
 * in one population cannot stop the other from being redacted — a partial sweep
 * that deletes what it can is strictly better than one that deletes nothing, and
 * the next run retries whatever failed because the predicate is `lte: now`.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  let issueResult: Awaited<ReturnType<typeof redactExpiredIssueReportSensitiveData>> | null =
    null;
  let issueError: unknown = null;
  try {
    issueResult = await redactExpiredIssueReportSensitiveData();
  } catch (err) {
    issueError = err;
    logger.error({ err }, "Issue report retention cron failed");
  }

  let maintenanceResult: Awaited<
    ReturnType<typeof redactExpiredMaintenanceReportSensitiveData>
  > | null = null;
  let maintenanceError: unknown = null;
  try {
    maintenanceResult = await redactExpiredMaintenanceReportSensitiveData();
  } catch (err) {
    maintenanceError = err;
    logger.error({ err }, "Maintenance report retention cron failed");
  }

  if (issueError || maintenanceError) {
    return NextResponse.json(
      {
        error: "Failed to redact expired report data",
        ...(issueResult ?? {}),
        ...(maintenanceResult ?? {}),
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    ...(issueResult ?? {}),
    ...(maintenanceResult ?? {}),
  });
}
