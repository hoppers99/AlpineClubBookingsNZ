import { createHash, randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import type { AdultMemberHostingPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";
import { formatBookingReference } from "@/lib/booking-reference";
import { adultMemberHostingStateKey } from "@/lib/policies/adult-member-hosting";

/**
 * The durable, officer-facing record of a CONFIRMED booking that has lost its
 * required adult-member coverage (#2576 §7, §8, §16).
 *
 * WHY A TABLE AND NOT THE EXISTING REVIEW COLUMNS. `Booking.adultMemberHostingReview*`
 * answers "what does the rule say about this booking right now", and it is reset
 * whenever the hazard materially changes. An incident answers a different
 * question — "cover was TAKEN AWAY from a booking the club had already accepted,
 * and nobody has dealt with it" — and it has to survive that reset, carry the
 * officer's override reason, and keep a resolution history. It is also the thing
 * that must NOT exist for the ordinary case: under `ADMIN_REVIEW_REQUIRED` an
 * uncovered booking is a normal review, and doubling it into an incident would
 * double the officer's queue.
 *
 * SO: INCIDENTS EXIST ONLY UNDER `ENFORCED`. That is the whole rule, and it falls
 * straight out of the owner's text. §7 and §8 are both about a booking that
 * "becomes uncovered after confirmation" — which can only happen where the club
 * would have refused it. Under review mode the booking was always allowed to
 * exist uncovered and the pending review is already the officer's signal.
 *
 * NO AUTOMATIC CANCELLATION, ANYWHERE IN THIS MODULE. §7 and §16 both say so in
 * as many words: the booking keeps its status, its beds and its payments. Nothing
 * here writes `Booking.status`, and the only booking columns it touches are none
 * at all — the incident is a separate row.
 */

/** The narrow client this service needs; a `Prisma.TransactionClient` satisfies it. */
export type HostingCoverageIncidentDb = Pick<
  PrismaClient,
  "hostingCoverageIncident" | "auditLog"
>;

/** Why the cover went away. Mirrors the Prisma enum without importing it. */
export type HostingCoverageIncidentCause = "OFFICER_OVERRIDE" | "SYSTEM_CHANGE";

/** How an incident stopped being live. Mirrors the Prisma enum. */
export type HostingCoverageIncidentResolution =
  | "COVERAGE_RESTORED"
  | "BOOKING_AMENDED"
  | "EXCEPTION_APPROVED"
  | "BOOKING_CANCELLED";

export interface HostingCoverageOwnerNotificationClaim {
  incidentId: string;
  stateKey: string;
  /** Opaque ownership proof for this one provider delivery attempt. */
  claimToken: string;
}

/** Shared lifetime for claiming and finally validating one provider delivery. */
export const HOSTING_COVERAGE_OWNER_NOTIFICATION_LEASE_MS = 15 * 60 * 1000;

/**
 * The immutable payload handed to the email provider for one current claim.
 *
 * It is assembled from the incident's frozen evidence and the booking relation in
 * the same guarded read that proves the incident/state/token still belong to this
 * worker. In particular, it never reads `Booking.adultMemberHostingReview`: that
 * live review may already describe a later state than the claim being delivered.
 */
export interface HostingCoverageOwnerNotificationDelivery {
  bookingId: string;
  recipientMemberId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  lodgeId: string;
  uncoveredNights: string;
}

/**
 * The stored fingerprint of one uncovered state.
 *
 * A digest of `adultMemberHostingStateKey` rather than the key itself, for one
 * practical reason: the key grows with the number of uncovered guest-nights and a
 * large party can outrun any column width, and a TRUNCATED key is worse than
 * useless — two materially different states would compare equal, so an officer
 * override on Friday would suppress the notification for a different problem on
 * Saturday. A digest is fixed-width and order-sensitive.
 *
 * VERSION-PREFIXED so a future change to what "materially identical" means
 * invalidates old keys deliberately (every incident is then treated as changed
 * once, which notifies once) instead of silently comparing across definitions.
 */
export function hostingCoverageStateKey(
  violation: AdultMemberHostingPolicyExceptionViolation,
): string {
  const digest = createHash("sha256")
    .update(adultMemberHostingStateKey(violation))
    .digest("hex");
  return `v1:${digest}`;
}

export interface OpenHostingCoverageIncidentParams {
  bookingId: string;
  lodgeId: string;
  cause: HostingCoverageIncidentCause;
  violation: AdultMemberHostingPolicyExceptionViolation;
  /**
   * The officer who overrode the refusal, when that member row still exists,
   * and the mandatory reason (§7). Attribution is nullable because queued work
   * survives member deletion; the explanation must survive it too.
   */
  override?: { byMemberId: string | null; reason: string } | null;
}

export type HostingCoverageIncidentOutcome =
  /** Nothing was recorded before; a new incident is open. */
  | { action: "opened"; incidentId: string; stateKey: string }
  /** An active incident already existed and its uncovered state MOVED. */
  | { action: "updated"; incidentId: string; stateKey: string }
  /** An active incident already existed for the identical state; nothing written. */
  | { action: "unchanged"; incidentId: string; stateKey: string };

/**
 * Open an incident, or fold the new facts into the one that is already open
 * (§16: "create or update ONE durable active compliance incident for the
 * materially identical uncovered state").
 *
 * IDEMPOTENT, AND THAT IS THE POINT. The re-evaluation drain is at-least-once by
 * design — an item can be redelivered after a crash, and the general cron sweep
 * re-runs anything left pending — so this is called repeatedly with the same
 * facts. Called twice with the same uncovered state it writes NOTHING the second
 * time and reports `unchanged`, which is what stops the notification in §16 from
 * repeating for "the same unchanged condition".
 *
 * THE RACE IS CLOSED AT THE DATABASE, not here. Two concurrent openers both see
 * no active row and both insert; the partial unique index
 * `HostingCoverageIncident_active_booking_unique` lets exactly one win, and the
 * loser retries as an update. Without the index the officer's queue would show
 * the same booking twice and each row would notify.
 *
 * The evidence JSON is the FULL frozen violation, member ids included: this row is
 * only ever read under admin booking permissions (§11), and the member-facing
 * wording is derived from the nights, never from this JSON.
 */
export async function openOrUpdateHostingCoverageIncident(
  params: OpenHostingCoverageIncidentParams,
  db: HostingCoverageIncidentDb,
): Promise<HostingCoverageIncidentOutcome> {
  const stateKey = hostingCoverageStateKey(params.violation);
  const override = params.override ?? null;
  if (override && !override.reason.trim()) {
    // §7 makes the reason mandatory. A programming error that reached here
    // without one fails loudly rather than recording an unexplained override.
    throw new Error(
      "Recording an overridden hosting-coverage incident requires an explicit reason",
    );
  }

  const existing = await db.hostingCoverageIncident.findFirst({
    where: { bookingId: params.bookingId, resolvedAt: null },
    select: { id: true, stateKey: true },
  });

  if (existing) {
    if (existing.stateKey === stateKey) {
      return { action: "unchanged", incidentId: existing.id, stateKey };
    }
    await db.hostingCoverageIncident.update({
      where: { id: existing.id },
      data: {
        stateKey,
        evidence: params.violation as unknown as Prisma.InputJsonValue,
        cause: params.cause,
        ownerNotificationClaimStateKey: null,
        ownerNotificationClaimedAt: null,
        ownerNotificationClaimToken: null,
        // A later override reason replaces an earlier one only when one was
        // actually supplied; a system-driven update must not erase the officer's
        // recorded reason for the override that opened this incident.
        ...(override
          ? {
              overriddenByMemberId: override.byMemberId,
              overrideReason: override.reason.trim().slice(0, 500),
            }
          : {}),
      },
    });
    await recordIncidentAudit(
      "booking.hostingCoverage.incidentUpdated",
      params,
      existing.id,
      db,
    );
    return { action: "updated", incidentId: existing.id, stateKey };
  }

  try {
    const created = await db.hostingCoverageIncident.create({
      data: {
        bookingId: params.bookingId,
        lodgeId: params.lodgeId,
        cause: params.cause,
        stateKey,
        evidence: params.violation as unknown as Prisma.InputJsonValue,
        ownerNotificationClaimStateKey: null,
        ownerNotificationClaimedAt: null,
        ownerNotificationClaimToken: null,
        overriddenByMemberId: override?.byMemberId ?? null,
        overrideReason: override ? override.reason.trim().slice(0, 500) : null,
      },
      select: { id: true },
    });
    await recordIncidentAudit(
      "booking.hostingCoverage.incidentOpened",
      params,
      created.id,
      db,
    );
    return { action: "opened", incidentId: created.id, stateKey };
  } catch (err) {
    if (!isActiveIncidentConflict(err)) throw err;
    // A concurrent opener won the partial unique index. Re-read and fold in,
    // rather than surfacing a unique violation to a caller whose only mistake
    // was to arrive second.
    const winner = await db.hostingCoverageIncident.findFirst({
      where: { bookingId: params.bookingId, resolvedAt: null },
      select: { id: true, stateKey: true },
    });
    if (!winner) throw err;
    if (winner.stateKey === stateKey) {
      return { action: "unchanged", incidentId: winner.id, stateKey };
    }
    await db.hostingCoverageIncident.update({
      where: { id: winner.id },
      data: {
        stateKey,
        evidence: params.violation as unknown as Prisma.InputJsonValue,
        ownerNotificationClaimStateKey: null,
        ownerNotificationClaimedAt: null,
        ownerNotificationClaimToken: null,
      },
    });
    return { action: "updated", incidentId: winner.id, stateKey };
  }
}

/** Prisma's unique-constraint failure on the one-active-incident index. */
function isActiveIncidentConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/**
 * Close every active incident on a booking (§7's automatic resolution, §16's
 * "resolve the incident automatically when the condition is corrected").
 *
 * The four resolutions are the four things the owner listed: qualifying coverage
 * was restored, the booking was amended, a valid policy exception was approved,
 * or the affected booking was cancelled. Which one it is is a fact the CALLER
 * knows and this function is told — inferring it from the absence of a hazard
 * would report `COVERAGE_RESTORED` for a booking somebody cancelled.
 *
 * IDEMPOTENT: a guarded `updateMany` on `resolvedAt: null`, so a second call
 * moves nothing and reports 0. Returns the number of incidents closed so a caller
 * can log the truth rather than an assumption.
 */
export async function resolveHostingCoverageIncidents(
  params: {
    bookingId: string;
    resolution: HostingCoverageIncidentResolution;
    actorMemberId?: string | null;
  },
  db: HostingCoverageIncidentDb,
): Promise<number> {
  const closed = await db.hostingCoverageIncident.updateMany({
    where: { bookingId: params.bookingId, resolvedAt: null },
    data: { resolvedAt: new Date(), resolution: params.resolution },
  });
  if (closed.count === 0) return 0;
  await createAuditLog(
    {
      action: "booking.hostingCoverage.incidentResolved",
      entityType: "Booking",
      entityId: params.bookingId,
      actorMemberId: params.actorMemberId ?? null,
      category: "booking",
      severity: "info",
      outcome: "success",
      summary:
        `Hosting-coverage incident resolved (${params.resolution}) for booking ` +
        formatBookingReference(params.bookingId),
      metadata: { resolution: params.resolution, closed: closed.count },
    },
    db,
  );
  return closed.count;
}

/**
 * Lease delivery for one incident's CURRENT state, but only if the owner has not
 * already been told about that exact state (§16: "notifications
 * must be based on actual state transitions; repeated reconciliation of the same
 * unchanged problem must not send repeated messages").
 *
 * A GUARDED LEASE, not a read-then-write. The `updateMany` matches a fresh NULL
 * success stamp OR a non-NULL stamp for a different state. The explicit NULL arm is
 * load-bearing: SQL `NOT (NULL = value)` is UNKNOWN, not TRUE, so a bare NOT
 * predicate would prevent every newly opened incident from sending its first
 * notification. Two concurrent drains racing on the same incident still produce
 * exactly one active sender. `count === 1` means "you own the delivery"; 0 means
 * somebody else is sending, already completed it, or the incident was resolved
 * underneath.
 *
 * The durable success stamp is written only AFTER transport success. A failed
 * sender releases the lease, and a crashed sender's lease expires, so unchanged
 * reconciliation retries instead of permanently suppressing delivery. This is
 * deliberately at-least-once: if the provider accepts the message and the process
 * dies before the success stamp commits, a later retry can send a duplicate. The
 * provider offers no idempotency key, and stamping before transport would turn the
 * same crash into a permanently lost notice.
 */
export async function claimHostingCoverageOwnerNotification(
  params: { incidentId: string; stateKey: string },
  db: Pick<PrismaClient, "hostingCoverageIncident">,
): Promise<HostingCoverageOwnerNotificationClaim | null> {
  const claimedAt = new Date();
  const staleBefore = new Date(
    claimedAt.getTime() - HOSTING_COVERAGE_OWNER_NOTIFICATION_LEASE_MS,
  );
  const claimToken = randomUUID();
  const claim = await db.hostingCoverageIncident.updateMany({
    where: {
      id: params.incidentId,
      resolvedAt: null,
      stateKey: params.stateKey,
      OR: [
        { notifiedStateKey: null },
        { notifiedStateKey: { not: params.stateKey } },
      ],
      AND: [
        {
          OR: [
            { ownerNotificationClaimStateKey: null },
            { ownerNotificationClaimStateKey: { not: params.stateKey } },
            { ownerNotificationClaimedAt: { lt: staleBefore } },
          ],
        },
      ],
    },
    data: {
      ownerNotificationClaimStateKey: params.stateKey,
      ownerNotificationClaimedAt: claimedAt,
      ownerNotificationClaimToken: claimToken,
    },
  });
  return claim.count === 1 ? { ...params, claimToken } : null;
}

/**
 * Renew this exact delivery claim just in time, then freeze provider input only
 * while the renewed claim is still current.
 *
 * Renewal is a guarded `updateMany`, not an expiry read followed by a write. A
 * worker holding an expired-but-unreclaimed token can therefore extend its lease
 * and send; if a successor races that renewal, both contend on the incident row and
 * only the exact token that wins remains current. A resolved incident, moved state,
 * replaced token, or claim already completed by somebody else returns null, so the
 * stale worker performs no provider call. The final exact read freezes the incident
 * evidence and recipient after renewal; re-reading the booking's live review here
 * could pair this claim with a different state written after reconciliation.
 *
 * The provider call deliberately remains outside a transaction. Consequently a
 * state can still change after this final token read and before transport begins;
 * closing that last interval would require holding a database transaction across
 * email delivery, which is forbidden by the provider-call boundary.
 */
export async function loadHostingCoverageOwnerNotificationDelivery(
  params: HostingCoverageOwnerNotificationClaim & { bookingId: string },
  db: Pick<PrismaClient, "hostingCoverageIncident">,
  now: Date = new Date(),
): Promise<HostingCoverageOwnerNotificationDelivery | null> {
  const renewed = await db.hostingCoverageIncident.updateMany({
    where: {
      id: params.incidentId,
      bookingId: params.bookingId,
      resolvedAt: null,
      stateKey: params.stateKey,
      ownerNotificationClaimStateKey: params.stateKey,
      ownerNotificationClaimToken: params.claimToken,
      OR: [
        { notifiedStateKey: null },
        { notifiedStateKey: { not: params.stateKey } },
      ],
    },
    data: { ownerNotificationClaimedAt: now },
  });
  if (renewed.count !== 1) return null;

  const incident = await db.hostingCoverageIncident.findFirst({
    where: {
      id: params.incidentId,
      bookingId: params.bookingId,
      resolvedAt: null,
      stateKey: params.stateKey,
      ownerNotificationClaimStateKey: params.stateKey,
      ownerNotificationClaimToken: params.claimToken,
      ownerNotificationClaimedAt: now,
      OR: [
        { notifiedStateKey: null },
        { notifiedStateKey: { not: params.stateKey } },
      ],
    },
    select: {
      evidence: true,
      booking: {
        select: {
          id: true,
          memberId: true,
          lodgeId: true,
          checkIn: true,
          checkOut: true,
          member: { select: { firstName: true, email: true } },
        },
      },
    },
  });
  if (!incident) return null;

  const evidence = incident.evidence as { affectedNights?: unknown } | null;
  const nights = Array.isArray(evidence?.affectedNights)
    ? evidence.affectedNights.filter(
        (night): night is string => typeof night === "string",
      )
    : [];

  return {
    bookingId: incident.booking.id,
    recipientMemberId: incident.booking.memberId,
    email: incident.booking.member.email,
    firstName: incident.booking.member.firstName,
    checkIn: incident.booking.checkIn,
    checkOut: incident.booking.checkOut,
    lodgeId: incident.booking.lodgeId,
    uncoveredNights: nights.length > 0 ? nights.join(", ") : "see your booking",
  };
}

/** Stamp a notification only after the transport reports a successful send. */
export async function completeHostingCoverageOwnerNotification(
  params: HostingCoverageOwnerNotificationClaim,
  db: Pick<PrismaClient, "hostingCoverageIncident">,
): Promise<boolean> {
  const completed = await db.hostingCoverageIncident.updateMany({
    where: {
      id: params.incidentId,
      resolvedAt: null,
      stateKey: params.stateKey,
      ownerNotificationClaimStateKey: params.stateKey,
      ownerNotificationClaimToken: params.claimToken,
    },
    data: {
      notifiedStateKey: params.stateKey,
      ownerNotifiedAt: new Date(),
      ownerNotificationClaimStateKey: null,
      ownerNotificationClaimedAt: null,
      ownerNotificationClaimToken: null,
    },
  });
  return completed.count === 1;
}

/** Release a failed/non-send claim so the next queue attempt can retry it. */
export async function releaseHostingCoverageOwnerNotification(
  params: HostingCoverageOwnerNotificationClaim,
  db: Pick<PrismaClient, "hostingCoverageIncident">,
): Promise<boolean> {
  const released = await db.hostingCoverageIncident.updateMany({
    where: {
      id: params.incidentId,
      ownerNotificationClaimStateKey: params.stateKey,
      ownerNotificationClaimToken: params.claimToken,
    },
    data: {
      ownerNotificationClaimStateKey: null,
      ownerNotificationClaimedAt: null,
      ownerNotificationClaimToken: null,
    },
  });
  return released.count === 1;
}

async function recordIncidentAudit(
  action: string,
  params: OpenHostingCoverageIncidentParams,
  incidentId: string,
  db: HostingCoverageIncidentDb,
): Promise<void> {
  await createAuditLog(
    {
      action,
      entityType: "Booking",
      entityId: params.bookingId,
      actorMemberId: params.override?.byMemberId ?? null,
      category: "booking",
      // `important` rather than `info`: an enforcing club has a confirmed booking on
      // its books that its own rule would refuse. That is the definition of
      // something an officer has to look at.
      severity: "important",
      outcome: "success",
      summary:
        `Booking ${formatBookingReference(params.bookingId)} has ` +
        `${params.violation.requirements.uncoveredNonMemberGuestNights} ` +
        `uncovered non-member guest-night(s) after a ${params.cause} change`,
      details: params.override?.reason ?? null,
      metadata: {
        incidentId,
        cause: params.cause,
        lodgeId: params.lodgeId,
        affectedNights: params.violation.affectedNights,
        policyId: params.violation.policyId,
        policyVersion: params.violation.policyVersion,
      },
    },
    db,
  );
}
