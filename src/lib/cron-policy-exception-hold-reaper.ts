/**
 * Abandoned policy-exception capacity-hold reaper (#2553, follow-up to #2525).
 *
 * A HOLD-mode policy-exception request reserves real beds the moment it is
 * raised (`PolicyExceptionReservationNight`, #2525) so that an eventual approval
 * is guaranteed to fit. Every DECIDED outcome gives those beds back atomically —
 * the officer's reject, the member's cancel, a supersede, or the approval that
 * turns them into the executed booking's own beds. What had no owner was the
 * request nobody ever decides: it stayed REQUESTED and held its beds forever,
 * blocking other members' admissions until an officer noticed and rejected it by
 * hand.
 *
 * This cron is that missing owner. It mirrors the `nonMemberHoldUntil`
 * auto-cancel pattern (`cron-confirm-pending.ts`) and the stale group-settlement
 * reaper (`cron-group-settlement-reaper.ts`): scan for holds past their
 * deadline, then resolve each one through the SAME guarded transition the
 * decided outcomes use.
 *
 * Three properties do the work:
 *
 *  - **It only ever touches a hold that is demonstrably stranding beds.** The
 *    scan is REQUESTED + POLICY_EXCEPTION + HOLD aggregate + at least one live
 *    `PolicyExceptionReservationNight` row. A HOLD request that reserved nothing
 *    (a pure shrink) costs the club no capacity, so this cron never closes it.
 *  - **The release path is not forked.** Each expiry calls
 *    `resolvePolicyExceptionRequestTerminal` with `to: "EXPIRED"` — the identical
 *    global `lock(1)` -> per-lodge lock -> guarded `version` CAS ->
 *    request-scoped `deleteMany` that REJECTED / CANCELLED / SUPERSEDED run. No
 *    second release implementation exists to drift.
 *  - **It is idempotent.** The deadline is an immutable column, the claim is
 *    guarded on `status = REQUESTED` AND the exact `version` read during the
 *    scan, and a lost claim releases nothing and reports nothing. A rerun over
 *    an already-expired request matches no row and does nothing; two runners
 *    racing the same request produce exactly one expiry.
 *
 * No email is sent and no provider is called: the request's own EXPIRED status
 * is the durable fact, surfaced through the existing member and officer request
 * reads.
 */
import { prisma } from "@/lib/prisma";
import { resolvePolicyExceptionRequestTerminal } from "@/lib/booking-exception-execution";
import { computePolicyExceptionHoldExpiry } from "@/lib/booking-exception-requests";
import logger from "@/lib/logger";

export interface PolicyExceptionHoldReapResult {
  /** Open HOLD-mode policy-exception requests examined this run. */
  scanned: number;
  /** Requests this run moved REQUESTED -> EXPIRED. */
  expired: number;
  /** Reservation night rows those expiries released. */
  releasedNights: number;
  /** Requests whose expiry threw; logged and retried on the next run. */
  failed: number;
}

/**
 * Release every abandoned HOLD-mode policy-exception hold whose deadline has
 * passed, marking each request EXPIRED.
 *
 * The candidate scan is deliberately narrow — open, policy-exception, HOLD
 * aggregate, and actually holding reservation nights — which is a handful of rows
 * even on a busy club, so the deadline comparison happens in memory rather than
 * as a second index requirement.
 */
export async function reapExpiredPolicyExceptionHolds(
  now: Date = new Date(),
): Promise<PolicyExceptionHoldReapResult> {
  const candidates = await prisma.bookingChangeRequest.findMany({
    where: {
      kind: "POLICY_EXCEPTION",
      status: "REQUESTED",
      // Only a HOLD aggregate ever reserved beds (#2525); a NO_HOLD request
      // strands no capacity, so it is not this cron's business and keeps its
      // place in the officer queue until somebody decides it.
      aggregateCapacityMode: "HOLD",
      // ...and only a request that is DEMONSTRABLY still holding beds right now.
      // A HOLD aggregate can reserve nothing at all (a pure shrink, or a
      // reshuffle that adds no bed on any night — `computeProposalReservation`
      // returns an empty footprint), and reservation rows are written only at
      // creation and deleted only by a terminal transition, so for a REQUESTED
      // row "has reservation nights" is exactly "is stranding capacity". This
      // filter is what keeps the cron's blast radius to the bug in the issue: it
      // can never close a live request that costs the club nothing to leave open.
      reservationNights: { some: {} },
    },
    select: {
      id: true,
      version: true,
      holdExpiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const result: PolicyExceptionHoldReapResult = {
    scanned: candidates.length,
    expired: 0,
    releasedNights: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    // `holdExpiresAt` is stamped at creation and never rewritten, so it is the
    // authoritative deadline. Inside THIS scan, NULL can only be the blue/green
    // drain case — a bed-holding request the OLD colour wrote between `migrate`
    // and cutover, which has no column value and would otherwise hold its beds
    // forever, exactly the bug this issue exists to close. (The other NULL
    // population, a HOLD aggregate that reserved nothing, never reaches here: the
    // `reservationNights` filter above excludes it.) Fall back to the same pure
    // rule applied to `createdAt`, without the first-night cap (the footprint is
    // not in this read), which is the conservative direction: it can only expire
    // later, never sooner.
    const deadline =
      candidate.holdExpiresAt ??
      computePolicyExceptionHoldExpiry({ createdAt: candidate.createdAt });
    if (now < deadline) continue;

    try {
      const outcome = await resolvePolicyExceptionRequestTerminal({
        requestId: candidate.id,
        expectedVersion: candidate.version,
        to: "EXPIRED",
      });
      if (!outcome.claimed) {
        // Somebody decided it between the scan and the lock (approved,
        // rejected, cancelled, superseded) — their transition wins and already
        // dealt with the beds. Nothing to release, nothing to report.
        continue;
      }
      result.expired += 1;
      result.releasedNights += outcome.released;
      logger.info(
        {
          changeRequestId: candidate.id,
          releasedNights: outcome.released,
          job: "policy-exception-hold-reaper",
        },
        "Released an abandoned policy-exception capacity hold and expired its request",
      );
    } catch (err) {
      result.failed += 1;
      logger.error(
        {
          err,
          changeRequestId: candidate.id,
          job: "policy-exception-hold-reaper",
        },
        "Failed to expire an abandoned policy-exception capacity hold",
      );
    }
  }

  return result;
}
