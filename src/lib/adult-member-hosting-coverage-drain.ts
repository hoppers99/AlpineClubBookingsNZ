import type { Prisma } from "@prisma/client";

import {
  claimHostingCoverageOwnerNotification,
  completeHostingCoverageOwnerNotification,
  releaseHostingCoverageOwnerNotification,
  resolveHostingCoverageIncidents,
} from "@/lib/adult-member-hosting-coverage-incidents";
import {
  claimHostingCoverageReevaluations,
  completeHostingCoverageReevaluation,
  failHostingCoverageReevaluation,
  type HostingCoverageReevaluationItem,
} from "@/lib/adult-member-hosting-coverage-queue";
import {
  loadSameOwnerCoverageDependentIds,
  loadAdultMemberHostingPolicy,
  reconcileSameOwnerCoverageIncident,
} from "@/lib/adult-member-hosting-review";
import { sendHostingCoverageLostEmail } from "@/lib/email/booking";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Drain the bounded same-owner re-evaluation queue (#2576 §8).
 *
 * The post-commit half of the escalation path: an authoritative change recorded
 * what needs looking at inside its own transaction, and this re-reads the facts,
 * settles each dependent booking's incident, and notifies the owner once per
 * transition.
 *
 * Each claimed item is reconciled inside one SHORT transaction. That is required
 * because the evaluator's owner advisory lock is transaction-scoped: without the
 * wrapper it would be released immediately after the lock statement and protect
 * none of the reads or incident writes. The transaction starts only after the
 * authoritative caller commit, so it still re-reads committed facts, and email is
 * sent only after this reconciliation transaction commits.
 *
 * RUN TWICE, ON PURPOSE. Callers run it INLINE immediately after their commit, so
 * §7's "immediate re-evaluation" is real; the general cron sweep runs it again so
 * a crashed process, a failed email or a redeployment mid-drain cannot leave a
 * booking uncovered with nobody told. Inline failures are logged and swallowed —
 * the authoritative change has already committed and must not be undone by a
 * follow-up problem — because the cron is the authority on completion.
 */

export interface HostingCoverageDrainResult {
  claimed: number;
  processed: number;
  incidentsOpened: number;
  incidentsUpdated: number;
  incidentsResolved: number;
  notified: number;
  failed: number;
}

const EMPTY_RESULT: HostingCoverageDrainResult = {
  claimed: 0,
  processed: 0,
  incidentsOpened: 0,
  incidentsUpdated: 0,
  incidentsResolved: 0,
  notified: 0,
  failed: 0,
};

/**
 * Drain the queue immediately after a caller's transaction has committed, and never
 * let a problem in the drain surface as a failure of the change that committed
 * (#2576 §7's "immediate re-evaluation", §8's "re-read current facts after commit").
 *
 * BEST-EFFORT ON PURPOSE, AND THE CRON IS THE AUTHORITY. The authoritative change
 * is already committed and must not be undone by a follow-up problem — an officer's
 * cancellation does not un-cancel because an email bounced — so every failure here
 * is logged and swallowed. The queue row is still unprocessed, so the general cron
 * sweep re-runs it; the cost of the inline attempt failing is a delay, never a lost
 * obligation.
 *
 * MUST BE CALLED AFTER THE COMMIT, never inside the transaction. Inside, it would
 * read the uncommitted rows it exists to re-read, and it would send email from a
 * transaction that can still roll back. Callers place it after their
 * `prisma.$transaction(...)` returns.
 *
 * A no-op when the queue is empty — one indexed read that returns nothing — so a
 * club that is not on this scope pays a single cheap query per mutation, and only
 * on the paths that can escalate.
 *
 * SCOPED TO THE BOOKING THAT WAS JUST WRITTEN, AND THAT IS NOT AN OPTIMISATION.
 * Callers pass `bookingId`; this resolves its owner and lodge and claims only their
 * items, with a small limit. An unfiltered inline claim meant that after an
 * officer's bulk cancellation or a membership sweep left a backlog, the next
 * unrelated member's guest edit would run up to 25 OTHER owners' reconciliations —
 * each fanning out to as many as 25 dependents, each able to send a synchronous
 * loss-of-cover email — inside their request, before it answered. The cron drains
 * everything; a member's request drains only what their own transaction created.
 *
 * A caller that cannot name a booking (it was hard-deleted, or the work is a
 * member-level fan-out across lodges) may pass nothing and gets the unfiltered
 * claim, still capped: the obligation is real and the cron is only three hours away
 * at worst, but immediate is better.
 */
export async function settleHostingCoverageAfterCommit(
  options: {
    /** The booking whose transaction just committed; scopes the claim. */
    bookingId?: string | null;
    memberId?: string | null;
    lodgeId?: string | null;
    limit?: number;
  } = {},
  db: typeof prisma = prisma,
): Promise<HostingCoverageDrainResult> {
  try {
    let { memberId, lodgeId } = options;
    if (options.bookingId && !memberId && !lodgeId) {
      const booking = await db.booking.findUnique({
        where: { id: options.bookingId },
        select: { memberId: true, lodgeId: true },
      });
      memberId = booking?.memberId ?? null;
      lodgeId = booking?.lodgeId ?? null;
    }
    return await drainHostingCoverageReevaluations(
      {
        limit: options.limit ?? INLINE_DRAIN_LIMIT,
        ...(memberId ? { memberId } : {}),
        ...(lodgeId ? { lodgeId } : {}),
      },
      db,
    );
  } catch (err) {
    logger.error(
      { err },
      "Inline same-owner hosting coverage drain failed; leaving it to the cron sweep",
    );
    return { ...EMPTY_RESULT };
  }
}

/**
 * How many items one member's request will settle inline.
 *
 * Small on purpose. A single change can legitimately produce one item; a handful
 * covers the split-booking and group shapes where one commit touches several. Beyond
 * that the work is somebody else's backlog and belongs to the cron.
 */
const INLINE_DRAIN_LIMIT = 5;

export async function drainHostingCoverageReevaluations(
  options: {
    limit?: number;
    maxAttempts?: number;
    memberId?: string | null;
    lodgeId?: string | null;
  } = {},
  db: typeof prisma = prisma,
): Promise<HostingCoverageDrainResult> {
  const items = await claimHostingCoverageReevaluations(options, db);
  if (items.length === 0) return { ...EMPTY_RESULT };

  const result: HostingCoverageDrainResult = { ...EMPTY_RESULT, claimed: items.length };
  for (const item of items) {
    try {
      // The evaluator takes transaction-scoped owner advisory locks. Run all
      // database reconciliation for one bounded item in a REAL transaction so
      // those locks remain held through its reads and incident writes. Email is
      // deliberately handled after this transaction commits.
      const outcome = await db.$transaction((tx) =>
        processHostingCoverageReevaluation(item, tx),
      );
      result.incidentsOpened += outcome.incidentsOpened;
      result.incidentsUpdated += outcome.incidentsUpdated;
      result.incidentsResolved += outcome.incidentsResolved;

      for (const notification of outcome.notifications) {
        try {
          const sent = await notifyOwnerOfLostCoverage(notification.bookingId, db);
          if (sent) {
            const completed = await completeHostingCoverageOwnerNotification(
              notification,
              db,
            );
            if (completed) result.notified += 1;
          } else {
            await releaseHostingCoverageOwnerNotification(notification, db);
          }
        } catch (err) {
          await releaseHostingCoverageOwnerNotification(notification, db).catch(
            () => undefined,
          );
          throw err;
        }
      }
      const completed = await completeHostingCoverageReevaluation(item, db);
      if (completed) {
        result.processed += 1;
      } else {
        logger.warn(
          { itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
          "Hosting coverage re-evaluation finished after its claim was replaced",
        );
      }
    } catch (err) {
      logger.error(
        { err, itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
        "Failed to re-evaluate same-owner hosting coverage",
      );
      const failureRecorded = await failHostingCoverageReevaluation(
        item,
        err instanceof Error ? err.message : String(err),
        db,
      ).catch(() => false);
      if (failureRecorded) {
        result.failed += 1;
      } else {
        logger.warn(
          { itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
          "Hosting coverage re-evaluation failure arrived after its claim was replaced",
        );
      }
    }
  }
  return result;
}

/**
 * Settle one queued item: every active booking of that owner, at that lodge, over
 * those nights.
 *
 * Bounded by the item itself (§10) — see `loadSameOwnerCoverageDependentIds`, which
 * turns the owner/lodge/night triple into a booking-id list and cannot be widened
 * into a lodge-wide sweep.
 *
 * §14's EXISTENTIAL RULE IS WHAT THIS LOOP IMPLEMENTS. It does not ask "did the
 * source that used to cover this booking go away"; it asks "is this booking covered
 * NOW, by anything". So a booking with a second eligible same-owner source stays
 * compliant, an incident opened earlier is resolved rather than left standing, and
 * no misleading loss-of-cover message is sent.
 */
async function processHostingCoverageReevaluation(
  item: HostingCoverageReevaluationItem,
  db: Prisma.TransactionClient,
): Promise<{
  incidentsOpened: number;
  incidentsUpdated: number;
  incidentsResolved: number;
  notifications: Array<{
    bookingId: string;
    incidentId: string;
    stateKey: string;
    claimToken: string;
  }>;
}> {
  const counts = {
    incidentsOpened: 0,
    incidentsUpdated: 0,
    incidentsResolved: 0,
    notifications: [] as Array<{
      bookingId: string;
      incidentId: string;
      stateKey: string;
      claimToken: string;
    }>,
  };
  const policy = await loadAdultMemberHostingPolicy(item.lodgeId, db);
  const dependentIds =
    policy.hostScopes.sameBookingOwner || !item.sourceBookingId
      ? await loadSameOwnerCoverageDependentIds(
          { memberId: item.memberId, lodgeId: item.lodgeId, nights: item.nights },
          db,
        )
      : [item.sourceBookingId];

  for (const bookingId of dependentIds) {
    const outcome = await reconcileSameOwnerCoverageIncident(
      {
        bookingId,
        cause: item.cause,
        actorMemberId: item.actorMemberId,
        reason: item.reason,
      },
      db,
    );
    if (outcome.action === "resolved") {
      counts.incidentsResolved += 1;
      continue;
    }
    if (outcome.action === "none") continue;

    if (outcome.action === "opened") counts.incidentsOpened += 1;
    else if (outcome.action === "updated") counts.incidentsUpdated += 1;

    const claimed = await claimHostingCoverageOwnerNotification(
      { incidentId: outcome.incidentId, stateKey: outcome.stateKey },
      db,
    );
    if (!claimed) continue;
    counts.notifications.push({
      bookingId,
      ...claimed,
    });
  }

  // The SOURCE booking itself may have been cancelled by the change that queued
  // this work, in which case any incident it was carrying is moot: nobody can
  // restore cover for a stay that is not happening. §7 lists cancellation of the
  // affected booking as one of the four automatic resolutions.
  if (item.sourceBookingId && !dependentIds.includes(item.sourceBookingId)) {
    counts.incidentsResolved += await resolveHostingCoverageIncidents(
      {
        bookingId: item.sourceBookingId,
        resolution: "BOOKING_CANCELLED",
        actorMemberId: item.actorMemberId,
      },
      db,
    );
  }

  return counts;
}

/**
 * Send the owner the loss-of-cover notice, having already claimed it.
 *
 * Returns whether a message was actually sent. A missing email address is not an
 * error and not a retry: the incident is still open, still in the officer queue,
 * and an officer contacting a member with no address on file is the club's normal
 * process. Re-queueing forever over an absent address would hide real failures.
 */
async function notifyOwnerOfLostCoverage(
  bookingId: string,
  db: typeof prisma,
): Promise<boolean> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
      adultMemberHostingReview: true,
      member: { select: { firstName: true, email: true } },
    },
  });
  if (!booking?.member?.email) return false;

  const review = booking.adultMemberHostingReview as {
    affectedNights?: unknown;
  } | null;
  const nights = Array.isArray(review?.affectedNights)
    ? review.affectedNights.filter(
        (night): night is string => typeof night === "string",
      )
    : [];

  const outcome = await sendHostingCoverageLostEmail({
    bookingId: booking.id,
    recipientMemberId: booking.memberId,
    email: booking.member.email,
    firstName: booking.member.firstName,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    // The nights come off the snapshot the reconciliation just wrote, so the
    // email cannot describe a different problem from the incident.
    uncoveredNights: nights.length > 0 ? nights.join(", ") : "see your booking",
    lodgeId: booking.lodgeId,
  });
  return outcome.status === "sent";
}
