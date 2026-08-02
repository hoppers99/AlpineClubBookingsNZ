import type { AgeTier, BookingStatus } from "@prisma/client";

import { parseDateOnly, normalizeDateOnlyForTimeZone } from "@/lib/date-only";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { recordAdultMemberHostingReviewDecision } from "@/lib/adult-member-hosting-review";
import { createConfirmedBooking } from "@/lib/booking-create";
import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import { BOOKABLE_AGE_TIER_VALUES } from "@/lib/age-tier-schema";
import { getNonMemberHoldPolicy } from "@/lib/cancellation";
import { calculateBookingHoldDecision } from "@/lib/policies/booking-route-decisions";
import {
  DEFAULT_BOOKING_PAYMENT_METHOD,
  type BookingPaymentMethod,
} from "@/lib/booking-payment-methods";
import type { GuestStayRange } from "@/lib/booking-guest-stay-ranges";
import type { PrismaTransactionClient } from "@/lib/db-transaction";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify-validation";
import {
  CAPACITY_CONFLICT_MESSAGE,
  type ConfirmedOverride,
  type LoadedPolicyExceptionRequest,
  type PolicyExceptionApprovalHooks,
} from "@/lib/booking-exception-execution";
import {
  computeProposalHash,
  type ExceptionProposalSnapshot,
  type ModificationProposalSnapshot,
  type NewBookingProposalSnapshot,
  type ProposalGuest,
  type ProposalParty,
} from "@/lib/booking-exception-requests";
import {
  buildModificationProposalParties,
  evaluateProposalPartyViolations,
  parseStoredExceptionDelta,
  type LiveBookingGuestInput,
  type ModificationDeltaInput,
} from "@/lib/booking-exception-request-service";
import type { PolicyExceptionViolation } from "@/lib/booking-policy-exceptions";

/**
 * #2526 — the REAL {@link PolicyExceptionApprovalHooks} the admin approval route
 * hands to #2525's atomic approve-and-execute engine.
 *
 * #2525 owns the concurrency mechanics (lock order, fresh-role reauthorization,
 * guarded version CAS, drift gate, capacity recheck, atomic reservation release,
 * post-commit hand-off) behind an injected seam. This module is the other side
 * of that seam: the hooks, wired to the real permission model, the real policy
 * evaluators, the real capacity engine and the real canonical booking services.
 *
 * Everything here runs INSIDE the approval transaction, on the `tx` the engine
 * supplies, under the global lock(1) + per-lodge capacity lock the engine has
 * already taken — so nothing in this file may reach for the module Prisma client
 * (a second pool connection beneath those locks is the shape
 * docs/CONCURRENCY_AND_LOCKING.md forbids). The one read that genuinely needs
 * the module client, the club's hold policy, is resolved BEFORE the transaction
 * by {@link resolveNewBookingExecutionParams} and handed in.
 *
 * The three contracts #2525's reviews pinned, and where they live here:
 *
 *  1. `recheckCapacity` checks the FULL proposed party and EXCLUDES the live
 *     booking for a modification, mirroring the admission check the request
 *     service ran when the hold was taken. It never checks "the delta on top of
 *     the live base": that would double-count the live booking and
 *     false-keep-pending an approval that should execute.
 *  2. `executeApprovedProposal` is a HARD capacity refusal. It never passes
 *     `confirmOverCapacity`, never sets `adminOverride`, and turns
 *     `createConfirmedBooking`'s non-throwing `capacityExceeded` outcome into a
 *     THROW so the whole approval transaction rolls back instead of committing a
 *     claim with no booking behind it.
 *  3. `verifyLiveProposalIntegrity` is ALWAYS supplied (the engine fails closed
 *     for a modification without it) and is the gate proving the live booking
 *     still matches the reviewed base AND that the stored delta still reproduces
 *     the reviewed proposal.
 */

// ---------------------------------------------------------------------------
// Errors the route maps to HTTP
// ---------------------------------------------------------------------------

