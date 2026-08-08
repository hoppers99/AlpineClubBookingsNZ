import * as Sentry from "@sentry/nextjs";

import logger from "@/lib/logger";

/**
 * Where a planner invariant violation was detected (#2656). Free-form context
 * for the log line and the breadcrumb — never anything member-identifying.
 */
export interface BedAllocationInvariantContext {
  /** The booking whose reconcile / board render produced the plan, if any. */
  bookingId?: string | null;
  lodgeId?: string | null;
  /** The calling entry point, so the log line names the path that hit it. */
  source: string;
}

/**
 * Report a bed-allocation planner bookkeeping divergence (#2656, owner
 * decision 8 Aug 2026).
 *
 * `src/lib/bed-allocation.ts` is pure and deterministic — no logger, no Sentry,
 * no clock — so it detects a divergence and hands the message to its caller via
 * `onInvariantViolation`. This is the shared implementation of what the callers
 * then do with it: a logged warning plus a Sentry breadcrumb, so a live lodge
 * hitting the condition is visible in the next error report rather than
 * carrying it silently, and WITHOUT throwing a 500 at a member mid-booking.
 * The hard assertion stays test-only.
 *
 * A breadcrumb, not an event, on purpose: it is a diagnostic that the plan may
 * be built on a stale composition index, not by itself a failure — it attaches
 * context to whatever the request goes on to report.
 *
 * Every failure mode is swallowed. A diagnostic must never be able to break
 * the allocation path it is describing.
 */
export function reportBedAllocationInvariantViolation(
  message: string,
  context: BedAllocationInvariantContext,
): void {
  try {
    logger.warn(
      {
        issue: 2656,
        bookingId: context.bookingId ?? null,
        lodgeId: context.lodgeId ?? null,
        source: context.source,
        divergence: message,
      },
      "Bed-allocation planner invariant violation: the room-night age-mix index diverged from the occupant view",
    );
  } catch {
    // A logging failure must never reach the allocation path.
  }
  try {
    Sentry.addBreadcrumb({
      category: "bed-allocation",
      level: "warning",
      message: "bed-allocation planner invariant violation",
      data: {
        issue: 2656,
        bookingId: context.bookingId ?? null,
        lodgeId: context.lodgeId ?? null,
        source: context.source,
        divergence: message,
      },
    });
  } catch {
    // Sentry failures must never reach the allocation path.
  }
}
