import type { Prisma } from "@prisma/client";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";

type RosterLockTx = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * Serialise every writer that can change the roster for one NZ lodge night.
 *
 * The key deliberately remains date-only for compatibility with the existing
 * roster-generation lock. That makes writers for different lodges on the same
 * night contend briefly, but it also lets legacy/current writers share one
 * unambiguous lock family while every query is independently lodge-scoped.
 */
export async function lockRosterDate(
  tx: RosterLockTx,
  date: Date,
) {
  const lockKey = `roster:${formatDateOnly(date)}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}

/**
 * Lock an eligibility-validating roster mutation in the shared writer order.
 *
 * Booking lifecycle/consent writers already take the global and/or immutable
 * lodge tiers. Joining both before the roster-date key makes their commit
 * visible before a roster mutation performs its authoritative eligibility
 * read, including when the roster partition was initially empty.
 */
export async function lockRosterEligibilityMutation(
  tx: Prisma.TransactionClient,
  lodgeId: string,
  date: Date,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  await acquireLodgeCapacityLock(tx, lodgeId);
  await lockRosterDate(tx, date);
}

/** Acquire several roster-date locks in deterministic date order. */
export async function lockRosterDates(
  tx: RosterLockTx,
  dates: Iterable<Date>,
) {
  const uniqueDates = new Map<string, Date>();
  for (const date of dates) uniqueDates.set(formatDateOnly(date), date);
  for (const [, date] of [...uniqueDates].sort(([a], [b]) => a.localeCompare(b))) {
    await lockRosterDate(tx, date);
  }
}

/**
 * Lock every lodge night in each half-open [start, end) date-only range.
 * `lockRosterDates` sorts and de-duplicates the resulting keys, so old and
 * proposed booking/guest ranges can overlap without changing lock order.
 */
export async function lockRosterDateRanges(
  tx: RosterLockTx,
  ranges: Array<{ start: Date; end: Date }>,
) {
  await lockRosterDateRangesAndDates(tx, ranges, []);
}

/**
 * Acquire one sorted lock set for date ranges plus exceptional stored dates.
 *
 * Booking mutations use this before tuple writes so an out-of-envelope legacy
 * assignment cannot make cleanup discover and acquire a lower roster key after
 * a higher one is already held.
 */
export async function lockRosterDateRangesAndDates(
  tx: RosterLockTx,
  ranges: Array<{ start: Date; end: Date }>,
  dates: Iterable<Date>,
) {
  await lockRosterDates(tx, [
    ...ranges.flatMap((range) => eachDateOnlyInRange(range.start, range.end)),
    ...dates,
  ]);
}
