import { prisma } from "./prisma";
import logger from "./logger";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";

/**
 * OBS-08: Record a webhook invocation for monitoring.
 */
export async function recordWebhookLog(data: {
  source: string;
  eventType: string;
  eventId: string;
  status: "success" | "failure";
  durationMs: number;
  error?: string;
}) {
  try {
    const createData = {
      ...data,
      ...(data.error ? { error: redactSensitiveText(data.error) } : {}),
    };
    await prisma.webhookLog.create({ data: createData });
  } catch (err) {
    // INV-PRIV-011 (#2683): log the webhook's identifiers, not the payload
    // wrapper. `...data` spread the caller's RAW `error` string — the one field
    // this function redacts before it is allowed near the database — straight
    // into the application log, so the write path was stricter than the
    // failure path it falls back to. It is redacted here too now, and the
    // remaining fields are named one by one so a field added to the argument
    // later cannot join the log line by accident.
    logger.error(
      {
        err,
        source: data.source,
        eventType: data.eventType,
        eventId: data.eventId,
        status: data.status,
        durationMs: data.durationMs,
        ...(data.error ? { error: redactSensitiveText(data.error) } : {}),
      },
      "Failed to record webhook log"
    );
  }
}

/**
 * OBS-08: Get webhook stats for the admin health dashboard.
 * Returns success/failure counts by source for the last 24 hours.
 */
export async function getWebhookStats(hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const logs = await prisma.webhookLog.groupBy({
    by: ["source", "status"],
    where: { createdAt: { gte: since } },
    _count: { id: true },
  });

  const stats: Record<string, { success: number; failure: number; total: number }> = {};

  for (const row of logs) {
    if (!stats[row.source]) {
      stats[row.source] = { success: 0, failure: 0, total: 0 };
    }
    const count = row._count.id;
    if (row.status === "success") {
      stats[row.source].success += count;
    } else {
      stats[row.source].failure += count;
    }
    stats[row.source].total += count;
  }

  return stats;
}

/**
 * OBS-08: Prune webhook logs older than 30 days.
 */
export async function pruneWebhookLogs() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const { count } = await prisma.webhookLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (count > 0) {
    logger.info({ deletedCount: count }, "Pruned old webhook logs");
  }
  return count;
}