/**
 * The canonical create service reported `capacityExceeded` while executing an
 * approved NEW-booking proposal. Thrown (not returned) so Prisma rolls the whole
 * approval back: the request stays REQUESTED at its original version and the
 * officer is told the lodge is full — the same outcome, and the same honesty, as
 * #2525's in-engine kept-pending path.
 *
 * This can never be a FALSE keep-pending: when it throws, nothing has become
 * authoritative. The status claim, the reservation release and every row the
 * canonical service wrote are all inside the transaction being rolled back.
 */
export class PolicyExceptionExecutionCapacityError extends Error {
  constructor(readonly fullNights: string[]) {
    super(CAPACITY_CONFLICT_MESSAGE);
    this.name = "PolicyExceptionExecutionCapacityError";
  }
}

/**
 * The approval reached execution without a verified replayable delta, or without
 * the pre-resolved new-booking execution parameters. Only reachable through a
 * wiring bug — the engine always runs `verifyLiveProposalIntegrity` before
 * `executeApprovedProposal` for a modification — so it fails LOUDLY rather than
 * executing something unverified.
 */
export class PolicyExceptionUnverifiedExecutionError extends Error {
  constructor(detail: string) {
    super(`A policy-exception approval reached execution unverified: ${detail}`);
    this.name = "PolicyExceptionUnverifiedExecutionError";
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const BOOKABLE_AGE_TIERS = new Set<string>(BOOKABLE_AGE_TIER_VALUES);

/** The proposed party as capacity-engine guest ranges (explicit night sets). */
function proposedGuestRanges(party: ProposalParty): GuestStayRange[] {
  return party.guests.map((guest) => ({ nights: [...guest.nights] }));
}

/**
 * The stay envelope of a frozen party, as real dates. The envelope is stored ON
 * the party (the min/max of its guest nights at freeze time), so this reads it
 * rather than re-deriving it — a re-derivation could disagree with what was
 * reviewed.
 */
function partyEnvelope(party: ProposalParty): { checkIn: Date; checkOut: Date } {
  return {
    checkIn: parseDateOnly(party.checkIn),
    checkOut: parseDateOnly(party.checkOut),
  };
}

/** Did the approval review — and does it still uphold — the hosting rule? */
function overridesAdultMemberHosting(override: ConfirmedOverride): boolean {
  return override.overridable.some(
    (entry) => entry.reasonCode === "ADULT_MEMBER_HOSTING_REQUIRED",
  );
}

/**
 * The audit-grade sentence recorded wherever this approval overrode a rule. It
 * names the request and every reason code that was still tripping, so "who let
 * this through, and why" is answerable from the booking alone.
 */
export function buildOverrideReason(args: {
  requestId: string;
  override: ConfirmedOverride;
  adminNotes?: string | null;
}): string {
  const codes = args.override.overridable
    .map((entry) => entry.reasonCode)
    .join(", ");
  const note = args.adminNotes?.trim();
  const base = `Booking-policy exception approved (request ${args.requestId}): ${
    codes || "no rule still tripping"
  }`;
  return note ? `${base}. ${note}` : base;
}

// ---------------------------------------------------------------------------
// Fresh-DB reauthorization
// ---------------------------------------------------------------------------

type ReauthorizationDb = Pick<PrismaTransactionClient, "member">;

/**
 * Re-read the officer's CURRENT roles from the database and decide whether they
 * may approve a booking-policy exception.
 *
 * NEVER the session snapshot: a session token can be minutes old, and an officer
 * whose access was revoked between opening the queue and clicking Approve must
 * not execute a booking. The requirement is `bookings: edit` — the same gate the
 * rest of the booking-decision surface uses — plus an active, login-capable
 * account that is not mid password-reset remediation.
 */
export async function reauthorizeBookingOfficerFromDb(
  db: ReauthorizationDb,
  actorMemberId: string,
): Promise<boolean> {
  const member = await db.member.findUnique({
    where: { id: actorMemberId },
    select: {
      active: true,
      canLogin: true,
      forcePasswordChange: true,
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
    },
  });
  if (!member?.active) return false;
  if (member.forcePasswordChange) return false;
  return hasAdminAreaAccess(
    { canLogin: member.canLogin, accessRoles: member.accessRoles },
    { area: "bookings", level: "edit" },
  );
}

// ---------------------------------------------------------------------------
// Live-booking integrity
// ---------------------------------------------------------------------------

/**
 * Load the live booking's guests in exactly the shape the request route froze
 * them in, so a replayed base is comparable byte-for-byte with the frozen one.
 */
async function loadLiveBookingForIntegrity(
  tx: PrismaTransactionClient,
  bookingId: string,
): Promise<{
  checkIn: Date;
  checkOut: Date;
  liveGuests: LiveBookingGuestInput[];
} | null> {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: {
      checkIn: true,
      checkOut: true,
      guests: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          isMember: true,
          memberId: true,
          stayStart: true,
          stayEnd: true,
        },
      },
    },
  });
  if (!booking) return null;
  return {
    checkIn: normalizeDateOnlyForTimeZone(booking.checkIn),
    checkOut: normalizeDateOnlyForTimeZone(booking.checkOut),
    liveGuests: booking.guests.map((guest) => ({
      id: guest.id,
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      memberId: guest.memberId,
      stayStart: normalizeDateOnlyForTimeZone(guest.stayStart),
      stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd),
    })),
  };
}

