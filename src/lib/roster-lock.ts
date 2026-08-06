import type { Prisma } from "@prisma/client";
import { formatDateOnly } from "@/lib/date-only";

/**
 * Serialise every writer that can change the roster for one NZ lodge night.
 *
 * The key deliberately remains date-only for compatibility with the existing
 * roster-generation lock. That makes writers for different lodges on the same
 * night contend briefly, but it also lets legacy/current writers share one
 * unambiguous lock family while every query is independently lodge-scoped.
 */
export async function lockRosterDate(
  tx: Prisma.TransactionClient,
  date: Date,
) {
  const lockKey = `roster:${formatDateOnly(date)}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}

/** Acquire several roster-date locks in deterministic date order. */
export async function lockRosterDates(
  tx: Prisma.TransactionClient,
  dates: Iterable<Date>,
) {
  const uniqueDates = new Map<string, Date>();
  for (const date of dates) uniqueDates.set(formatDateOnly(date), date);
  for (const [, date] of [...uniqueDates].sort(([a], [b]) => a.localeCompare(b))) {
    await lockRosterDate(tx, date);
  }
}
