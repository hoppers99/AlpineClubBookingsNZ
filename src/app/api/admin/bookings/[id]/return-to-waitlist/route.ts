import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { sendWaitlistOfferExpiredEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION } from "@/lib/waitlist-confirm-recovery-contract";
import {
  RETURN_TO_WAITLIST_AUDIT_ACTION,
  RETURN_TO_WAITLIST_CLAIM_LOST_MESSAGE,
  RETURN_TO_WAITLIST_CONTENDED_MESSAGE,
  RETURN_TO_WAITLIST_PAYMENT_PRESENT_MESSAGE,
  RETURN_TO_WAITLIST_PRICED_MESSAGE,
  RETURN_TO_WAITLIST_STATUS_MESSAGE,
  isReturnToWaitlistTransactionContention,
} from "@/lib/waitlist-return-contract";
import { processWaitlistForDates } from "@/lib/waitlist";

/**
 * Return a stranded zero-dollar waitlist confirm to the waitlist (#2649).
 *
 * The repair the failed compensation in `waitlist-confirm` would have made.
 * #2648 left exactly one recoverable state behind: a free booking committed to
 * `PAYMENT_PENDING` with its offer consumed, whose `PAID` claim failed AND
 * whose compensating release back to `WAITLISTED` could not run either. It
 * holds no bed, owes nothing, and has no offer to replay, so no cron clears it
 * and the member cannot retry. Until now the only way to put their place back
 * was direct database access.
 *
 * ## What it accepts, and why so narrowly
 *
 * `PAYMENT_PENDING` **and** `finalPriceCents === 0` **and** no `Payment` row —
 * exactly the stranded shape (#2649 owner decision, Recommended option). A
 * priced booking has a payment path and is none of this tool's business; a
 * booking with a payment row already completed its confirm, because a free
 * confirm mints its $0 payment strictly AFTER reaching `PAID` (#2623). Both
 * facts are re-read under the locks, and the price is re-asserted in the claim
 * itself, so neither can be true at check time and false at write time.
 *
 * ## Locking
 *
 * Global booking/money `lock(1)` FIRST, then this booking's own immutable lodge
 * capacity key — the order `docs/CONCURRENCY_AND_LOCKING.md` mandates for a
 * writer that moves booking status AND capacity, and the same order the two
 * releases in `waitlist-confirm/route.ts` take. `PAYMENT_PENDING` holds
 * capacity and `WAITLISTED` does not, so this write frees beds and must
 * serialise against every per-lodge creator as well as against cancel and
 * settlement.
 *
 * The claim is a status-guarded `updateMany`. A lost claim returns before the
 * allocation reconcile, before the audit row, and before the transaction does
 * anything else; the caller's post-commit block runs no email and no waitlist
 * processing on any refusal, so a lost claim has no side effect at all.
 *
 * ## Hosting coverage
 *
 * Deliberately none — byte-for-byte parity with the two existing
 * `PAYMENT_PENDING -> WAITLISTED` releases (`waitlist-confirm/route.ts`, the
 * capacity-lost branch and the compensation), neither of which touches adult
 * member hosting coverage. `enqueueOwnHostingCoverageReevaluation` is for
 * CONFIRMING transitions that add attendance; this one removes it. Whether a
 * release should re-evaluate cover the way a cancellation does is a question
 * about all three release sites at once and is carried forward as its own
 * issue rather than answered differently here for one of them.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;
  const auditRequest = getAuditRequestContext(request);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      // Immutable identity only. `Booking.lodgeId` is the lock key and never
      // changes, and `createdAt` is the queue's FIFO ordering — reading either
      // before the lodge lock is safe, and nothing else is read here.
      const key = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { lodgeId: true, memberId: true, createdAt: true },
      });
      if (!key) return { error: "Booking not found", status: 404 } as const;

      await acquireLodgeCapacityLock(tx, key.lodgeId);

      // Everything mutable is read only now, under both locks.
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          status: true,
          finalPriceCents: true,
          checkIn: true,
          checkOut: true,
          // The consumed offer. Read not because the repair needs it — the
          // claim below nulls all four unconditionally — but because the claim
          // DESTROYS the only live copy: #2648's
          // `waitlist.confirm_offer_release_failed` row records the lodge,
          // dates, price and error codes and none of these. Without a snapshot
          // in the repair's own audit row there is afterwards no way to answer
          // "what was this member actually offered, and when did it expire?"
          waitlistOfferedAt: true,
          waitlistOfferExpiresAt: true,
          waitlistOfferedLodgeId: true,
          waitlistOfferedPriceCents: true,
          member: { select: { email: true, firstName: true } },
          payment: { select: { id: true } },
        },
      });
      if (!booking) return { error: "Booking not found", status: 404 } as const;

      if (booking.status !== BookingStatus.PAYMENT_PENDING) {
        return {
          error: RETURN_TO_WAITLIST_STATUS_MESSAGE,
          status: 409,
        } as const;
      }
      if (booking.finalPriceCents !== 0) {
        return { error: RETURN_TO_WAITLIST_PRICED_MESSAGE, status: 409 } as const;
      }
      if (booking.payment) {
        return {
          error: RETURN_TO_WAITLIST_PAYMENT_PRESENT_MESSAGE,
          status: 409,
        } as const;
      }

      // The same field set the three in-tree reverts write, plus
      // `waitlistPosition`. The confirm's first phase already nulled the
      // position on its way out of the queue, so nulling it here is a no-op on
      // the stranded shape — but it makes the documented outcome ("back of the
      // queue by the ordinary rule") true by construction rather than by
      // inheritance. `finalPriceCents` is re-asserted in the guard so a
      // concurrent re-price cannot turn this into an un-confirm of a priced
      // booking.
      const restored = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: BookingStatus.PAYMENT_PENDING,
          finalPriceCents: 0,
        },
        data: {
          status: BookingStatus.WAITLISTED,
          waitlistPosition: null,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
          waitlistOfferedLodgeId: null,
          waitlistOfferedPriceCents: null,
        },
      });
      if (restored.count !== 1) {
        // Returning here COMMITS, so a lost claim must have written nothing:
        // the reconcile, the audit row, the email and the waitlist sweep all
        // sit below this guard.
        return { error: RETURN_TO_WAITLIST_CLAIM_LOST_MESSAGE, status: 409 } as const;
      }

      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId,
        db: tx,
        previousRange: { checkIn: booking.checkIn, checkOut: booking.checkOut },
      });

      // The place the member is told they hold. Same rule as the offer-expiry
      // email quotes (`waitlist.ts` `expireStaleOffers`): per-lodge queue,
      // overlapping nights, FIFO on `createdAt`. Counted under the locks, so it
      // cannot be quoted from a queue that moved.
      const ahead = await tx.booking.count({
        where: {
          status: BookingStatus.WAITLISTED,
          lodgeId: key.lodgeId,
          checkIn: { lt: booking.checkOut },
          checkOut: { gt: booking.checkIn },
          createdAt: { lt: key.createdAt },
        },
      });
      const waitlistPosition = ahead + 1;

      // Close the trail: name the row that reported the strand, so an operator
      // reading either entry can reach the other.
      const strandedRow = await tx.auditLog.findFirst({
        where: {
          action: WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION,
          targetId: bookingId,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true },
      });

      await createAuditLog(
        {
          action: RETURN_TO_WAITLIST_AUDIT_ACTION,
          memberId: session.user.id,
          actorMemberId: session.user.id,
          subjectMemberId: key.memberId,
          targetId: bookingId,
          entityType: "Booking",
          entityId: bookingId,
          category: "booking",
          severity: "important",
          outcome: "success",
          summary: "Stranded zero-dollar waitlist confirm returned to the waitlist",
          details:
            "Admin returned a free booking stranded in PAYMENT_PENDING to WAITLISTED, clearing the consumed offer so the ordinary offer worker can replay it. This is the repair the failed compensating release would have made.",
          metadata: {
            lodgeId: key.lodgeId,
            checkIn: booking.checkIn.toISOString(),
            checkOut: booking.checkOut.toISOString(),
            finalPriceCents: booking.finalPriceCents,
            previousStatus: BookingStatus.PAYMENT_PENDING,
            nextStatus: BookingStatus.WAITLISTED,
            waitlistPosition,
            // The offer this repair consumed, as it stood immediately before
            // the claim nulled it. Nothing else retains it.
            clearedOffer: {
              waitlistOfferedAt:
                booking.waitlistOfferedAt?.toISOString() ?? null,
              waitlistOfferExpiresAt:
                booking.waitlistOfferExpiresAt?.toISOString() ?? null,
              waitlistOfferedLodgeId: booking.waitlistOfferedLodgeId,
              waitlistOfferedPriceCents: booking.waitlistOfferedPriceCents,
            },
            // Null when the strand was recorded before #2648 shipped the row,
            // or when the audit entry has since been retention-pruned.
            resolvesAuditLogId: strandedRow?.id ?? null,
            resolvesAuditLogAt: strandedRow?.createdAt.toISOString() ?? null,
          },
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
        },
        tx,
      );

      return {
        success: true as const,
        memberId: key.memberId,
        lodgeId: key.lodgeId,
        email: booking.member.email,
        firstName: booking.member.firstName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        waitlistPosition,
      };
    });

    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    // #2649 owner decision (Recommended): reuse the "waitlist offer expired"
    // email, which already says "you are back on the waitlist at position N" —
    // the true statement here. It routes through `bookingOwnerEmailContext`, so
    // the per-booking "No emails" switch withholds it without this route
    // branching on it.
    sendWaitlistOfferExpiredEmail(
      { bookingId, recipientMemberId: result.memberId },
      result.email,
      result.firstName,
      result.checkIn,
      result.checkOut,
      result.waitlistPosition,
      result.lodgeId,
    ).catch((err) =>
      logger.error(
        { err, bookingId },
        "Failed to tell the member their waitlist place was restored",
      ),
    );

    // The booking left a capacity-holding status, so its beds are free. Offer
    // them the way every other release does (`expireStaleOffers`, every cancel
    // path): after commit, never inside the locks, and never allowed to turn a
    // completed repair into a failure.
    //
    // The lodge is the BOOKING's own, never `waitlistOfferedLodgeId`. This is
    // where `expireStaleOffers` deliberately differs and must: there the entry
    // is still WAITLIST_OFFERED, holding a bed at the OFFERED lodge, so that is
    // what its revert frees. Here the booking is PAYMENT_PENDING — a
    // capacity-holding status at `Booking.lodgeId` — so its allocations, the
    // lodge key held above, and the reconcile that just pruned them are all
    // keyed on `lodgeId`. Sweeping any other lodge would process a queue whose
    // beds this repair did not free and leave the ones it did free unoffered.
    // (`confirmWaitlistOffer` sends every offer carrying
    // `waitlistOfferedLodgeId` down the cross-lodge path, which replaces the
    // entry rather than parking it in PAYMENT_PENDING, so the field is null on
    // every reachable stranded booking today. The rule is written from where
    // the beds are, not from that reachability.)
    processWaitlistForDates({
      checkIn: result.checkIn,
      checkOut: result.checkOut,
      lodgeId: result.lodgeId,
    }).catch((err) =>
      logger.error(
        { err, bookingId },
        "Failed to process the waitlist after returning a stranded confirm",
      ),
    );

    return NextResponse.json({
      success: true,
      status: BookingStatus.WAITLISTED,
      waitlistPosition: result.waitlistPosition,
    });
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to return a stranded zero-dollar waitlist confirm to the waitlist",
    );
    // Contention is not a fault. Nothing was committed either way — the claim,
    // the reconcile and the audit row share one transaction — so the only
    // question is what the operator should do next, and for an exhausted lock
    // wait that is "again shortly", not "escalate". 503 for the same reason
    // `waitlist-confirm/route.ts` uses it on the release this repair finishes.
    if (isReturnToWaitlistTransactionContention(err)) {
      return NextResponse.json(
        { error: RETURN_TO_WAITLIST_CONTENDED_MESSAGE },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Failed to return the booking to the waitlist" },
      { status: 500 },
    );
  }
}