/**
 * Turn one frozen proposal guest into a canonical-create guest input.
 *
 * The frozen night list is authoritative and is passed through explicitly
 * (#713), so a non-contiguous stay survives the round-trip; `stayStart`/`stayEnd`
 * are its min/max envelope, exactly as the create service expects. An age tier
 * that is not bookable is refused rather than coerced — a stored snapshot is
 * data, and data that cannot be executed must fail closed.
 */
export function proposalGuestToCreateInput(guest: ProposalGuest) {
  if (!BOOKABLE_AGE_TIERS.has(guest.ageTier)) {
    throw new Error(
      `Frozen proposal guest has a non-bookable age tier: ${guest.ageTier}`,
    );
  }
  const nights = [...new Set(guest.nights)].sort();
  if (nights.length === 0) {
    throw new Error("Frozen proposal guest occupies no nights");
  }
  const stayStart = parseDateOnly(nights[0]);
  const stayEnd = parseDateOnly(nights[nights.length - 1]);
  stayEnd.setUTCDate(stayEnd.getUTCDate() + 1);
  return {
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier as AgeTier,
    isMember: guest.isMember,
    ...(guest.memberId ? { memberId: guest.memberId } : {}),
    stayStart,
    stayEnd,
    nights: nights.map((night) => ({ stayDate: night })),
  };
}

// ---------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------

export interface PolicyExceptionApprovalContext {
  /** The request being decided — the hooks read their own row from it. */
  requestId: string;
  /** The officer approving; re-read from the DB inside the transaction. */
  actorMemberId: string;
  /** Recorded on the canonical services' audit rows. */
  ipAddress: string;
  /** The officer's decision note, if they left one. */
  adminNotes?: string | null;
  /**
   * How a refund arising from the executed modification is settled (card refund
   * or account credit). Not part of the reviewed proposal — the proposal decides
   * WHAT changes, this decides how the resulting money moves — and required only
   * when the canonical service says the change needs one.
   */
  settlementMethod?: BookingModificationSettlementMethod;
  /**
   * NEW-booking execution parameters resolved BEFORE the transaction opened by
   * {@link resolveNewBookingExecutionParams}. Required for a new-booking
   * approval; ignored for a modification.
   */
  newBookingExecution?: {
    status: BookingStatus;
    shouldBePending: boolean;
    holdDays: number;
    paymentMethod: BookingPaymentMethod;
  };
}

/** What the approval actually did, for the route's audit record. */
export interface PolicyExceptionApprovalOutcome {
  createdBookingId: string | null;
  hostingDecisionRecorded: boolean;
}

export interface PolicyExceptionApprovalHookSet {
  hooks: PolicyExceptionApprovalHooks;
  outcome: PolicyExceptionApprovalOutcome;
}

/**
 * Build the real hooks for ONE approval attempt.
 *
 * The returned set is SINGLE-SHOT: `verifyLiveProposalIntegrity` caches the delta
 * it verified so `executeApprovedProposal` replays exactly that one, and the
 * executor refuses to run when the cache is empty. Build a fresh set per attempt.
 */
