import { NextRequest, NextResponse } from "next/server";
import { confirmPendingBookings } from "@/lib/cron-confirm-pending";
import { requireCronSecret } from "@/lib/cron-auth";
import { recordCronJobRunSafe } from "@/lib/cron-job-run";
import logger from "@/lib/logger";

/**
 * Manual trigger for the pending booking confirmation cron job.
 * Secured with CRON_SECRET header.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  const startedAt = new Date();
  try {
    const result = await confirmPendingBookings();
    await recordCronJobRunSafe({
      jobName: "confirm-pending",
      startedAt,
      status: "SUCCESS",
      resultSummary: result,
    });
    return NextResponse.json({
      success: true,
      confirmed: result.confirmedBookingIds,
      bumped: result.bumpedBookingIds,
      failed: result.failedBookingIds,
    });
  } catch (err) {
    logger.error({ err }, "Cron endpoint error");
    await recordCronJobRunSafe({
      jobName: "confirm-pending",
      startedAt,
      status: "FAILURE",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to process pending bookings" },
      { status: 500 }
    );
  }
}