export function buildPolicyExceptionApprovalHooks(
  context: PolicyExceptionApprovalContext,
): PolicyExceptionApprovalHookSet {
  let verifiedDelta: ModificationDeltaInput | null = null;
  const outcome: PolicyExceptionApprovalOutcome = {
    createdBookingId: null,
    hostingDecisionRecorded: false,
  };

  const hooks: PolicyExceptionApprovalHooks = {
    async reauthorizeBookingOfficer(tx, actorMemberId) {
      return reauthorizeBookingOfficerFromDb(tx, actorMemberId);
    },

    async evaluateCurrentViolations(
      snapshot: ExceptionProposalSnapshot,
      tx: PrismaTransactionClient,
    ): Promise<PolicyExceptionViolation[]> {
      // The SAME evaluator the request froze its evidence with, run on `tx`
      // against today's policy configuration. Any difference is a genuine
      // policy-config change, which #2525's drift gate classifies.
      return evaluateProposalPartyViolations(tx, snapshot.lodgeId, snapshot.proposed);
    },

    async recheckCapacity(snapshot, tx) {
      // THE CONTRACT (#2525 handoff item 1): check the FULL proposed party and,
      // for a modification, EXCLUDE the live booking. Excluding it makes the
      // full-party check exactly an incremental-headroom check against a
      // capacity-holding base, and the correct full-footprint check against a
      // non-holding one (its id simply is not in the occupancy population). The
      // alternative — counting the live base and checking only the delta —
      // double-counts and false-keeps-pending approvals that should execute.
      //
      // The request's OWN provisional reservation is not excluded and does not
      // need to be: #2525 calls this AFTER releasing it (HOLD) or when there
      // never was one (NO_HOLD).
      const { checkIn, checkOut } = partyEnvelope(snapshot.proposed);
      const capacity = await checkCapacityForGuestRanges(
        snapshot.lodgeId,
        checkIn,
        checkOut,
        proposedGuestRanges(snapshot.proposed),
        snapshot.kind === "MODIFICATION" ? snapshot.bookingId : undefined,
        tx,
      );
      return capacity.available
        ? { ok: true }
        : { ok: false, message: CAPACITY_CONFLICT_MESSAGE };
    },

    async verifyLiveProposalIntegrity(snapshot, tx) {
      // A new-booking proposal has no live base to drift against; the engine's
      // tamper hash over the frozen snapshot is the whole integrity story.
      if (snapshot.kind !== "MODIFICATION") return true;

      const row = await tx.bookingChangeRequest.findUnique({
        where: { id: context.requestId },
        select: { requestedChanges: true },
      });
      const delta = parseStoredExceptionDelta(row?.requestedChanges);
      // A request stored before the delta existed, or one whose delta was
      // hand-edited into nonsense, cannot be executed against the canonical
      // service. Fail closed: the member resubmits and gets a fresh, replayable
      // proposal.
      if (!delta) return false;

      const live = await loadLiveBookingForIntegrity(tx, snapshot.bookingId);
      if (!live) return false;

      // Replay the stored delta against the LIVE booking and require the result
      // to hash to the frozen proposal. This one equality proves both halves at
      // once: the live base still matches what was reviewed, AND the delta still
      // produces the proposal that was reviewed. Either kind of drift changes the
      // hash and refuses the approval.
      const replayed = buildModificationProposalParties({
        bookingCheckIn: live.checkIn,
        bookingCheckOut: live.checkOut,
        liveGuests: live.liveGuests,
        delta,
      });
      const replayedSnapshot: ModificationProposalSnapshot = {
        kind: "MODIFICATION",
        lodgeId: snapshot.lodgeId,
        bookingId: snapshot.bookingId,
        base: replayed.base,
        proposed: replayed.proposed,
      };
      if (computeProposalHash(replayedSnapshot) !== computeProposalHash(snapshot)) {
        return false;
      }
      verifiedDelta = delta;
      return true;
    },

    async executeApprovedProposal({ tx, request, snapshot, override }) {
      const overrideReason = buildOverrideReason({
        requestId: request.id,
        override,
        adminNotes: context.adminNotes,
      });

      if (snapshot.kind === "MODIFICATION") {
        return executeApprovedModification({
          tx,
          request,
          snapshot,
          override,
          overrideReason,
          context,
          delta: verifiedDelta,
          outcome,
        });
      }
      return executeApprovedNewBooking({
        tx,
        request,
        snapshot,
        override,
        overrideReason,
        context,
        outcome,
      });
    },
  };

  return { hooks, outcome };
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

async function executeApprovedModification(args: {
  tx: PrismaTransactionClient;
  request: LoadedPolicyExceptionRequest;
  snapshot: ModificationProposalSnapshot;
  override: ConfirmedOverride;
  overrideReason: string;
  context: PolicyExceptionApprovalContext;
  delta: ModificationDeltaInput | null;
  outcome: PolicyExceptionApprovalOutcome;
}): Promise<{ deferredPostCommit: () => Promise<void> }> {
  const { tx, request, snapshot, override, overrideReason, context, delta, outcome } =
    args;
  if (!delta) {
    throw new PolicyExceptionUnverifiedExecutionError("no verified delta");
  }

  // The canonical modification service, ON THIS TRANSACTION.
  //
  // Actor role ADMIN is what applies the reviewed MINIMUM_STAY override: the
  // service enforces minimum stay only for non-admin actors. That blanket skip is
  // safe HERE and only here, because #2525's drift gate has already proved the
  // frozen proposal trips EXACTLY the reviewed violations — a rule that newly
  // trips is `newViolations` and never reaches execution.
  //
  // Deliberately NOT passed: `confirmOverCapacity` (capacity stays a HARD refusal
  // — an approving officer is not a capacity-override actor) and `adminOverride`
  // (this is not a date-override edit; it is the member's reviewed proposal).
  const result = await modifyBookingBatch({
    bookingId: snapshot.bookingId,
    actor: { id: context.actorMemberId, role: "ADMIN" },
    input: {
      checkIn: delta.checkIn ?? undefined,
      checkOut: delta.checkOut ?? undefined,
      addGuests: delta.addGuests?.map((guest) => ({
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier as AgeTier,
        isMember: guest.isMember,
        ...(guest.memberId ? { memberId: guest.memberId } : {}),
        stayStart: guest.stayStart ?? null,
        stayEnd: guest.stayEnd ?? null,
      })),
      removeGuestIds: delta.removeGuestIds,
      guestStayRanges: delta.guestStayRanges,
      ...(context.settlementMethod
        ? { settlementMethod: context.settlementMethod }
        : {}),
      // The member learns their request was approved from the canonical change
      // email the service already sends — no second, competing notice.
      notifyMember: true,
    },
    ipAddress: context.ipAddress,
    tx,
  });

  // The service reconciles the hosting hazard from the rows it just wrote and
  // deliberately opens it PENDING (an unrelated edit must never auto-approve an
  // exception). When the approval DID review that rule and it still trips, the
  // officer's decision is written now, in the same transaction — otherwise the
  // booking would carry a pending hosting review nobody will action even though
  // an officer has already decided it, with a reason, on this exact proposal.
  // A reviewed rule that has since CLEARED is deliberately not decided here:
  // there is nothing left to decide, and #2525 records the resolution instead.
  if (overridesAdultMemberHosting(override)) {
    outcome.hostingDecisionRecorded = await recordAdultMemberHostingReviewDecision(
      snapshot.bookingId,
      tx,
      { reason: overrideReason, byMemberId: context.actorMemberId },
    );
  }

  // Persist the officer's note on the decided request, in the same transaction.
  const notes = context.adminNotes?.trim();
  if (notes) {
    await tx.bookingChangeRequest.updateMany({
      where: { id: request.id },
      data: { adminNotes: notes.slice(0, 2000) },
    });
  }

  return { deferredPostCommit: result.deferredPostCommit ?? (async () => {}) };
}

async function executeApprovedNewBooking(args: {
  tx: PrismaTransactionClient;
  request: LoadedPolicyExceptionRequest;
  snapshot: NewBookingProposalSnapshot;
  override: ConfirmedOverride;
  overrideReason: string;
  context: PolicyExceptionApprovalContext;
  outcome: PolicyExceptionApprovalOutcome;
}): Promise<{ deferredPostCommit: () => Promise<void> }> {
  const { tx, request, snapshot, override, overrideReason, context, outcome } = args;
  const execution = context.newBookingExecution;
  if (!execution) {
    throw new PolicyExceptionUnverifiedExecutionError(
      "no resolved new-booking execution parameters",
    );
  }

  const { checkIn, checkOut } = partyEnvelope(snapshot.proposed);
  const guests = snapshot.proposed.guests.map(proposalGuestToCreateInput);

  const created = await createConfirmedBooking({
    effectiveMemberId: request.requestedByMemberId,
    // An officer executing a member's reviewed proposal IS an on-behalf create.
    isOnBehalf: true,
    sessionUserId: context.actorMemberId,
    checkIn,
    checkOut,
    guests,
    status: execution.status,
    shouldBePending: execution.shouldBePending,
    holdDays: execution.holdDays,
    paymentMethod: execution.paymentMethod,
    // D-R4: a hosting exception is accepted only with a reason attributable to
    // the officer, and only when the approval actually reviewed that rule. A
    // reviewed rule that has since cleared passes nothing, so the create opens no
    // review at all — the correct record of "there was no hazard".
    adultMemberHostingReason: overridesAdultMemberHosting(override)
      ? overrideReason
      : undefined,
    lodgeId: snapshot.lodgeId,
    // HARD capacity refusal: never `confirmOverCapacity`, never `waitlistIntent`.
    notifyMember: true,
    tx,
  });

  if (created.type === "capacityExceeded") {
    // THROW, never return: the engine's contract is that a failed execution
    // aborts the transaction, so the claim and the reservation release roll back
    // with it and the request is left exactly as it was — REQUESTED, at its
    // original version. Returning here would commit an APPROVED request with no
    // booking behind it.
    throw new PolicyExceptionExecutionCapacityError(created.fullNights);
  }

  outcome.createdBookingId = created.booking.id;

  // Record the executed booking on the request row, in the same transaction, so
  // the officer queue links straight to what the approval produced.
  await tx.newBookingPolicyExceptionRequest.updateMany({
    where: { id: request.id },
    data: {
      createdBookingId: created.booking.id,
      ...(context.adminNotes?.trim()
        ? { adminNotes: context.adminNotes.trim().slice(0, 2000) }
        : {}),
    },
  });

  return { deferredPostCommit: created.deferredPostCommit ?? (async () => {}) };
}

// ---------------------------------------------------------------------------
// Pre-transaction execution parameters
// ---------------------------------------------------------------------------

/**
 * Resolve the NEW-booking execution parameters (hold decision + payment method)
 * BEFORE the approval transaction opens.
 *
 * The hold-policy read walks booking periods on the module client, which is
 * exactly why it cannot live inside a hook. The values it produces are the ones
 * the member booking route would produce for this party today: a party with
 * non-members outside the hold window is created PENDING with the club's hold
 * days, everything else goes straight to PAYMENT_PENDING, and the payment method
 * is the club's default — the member pays through the normal link, because an
 * approval never picks a payment method on somebody's behalf.
 */
export async function resolveNewBookingExecutionParams(
  snapshot: NewBookingProposalSnapshot,
): Promise<NonNullable<PolicyExceptionApprovalContext["newBookingExecution"]>> {
  const checkIn = parseDateOnly(snapshot.proposed.checkIn);
  const hasNonMembers = snapshot.proposed.guests.some((guest) => !guest.isMember);
  const holdPolicy = hasNonMembers
    ? await getNonMemberHoldPolicy(checkIn, snapshot.lodgeId)
    : { enabled: false, holdDays: 0, source: "default" as const };
  const decision = calculateBookingHoldDecision({
    hasNonMembers,
    checkIn,
    holdDays: holdPolicy.holdDays,
    holdEnabled: holdPolicy.enabled,
  });
  return {
    status: decision.status,
    shouldBePending: decision.shouldBePending,
    holdDays: holdPolicy.holdDays,
    paymentMethod: DEFAULT_BOOKING_PAYMENT_METHOD,
  };
}
