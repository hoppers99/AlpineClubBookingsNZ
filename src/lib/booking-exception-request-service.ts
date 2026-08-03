import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { parseDateOnly, formatDateOnly } from "@/lib/date-only";
import { getStayNights } from "@/lib/policies/pricing";
import { validateMinimumStay } from "@/lib/booking-policies";
import { evaluateProposedAdultMemberHosting } from "@/lib/adult-member-hosting-review";
import { evaluateProposedPaidUpAdultPresence } from "@/lib/subscription-lockout-enforcement";
import { computeMemberGuestBoundary } from "@/lib/booking-guests";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  releasePolicyExceptionReservation,
  reservePolicyExceptionCapacity,
} from "@/lib/booking-exception-reservations";
import type { GuestStayRange } from "@/lib/booking-guest-stay-ranges";
import type { PrismaTransactionClient } from "@/lib/db-transaction";
import {
  type PolicyExceptionCapacityMode,
  type PolicyExceptionReasonCode,
  type PolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";
import {
  canonicalizeProposalParty,
  canonicalizeProposalSnapshot,
  computeProposalHash,
  computeProposalReservation,
  freezePolicyExceptionEvidence,
  modificationExceptionOpenStateKey,
  newBookingExceptionOpenStateKey,
  normalizeMemberMessage,
  type ModificationProposalSnapshot,
  type NewBookingProposalSnapshot,
  type NightReservation,
  type ProposalGuest,
  type ProposalParty,
} from "@/lib/booking-exception-requests";

/**
 * The canonical global booking/money lock(1). A HELD modification request now
 * holds a PROVISIONAL capacity reservation (#2525), so creating one (which
 * reserves), superseding one (which releases the prior hold and reserves the
 * new) and cancelling one (which releases) are all capacity changes. They
 * compose the EXISTING keys in the house order — global lock(1) FIRST, then the
 * per-lodge capacity lock keyed on the frozen lodge — exactly as
 * `resolvePolicyExceptionRequestTerminal` and the approve-and-execute engine do
 * (`booking-exception-execution.ts`), so the reservation write/delete serialises
 * against every occupancy read and claim at that lodge and cannot deadlock with
 * the sibling execution paths. Kept in ONE helper so `advisory-lock-guard.test.ts`
 * counts a single `pg_advisory_xact_lock(1)` site for this file. See
 * docs/CONCURRENCY_AND_LOCKING.md -> "Provisional reservations for held
 * policy-exception requests (#2365)".
 */
async function acquireGlobalBookingLock(
  tx: Pick<PrismaTransactionClient, "$executeRaw">,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
}

/**
 * #2524: the request-CREATION service for eligible SOFT booking-policy failures.
 *
 * It turns a would-be-hard-stop (minimum stay, or enabled adult-member hosting)
 * into a durable, immutable member request an admin can decide later. It builds
 * ON the #2365 foundation — it consumes `freezePolicyExceptionEvidence`,
 * `computeProposalHash`, `canonicalizeProposalSnapshot`, `normalizeMemberMessage`
 * and the open-slot key helpers rather than reimplementing any of them.
 *
 * Scope boundary (the rest is #2525, `booking-exception-execution.ts`):
 *  - it NEVER reserves provisional capacity and NEVER touches or creates a live
 *    booking. A held request changes nothing but its own row;
 *  - approval + atomic canonical execution is a named seam it does not cross.
 *
 * Two request flavours share every discipline here (immutable proposal + hash,
 * frozen evidence, required <=1000-char message, a DB-enforced one-open-request
 * slot, guarded single-transition lifecycle, post-commit notification):
 *  - NEW_BOOKING  -> its own `NewBookingPolicyExceptionRequest` table;
 *  - MODIFICATION -> a POLICY_EXCEPTION `BookingChangeRequest` (the #2365 store).
 */

// ---------------------------------------------------------------------------
// Typed domain errors (routes map these to HTTP status codes)
// ---------------------------------------------------------------------------

/** No eligible soft violation trips the proposal — there is nothing to review. */
export class NoEligiblePolicyExceptionError extends Error {
  constructor() {
    super(
      "This proposal does not trip any reviewable booking-policy exception.",
    );
    this.name = "NoEligiblePolicyExceptionError";
  }
}

/** A request is already open for this subject (the one-open-request rule). */
export class OpenExceptionRequestConflictError extends Error {
  constructor() {
    super("A booking-policy exception request is already open.");
    this.name = "OpenExceptionRequestConflictError";
  }
}

/**
 * A supersede targeted a request that is no longer REQUESTED (already approved,
 * rejected, cancelled or superseded by someone else). Per the "lost claim runs
 * NO side effect" rule, the replacement request is NOT created.
 */
export class LostSupersedeClaimError extends Error {
  constructor() {
    super("The request you tried to replace is no longer open.");
    this.name = "LostSupersedeClaimError";
  }
}

/**
 * A HELD (HOLD-mode) modification request would need to RESERVE beds the lodge
 * does not currently have (#2525 FIX 4). We refuse it rather than write an
 * over-capacity provisional hold — an over-capacity hold is never an oversell
 * (the live booking still holds only its own beds) but it would phantom-block
 * other members' admissions and is a griefing vector. The member can resubmit
 * once capacity frees up. This mirrors the request service's existing "signal a
 * couldn't-proceed by a typed error the HTTP layer maps to a 4xx" contract
 * (NoEligible/OpenConflict/LostSupersede) — the smallest, most consistent choice,
 * and it keeps the invariant "a REQUESTED HOLD request always holds exactly its
 * reserved beds" intact (no `mode=HOLD but nothing reserved` ghost rows).
 */
export class PolicyExceptionCapacityUnavailableError extends Error {
  constructor() {
    super(
      "The lodge does not currently have room to hold this change. Please try again once space frees up.",
    );
    this.name = "PolicyExceptionCapacityUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ExceptionRequestGuestInput {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId?: string | null;
  /** YYYY-MM-DD; falls back to the booking envelope when absent. */
  stayStart?: string | null;
  stayEnd?: string | null;
}

export interface CreateNewBookingExceptionRequestInput {
  requestedByMemberId: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  guests: ExceptionRequestGuestInput[];
  memberMessage: string;
  /** When set, the member is replacing THIS open request of theirs. */
  supersedeRequestId?: string | null;
}

export interface CreateModificationExceptionRequestInput {
  requestedByMemberId: string;
  bookingId: string;
  lodgeId: string;
  /** The live booking footprint the proposal was computed against. */
  base: ProposalParty;
  /** The full proposed result (never a delta). */
  proposed: ProposalParty;
  memberMessage: string;
  /** A short human summary rendered in the officer queue. */
  requestedSummary: string;
  supersedeRequestId?: string | null;
  /**
   * Whether the LIVE booking being modified currently holds lodge capacity
   * (`bookingHoldsCapacity`, #1254). Required because a modification exception
   * request may be raised against any booking `getBookingEditPolicy` deems
   * editable — including DRAFT / generic PENDING / un-held PAYMENT_PENDING /
   * WAITLISTED / BUMPED bookings, none of which hold capacity. When the base
   * holds capacity the provisional reservation is the INCREMENTAL footprint;
   * when it does not, it is the FULL proposed footprint (#2525 FIX 7), because a
   * non-holding base contributes nothing to occupancy for the delta to sit atop.
   */
  baseHoldsCapacity: boolean;
}

// ---------------------------------------------------------------------------
// Proposal building + soft-policy re-evaluation (authoritative, server-side)
// ---------------------------------------------------------------------------

/** Expand a lodge-night envelope to sorted, unique YYYY-MM-DD strings. */
function envelopeNights(checkIn: Date, checkOut: Date): string[] {
  return getStayNights(checkIn, checkOut).map(formatDateOnly);
}

/**
 * Build the immutable proposed party from raw guest input, expanding each
 * guest's per-night footprint from their own stay range (falling back to the
 * booking envelope). Canonicalised so two freezes of the same facts are
 * byte-identical.
 */
export function buildProposalPartyFromGuests(
  checkIn: Date,
  checkOut: Date,
  guests: readonly ExceptionRequestGuestInput[],
): ProposalParty {
  const bookingNights = envelopeNights(checkIn, checkOut);
  const proposalGuests: ProposalGuest[] = guests.map((guest) => {
    const start = guest.stayStart ? parseDateOnly(guest.stayStart) : checkIn;
    const end = guest.stayEnd ? parseDateOnly(guest.stayEnd) : checkOut;
    const nights = envelopeNights(start, end);
    return {
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      memberId: guest.memberId ?? null,
      nights: nights.length > 0 ? nights : bookingNights,
    };
  });
  return canonicalizeProposalParty({
    checkIn: formatDateOnly(checkIn),
    checkOut: formatDateOnly(checkOut),
    guests: proposalGuests,
  });
}

export interface LiveBookingGuestInput {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId: string | null;
  stayStart: Date;
  stayEnd: Date;
}

export interface ModificationDeltaInput {
  /** YYYY-MM-DD; absent keeps the live value. */
  checkIn?: string | null;
  checkOut?: string | null;
  addGuests?: ExceptionRequestGuestInput[];
  removeGuestIds?: string[];
  guestStayRanges?: Array<{
    guestId: string;
    stayStart?: string | null;
    stayEnd?: string | null;
  }>;
}

/**
 * Build the frozen base (live) and proposed (post-delta) parties for a
 * modification request. The stored proposed snapshot is the authoritative,
 * reviewed artifact #2525 executes byte-for-byte, so this is where "what the
 * member asked for" is rendered once.
 *
 * Proposed-guest rule (mirrors the canonical modification planner): a remaining
 * guest keeps their own per-guest range when one is supplied; otherwise, if the
 * booking dates moved, they are reset to the new envelope; otherwise they keep
 * their stored range. Added guests land in their own range or the new envelope.
 * Removed guests drop out.
 */
export function buildModificationProposalParties(args: {
  bookingCheckIn: Date;
  bookingCheckOut: Date;
  liveGuests: readonly LiveBookingGuestInput[];
  delta: ModificationDeltaInput;
}): { base: ProposalParty; proposed: ProposalParty } {
  const { bookingCheckIn, bookingCheckOut, liveGuests, delta } = args;

  const newCheckIn = delta.checkIn ? parseDateOnly(delta.checkIn) : bookingCheckIn;
  const newCheckOut = delta.checkOut
    ? parseDateOnly(delta.checkOut)
    : bookingCheckOut;
  const datesChanged =
    newCheckIn.getTime() !== bookingCheckIn.getTime() ||
    newCheckOut.getTime() !== bookingCheckOut.getTime();

  const removeSet = new Set(delta.removeGuestIds ?? []);
  const rangeByGuest = new Map(
    (delta.guestStayRanges ?? []).map((range) => [range.guestId, range]),
  );

  const baseGuests: ProposalGuest[] = liveGuests.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId,
    nights: envelopeNights(guest.stayStart, guest.stayEnd),
  }));

  const proposedRemaining: ProposalGuest[] = liveGuests
    .filter((guest) => !removeSet.has(guest.id))
    .map((guest) => {
      const range = rangeByGuest.get(guest.id);
      let start = guest.stayStart;
      let end = guest.stayEnd;
      if (range) {
        start = range.stayStart ? parseDateOnly(range.stayStart) : newCheckIn;
        end = range.stayEnd ? parseDateOnly(range.stayEnd) : newCheckOut;
      } else if (datesChanged) {
        start = newCheckIn;
        end = newCheckOut;
      }
      return {
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        isMember: guest.isMember,
        memberId: guest.memberId,
        nights: envelopeNights(start, end),
      };
    });

  const proposedAdded: ProposalGuest[] = (delta.addGuests ?? []).map((guest) => {
    const start = guest.stayStart ? parseDateOnly(guest.stayStart) : newCheckIn;
    const end = guest.stayEnd ? parseDateOnly(guest.stayEnd) : newCheckOut;
    return {
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      memberId: guest.memberId ?? null,
      nights: envelopeNights(start, end),
    };
  });

  const base = canonicalizeProposalParty({
    checkIn: formatDateOnly(bookingCheckIn),
    checkOut: formatDateOnly(bookingCheckOut),
    guests: baseGuests,
  });
  const proposed = canonicalizeProposalParty({
    checkIn: formatDateOnly(newCheckIn),
    checkOut: formatDateOnly(newCheckOut),
    guests: [...proposedRemaining, ...proposedAdded],
  });
  return { base, proposed };
}

type PolicyEvaluationDb = typeof prisma;

/**
 * Re-evaluate the eligible soft policies (minimum stay + adult-member hosting)
 * for a proposed party against CURRENT policy configuration. Authoritative and
 * server-side: the client's claimed violations are never trusted — the request
 * freezes exactly what this returns. Both request flavours funnel through here,
 * so a new booking and a modification cannot disagree about how a proposal is
 * judged.
 */
export async function evaluateProposalPartyViolations(
  db: PolicyEvaluationDb,
  lodgeId: string,
  party: ProposalParty,
  /**
   * Who is asking, and about which booking (#2543). Optional, and used ONLY by the
   * paid-up-adult evaluation below — the hosting evaluation is left byte-identical.
   *
   * It exists to make the override door actually open. A booking path refuses a
   * party because its only paid-up adult member is a cross-family member guest
   * whose invite is still PENDING (D-12: they hold a bed and nothing else, and may
   * never accept). The member then submits the SAME party here. Without these
   * facts this re-evaluation counted that PENDING adult as present, found no
   * violation, and the request machinery correctly refused to create a request
   * there was nothing to review — so the 409's promised door led nowhere.
   *
   * `ProposalGuest` deliberately does NOT carry the fact: the proposal is frozen
   * and hashed, and adding a field would change every existing proposal hash. It
   * is derived here instead.
   */
  presence?: {
    /** The member submitting the request; their family boundary decides scope. */
    requestedByMemberId?: string | null;
    /** For a MODIFICATION proposal: the live booking whose rows already exist. */
    bookingId?: string | null;
  },
): Promise<PolicyExceptionViolation[]> {
  const checkIn = parseDateOnly(party.checkIn);
  const checkOut = parseDateOnly(party.checkOut);

  const violations: PolicyExceptionViolation[] = [];

  const stay = await validateMinimumStay(checkIn, checkOut, lodgeId, db);
  if (!stay.valid) {
    violations.push(...stay.violations);
  }

  const hosting = await evaluateProposedAdultMemberHosting(db, {
    lodgeId,
    checkIn,
    checkOut,
    guests: party.guests.map((guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      memberId: guest.memberId,
      nights: guest.nights,
    })),
  });
  if (hosting) {
    violations.push(hosting);
  }

  // #2543 — the paid-up-adult requirement. Registering it HERE is what turns
  // the booking refusal into an actual door: the member re-submits the same
  // party to `POST /api/bookings/exception-requests`, this re-evaluation
  // (server-side, never the client's claim) reproduces the violation, and the
  // #2365 machinery freezes it, HOLDs the beds and queues it for a Booking
  // Officer. Without this line the refusal would name a workflow the member
  // could not enter.
  const operationallyPresentFor = await resolveProposalOperationalPresence(
    db,
    party,
    presence,
  );
  const paidUpAdult = await evaluateProposedPaidUpAdultPresence(db, {
    lodgeId,
    checkIn,
    checkOut,
    bookingOwnerMemberId: await resolveProposalBookingOwner(db, presence),
    guests: party.guests.map((guest) => ({
      ...guest,
      operationallyPresent: operationallyPresentFor(guest.memberId),
    })),
  });
  if (paidUpAdult) {
    violations.push(paidUpAdult);
  }

  return violations;
}

/**
 * Who would OWN the booking a proposal describes (#2543, owner decision 3 Aug
 * 2026).
 *
 * The second half of making the override door real. The paid-up-adult requirement
 * also fires when the booking OWNER is an unfinancial member, staying or not; a
 * booking path that refused on that trigger must reproduce the SAME violation
 * here, or the request machinery finds nothing to review, refuses to create a
 * request, and the 409 names a workflow the member cannot enter.
 *
 * A MODIFICATION reads the live booking's own `memberId` rather than trusting the
 * requester to be it: that is the member the booking paths judge, and reading it
 * server-side is what stops the door being opened against somebody else's
 * standing. A NEW booking has no row yet, so the requester is who would own it.
 * `ProposalGuest` deliberately does not carry the fact, exactly as with D-12
 * presence — the proposal is frozen and hashed, and a new field would change every
 * existing proposal hash.
 */
async function resolveProposalBookingOwner(
  db: PolicyEvaluationDb,
  presence:
    | { requestedByMemberId?: string | null; bookingId?: string | null }
    | undefined,
): Promise<string | null> {
  if (presence?.bookingId) {
    const booking = await db.booking.findUnique({
      where: { id: presence.bookingId },
      select: { memberId: true },
    });
    return booking?.memberId ?? null;
  }
  return presence?.requestedByMemberId?.trim() || null;
}

/**
 * D-12 operational presence for each member in a PROPOSED party (#2543).
 *
 * Returns a lookup that answers `undefined` — i.e. "absent, so present", the #2364
 * default — whenever there is nothing to go on, so a caller that supplies no
 * context gets exactly the previous behaviour.
 *
 * The rule, in two halves:
 *
 *  - a member guest BEYOND the requester's family boundary is invited PENDING when
 *    the booking is eventually made, so they are not yet present. This is the case
 *    the booking paths refuse on, and reproducing it here is the whole point;
 *  - EXCEPT where a live row for that member on this booking is already
 *    operationally present (a CONFIRMED cross-family guest, or a family-scope row
 *    with no consent status at all), in which case they are present. Without this
 *    half a modification proposal would raise a violation for a party the booking
 *    path allows, and an admin would be asked to review something that needed no
 *    review.
 */
async function resolveProposalOperationalPresence(
  db: PolicyEvaluationDb,
  party: ProposalParty,
  presence:
    | { requestedByMemberId?: string | null; bookingId?: string | null }
    | undefined,
): Promise<(memberId: string | null) => boolean | undefined> {
  const requestedByMemberId = presence?.requestedByMemberId?.trim();
  if (!requestedByMemberId) return () => undefined;

  const memberIds = [
    ...new Set(
      party.guests
        .map((guest) => guest.memberId?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (memberIds.length === 0) return () => undefined;

  const boundary = await computeMemberGuestBoundary(
    db,
    requestedByMemberId,
    memberIds,
  );

  const alreadyPresent = new Set<string>();
  if (presence?.bookingId) {
    const liveRows = await db.bookingGuest.findMany({
      where: { bookingId: presence.bookingId },
      select: { memberId: true, consentStatus: true },
    });
    for (const row of liveRows) {
      if (row.memberId && isOperationallyPresentConsent(row.consentStatus)) {
        alreadyPresent.add(row.memberId);
      }
    }
  }

  return (memberId) => {
    const id = memberId?.trim();
    if (!id) return undefined;
    if (boundary.scopeByMemberId.get(id) !== "BEYOND_FAMILY") return undefined;
    return alreadyPresent.has(id) ? true : false;
  };
}

interface FrozenProposal {
  snapshot: NewBookingProposalSnapshot | ModificationProposalSnapshot;
  proposalHash: string;
  frozenEvidence: ReturnType<typeof freezePolicyExceptionEvidence>;
  aggregateCapacityMode: PolicyExceptionCapacityMode;
  violations: PolicyExceptionViolation[];
}

/**
 * Freeze a proposal: refuse it if no eligible soft violation trips (nothing to
 * review), otherwise build the canonical snapshot + hash and the #2363 evidence
 * aggregate. `aggregateCapacityMode` is guaranteed non-null because a non-empty
 * violation set always resolves HOLD-if-any-HOLD.
 */
function freezeProposal(
  snapshotInput: NewBookingProposalSnapshot | ModificationProposalSnapshot,
  violations: PolicyExceptionViolation[],
): FrozenProposal {
  if (violations.length === 0) {
    throw new NoEligiblePolicyExceptionError();
  }
  const frozenEvidence = freezePolicyExceptionEvidence(violations);
  if (frozenEvidence.capacityMode === null) {
    // Unreachable given violations.length > 0, but the DB column is NOT NULL, so
    // fail closed rather than write a null aggregate.
    throw new NoEligiblePolicyExceptionError();
  }
  const snapshot = canonicalizeProposalSnapshot(snapshotInput) as
    | NewBookingProposalSnapshot
    | ModificationProposalSnapshot;
  return {
    snapshot,
    proposalHash: computeProposalHash(snapshot),
    frozenEvidence,
    aggregateCapacityMode: frozenEvidence.capacityMode,
    violations,
  };
}

function isOpenSlotUniqueViolation(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    const target = error.meta?.target;
    if (Array.isArray(target)) {
      return target.some((column) => String(column).includes("openStateKey"));
    }
    return true;
  }
  // Test seam / defensive: a plain P2002-coded object still maps to the conflict.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// NEW_BOOKING requests
// ---------------------------------------------------------------------------

export interface CreatedExceptionRequest {
  id: string;
  status: string;
  proposalHash: string;
  reasonCodes: PolicyExceptionReasonCode[];
  aggregateCapacityMode: PolicyExceptionCapacityMode;
}

/**
 * Create a NEW-booking policy-exception request. Evaluates the soft policies
 * server-side, freezes the immutable proposal + evidence, and stores it under
 * the member's one-open-request slot. If `supersedeRequestId` is set, the old
 * request is claimed REQUESTED -> SUPERSEDED first with a guarded `updateMany`;
 * a lost claim aborts with NO new row created. The live booking layer is never
 * touched — a new booking does not exist yet.
 */
export async function createNewBookingExceptionRequest(
  input: CreateNewBookingExceptionRequestInput,
): Promise<CreatedExceptionRequest> {
  const memberMessage = normalizeMemberMessage(input.memberMessage);

  const proposedParty = buildProposalPartyFromGuests(
    input.checkIn,
    input.checkOut,
    input.guests,
  );

  const violations = await evaluateProposalPartyViolations(
    prisma,
    input.lodgeId,
    proposedParty,
    // #2543 — no live booking exists yet, so every cross-family member guest in the
    // proposal is somebody who would be invited PENDING.
    { requestedByMemberId: input.requestedByMemberId },
  );

  const frozen = freezeProposal(
    { kind: "NEW_BOOKING", lodgeId: input.lodgeId, proposed: proposedParty },
    violations,
  );

  const openStateKey = newBookingExceptionOpenStateKey(
    input.requestedByMemberId,
    frozen.proposalHash,
  );

  try {
    const created = await prisma.$transaction(async (tx) => {
      if (input.supersedeRequestId) {
        const claim = await tx.newBookingPolicyExceptionRequest.updateMany({
          where: {
            id: input.supersedeRequestId,
            requestedByMemberId: input.requestedByMemberId,
            status: "REQUESTED",
          },
          data: {
            status: "SUPERSEDED",
            openStateKey: null,
            cancelledAt: new Date(),
            version: { increment: 1 },
          },
        });
        // Lost claim: the target is no longer open. NO side effect — do not
        // create the replacement request.
        if (claim.count === 0) {
          throw new LostSupersedeClaimError();
        }
      }

      const request = await tx.newBookingPolicyExceptionRequest.create({
        data: {
          lodgeId: input.lodgeId,
          requestedByMemberId: input.requestedByMemberId,
          status: "REQUESTED",
          proposalSnapshot: frozen.snapshot as unknown as Prisma.InputJsonValue,
          proposalHash: frozen.proposalHash,
          frozenEvidence:
            frozen.frozenEvidence as unknown as Prisma.InputJsonValue,
          aggregateCapacityMode: frozen.aggregateCapacityMode,
          memberMessage,
          openStateKey,
        },
        select: { id: true, status: true },
      });

      if (input.supersedeRequestId) {
        await tx.newBookingPolicyExceptionRequest.updateMany({
          where: {
            id: input.supersedeRequestId,
            status: "SUPERSEDED",
            supersededByRequestId: null,
          },
          data: { supersededByRequestId: request.id },
        });
      }

      return request;
    });

    return {
      id: created.id,
      status: created.status,
      proposalHash: frozen.proposalHash,
      reasonCodes: frozen.frozenEvidence.reasonCodes,
      aggregateCapacityMode: frozen.aggregateCapacityMode,
    };
  } catch (error) {
    if (isOpenSlotUniqueViolation(error)) {
      throw new OpenExceptionRequestConflictError();
    }
    throw error;
  }
}

/**
 * Member cancels their own OPEN new-booking request. A guarded single
 * transition REQUESTED -> CANCELLED that also frees the open slot. Returns true
 * only when the claim landed; a lost claim (already terminal) returns false and
 * the caller runs NO side effect.
 */
export async function cancelNewBookingExceptionRequest(input: {
  id: string;
  requestedByMemberId: string;
}): Promise<boolean> {
  const claim = await prisma.newBookingPolicyExceptionRequest.updateMany({
    where: {
      id: input.id,
      requestedByMemberId: input.requestedByMemberId,
      status: "REQUESTED",
    },
    data: {
      status: "CANCELLED",
      openStateKey: null,
      cancelledAt: new Date(),
      version: { increment: 1 },
    },
  });
  return claim.count === 1;
}

// ---------------------------------------------------------------------------
// MODIFICATION requests (POLICY_EXCEPTION BookingChangeRequest)
// ---------------------------------------------------------------------------

/**
 * Create a MODIFICATION policy-exception request on the #2365 BookingChangeRequest
 * store. Freezes the base (live) + proposed footprints and the evidence, and
 * holds the member's one-open POLICY_EXCEPTION slot on this booking. The live
 * booking is NEVER modified here. Supersede + guarded-claim discipline matches
 * the new-booking path.
 */
export async function createModificationExceptionRequest(
  input: CreateModificationExceptionRequestInput,
): Promise<CreatedExceptionRequest> {
  const memberMessage = normalizeMemberMessage(input.memberMessage);

  const violations = await evaluateProposalPartyViolations(
    prisma,
    input.lodgeId,
    input.proposed,
    // #2543 — a modification: rows already on the booking are judged by their
    // stored consent status, and only the ones this proposal would newly invite
    // count as not-yet-present.
    {
      requestedByMemberId: input.requestedByMemberId,
      bookingId: input.bookingId,
    },
  );

  const frozen = freezeProposal(
    {
      kind: "MODIFICATION",
      lodgeId: input.lodgeId,
      bookingId: input.bookingId,
      base: input.base,
      proposed: input.proposed,
    },
    violations,
  );

  const openStateKey = modificationExceptionOpenStateKey(
    input.bookingId,
    input.requestedByMemberId,
  );

  // A HELD (HOLD-mode) modification reserves per-night beds while pending
  // (#2525); a supersede releases the prior request's hold. Either makes this a
  // capacity change, so the transaction takes the house global -> per-lodge locks
  // before touching the reservation ledger. A NO_HOLD, non-supersede create is a
  // pure row insert and needs neither.
  const holdsCapacity = frozen.aggregateCapacityMode === "HOLD";

  // The exact footprint this HOLD request will reserve: INCREMENTAL beds over a
  // capacity-holding base, or the FULL proposed footprint over a non-holding base
  // (#2525 FIX 7). Computed once (pure) so the admission check below guards
  // EXACTLY the beds we are about to write.
  const reservationFootprint: NightReservation[] = holdsCapacity
    ? computeProposalReservation(frozen.snapshot, {
        baseHoldsCapacity: input.baseHoldsCapacity,
      })
    : [];
  const reservesBeds = reservationFootprint.length > 0;
  const mutatesReservation = reservesBeds || Boolean(input.supersedeRequestId);

  // The full proposed party as capacity-engine guest ranges (explicit per-night
  // sets), for the pre-reservation admission check (#2525 FIX 4).
  const proposedParty = (frozen.snapshot as ModificationProposalSnapshot).proposed;
  const proposedCheckIn = parseDateOnly(proposedParty.checkIn);
  const proposedCheckOut = parseDateOnly(proposedParty.checkOut);
  const proposedGuestRanges: GuestStayRange[] = proposedParty.guests.map(
    (guest) => ({ nights: guest.nights }),
  );

  try {
    const created = await prisma.$transaction(async (tx) => {
      if (mutatesReservation) {
        await acquireGlobalBookingLock(tx);
        await acquireLodgeCapacityLock(tx, input.lodgeId);
      }

      if (input.supersedeRequestId) {
        const claim = await tx.bookingChangeRequest.updateMany({
          where: {
            id: input.supersedeRequestId,
            // Scope the supersede to THIS booking (#2525 FIX 6). A supersede
            // replaces the member's open request on the SAME booking, and we hold
            // only THIS booking's lodge lock here — so releasing a request that
            // lived on a DIFFERENT booking/lodge would delete its reservation
            // without serialising against that lodge's occupancy readers. Scoping
            // to `bookingId` makes a cross-booking supersede claim 0 rows (a lost
            // claim) rather than an unserialised cross-lodge release.
            bookingId: input.bookingId,
            requestedByMemberId: input.requestedByMemberId,
            kind: "POLICY_EXCEPTION",
            status: "REQUESTED",
          },
          data: {
            status: "SUPERSEDED",
            openStateKey: null,
            cancelledAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (claim.count === 0) {
          throw new LostSupersedeClaimError();
        }
        // The superseded request no longer holds beds — release its provisional
        // reservation atomically with the SUPERSEDED claim (under the same locks),
        // so the hold the replacement takes below cannot double-count the beds the
        // old proposal held.
        await releasePolicyExceptionReservation(tx, input.supersedeRequestId);
      }

      // (#2525 FIX 4) Admission control BEFORE writing an over-capacity hold. Run
      // it under the per-lodge lock already held, AFTER any supersede release (so
      // a resubmit's own freed beds do not count against it). Excluding the live
      // booking makes the full-proposed check equivalent to an incremental-headroom
      // check for a capacity-holding base, and the correct full-footprint check for
      // a non-holding base (its id is simply absent from the occupancy population,
      // so the exclusion is a harmless no-op). A shortfall refuses the request
      // rather than persisting a phantom-bed hold that would block other members.
      if (reservesBeds) {
        const capacity = await checkCapacityForGuestRanges(
          input.lodgeId,
          proposedCheckIn,
          proposedCheckOut,
          proposedGuestRanges,
          input.bookingId,
          tx,
        );
        if (!capacity.available) {
          throw new PolicyExceptionCapacityUnavailableError();
        }
      }

      const request = await tx.bookingChangeRequest.create({
        data: {
          bookingId: input.bookingId,
          requestedByMemberId: input.requestedByMemberId,
          kind: "POLICY_EXCEPTION",
          status: "REQUESTED",
          // requestedChanges is a required column; keep the existing queue's
          // {requested:{summary}} shape so the officer view renders a summary
          // without a policy-exception-specific branch.
          requestedChanges: {
            source: "POLICY_EXCEPTION",
            requested: { summary: input.requestedSummary },
          } as unknown as Prisma.InputJsonValue,
          proposalSnapshot: frozen.snapshot as unknown as Prisma.InputJsonValue,
          proposalHash: frozen.proposalHash,
          frozenEvidence:
            frozen.frozenEvidence as unknown as Prisma.InputJsonValue,
          aggregateCapacityMode: frozen.aggregateCapacityMode,
          memberMessage,
          openStateKey,
        },
        select: { id: true, status: true },
      });

      // Reserve the capacity a HELD request holds while pending, keyed on the new
      // request id, under the per-lodge lock taken above — EXACTLY the footprint
      // the admission check just cleared. NO_HOLD proposals (and pure shrinks)
      // reserve nothing; the approval rechecks capacity instead.
      if (reservesBeds) {
        await reservePolicyExceptionCapacity(tx, {
          changeRequestId: request.id,
          lodgeId: input.lodgeId,
          reservation: reservationFootprint,
        });
      }

      if (input.supersedeRequestId) {
        await tx.bookingChangeRequest.updateMany({
          where: {
            id: input.supersedeRequestId,
            status: "SUPERSEDED",
            supersededByRequestId: null,
          },
          data: { supersededByRequestId: request.id },
        });
      }

      return request;
    });

    return {
      id: created.id,
      status: created.status,
      proposalHash: frozen.proposalHash,
      reasonCodes: frozen.frozenEvidence.reasonCodes,
      aggregateCapacityMode: frozen.aggregateCapacityMode,
    };
  } catch (error) {
    if (isOpenSlotUniqueViolation(error)) {
      throw new OpenExceptionRequestConflictError();
    }
    throw error;
  }
}

/**
 * Member cancels their own OPEN modification policy-exception request. Guarded
 * single transition, frees the slot, returns false (no side effect) on a lost
 * claim. Scoped to POLICY_EXCEPTION so it can never touch a locked-period row,
 * and to the request's own `bookingId` so a request reached via the wrong
 * booking URL cannot be claimed (which would mislabel the success-path audit
 * with the URL's booking rather than the request's real one) — a mismatched
 * pair claims 0 rows and returns false.
 */
export async function cancelModificationExceptionRequest(input: {
  id: string;
  bookingId: string;
  requestedByMemberId: string;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // A cancel RELEASES any provisional reservation the held request holds
    // (#2525), which is a capacity change, so it takes the house global ->
    // per-lodge locks keyed on the frozen lodge before the guarded claim — the
    // same discipline as `resolvePolicyExceptionRequestTerminal`. The pre-read
    // resolves only the immutable frozen lodge for the lock; authorization and
    // the single-flight stay in the member/booking-scoped guarded claim below, so
    // a lost claim (wrong owner, wrong booking, or already terminal) releases
    // nothing.
    const pre = await tx.bookingChangeRequest.findUnique({
      where: { id: input.id },
      select: { proposalSnapshot: true, kind: true },
    });
    if (!pre || pre.kind !== "POLICY_EXCEPTION") return false;
    const snapshot = pre.proposalSnapshot as { lodgeId?: unknown } | null;
    const lodgeId =
      snapshot && typeof snapshot.lodgeId === "string" ? snapshot.lodgeId : null;

    await acquireGlobalBookingLock(tx);
    if (lodgeId) await acquireLodgeCapacityLock(tx, lodgeId);

    const claim = await tx.bookingChangeRequest.updateMany({
      where: {
        id: input.id,
        bookingId: input.bookingId,
        requestedByMemberId: input.requestedByMemberId,
        kind: "POLICY_EXCEPTION",
        status: "REQUESTED",
      },
      data: {
        status: "CANCELLED",
        openStateKey: null,
        cancelledAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (claim.count !== 1) return false;

    await releasePolicyExceptionReservation(tx, input.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Unified officer queue read (merges both sources)
// ---------------------------------------------------------------------------

const ACTOR_SELECT = {
  select: { id: true, firstName: true, lastName: true, email: true },
} as const;

export type ExceptionQueueStatusFilter =
  | "REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED"
  | "SUPERSEDED"
  | "ALL";

export interface UnifiedExceptionQueueItem {
  source: "NEW_BOOKING" | "MODIFICATION";
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  bookingId: string | null;
  lodgeId: string | null;
  requestedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  reviewedBy: { id: string; firstName: string; lastName: string } | null;
  reviewedAt: Date | null;
  memberMessage: string | null;
  proposalHash: string | null;
  aggregateCapacityMode: PolicyExceptionCapacityMode | null;
  reasonCodes: PolicyExceptionReasonCode[];
  affectedNights: string[];
  attemptCount: number;
  conflictCount: number;
  lastConflictAt: Date | null;
  lastConflictReason: string | null;
  supersededByRequestId: string | null;
  summary: string | null;
}

/** Bounded read: the review queue holds a small, bounded set of live requests. */
const UNIFIED_QUEUE_SOURCE_CAP = 500;

function frozenReasonCodes(value: unknown): PolicyExceptionReasonCode[] {
  if (value && typeof value === "object" && "reasonCodes" in value) {
    const codes = (value as { reasonCodes?: unknown }).reasonCodes;
    if (Array.isArray(codes)) {
      return codes.filter((c): c is PolicyExceptionReasonCode => typeof c === "string");
    }
  }
  return [];
}

function frozenAffectedNights(value: unknown): string[] {
  if (value && typeof value === "object" && "affectedNights" in value) {
    const nights = (value as { affectedNights?: unknown }).affectedNights;
    if (Array.isArray(nights)) {
      return nights.filter((n): n is string => typeof n === "string");
    }
  }
  return [];
}

function summaryFromRequestedChanges(value: unknown): string | null {
  if (value && typeof value === "object") {
    const requested = (value as { requested?: unknown }).requested;
    if (requested && typeof requested === "object") {
      const summary = (requested as { summary?: unknown }).summary;
      if (typeof summary === "string") return summary;
    }
  }
  return null;
}

/**
 * The single officer-facing read of every policy-exception request, merging the
 * new-booking table and the POLICY_EXCEPTION BookingChangeRequest rows into one
 * age-ordered list. Rows are fetched per source (bounded), mapped to a common
 * shape, merge-sorted newest-first, then paged in memory — correct across two
 * tables, which a single SQL OFFSET cannot be. Returns the same
 * `{ data, page, pageSize, total }` envelope as the existing change-request
 * queue so the officer UI reads one shape.
 */
export async function readUnifiedExceptionQueue(input: {
  status: ExceptionQueueStatusFilter;
  page: number;
  pageSize: number;
}): Promise<{
  data: UnifiedExceptionQueueItem[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const statusWhere =
    input.status === "ALL" ? {} : { status: input.status };

  const [newBookingRows, modificationRows] = await Promise.all([
    prisma.newBookingPolicyExceptionRequest.findMany({
      where: statusWhere,
      include: { requestedBy: ACTOR_SELECT, reviewedBy: ACTOR_SELECT },
      orderBy: { createdAt: "desc" },
      take: UNIFIED_QUEUE_SOURCE_CAP,
    }),
    prisma.bookingChangeRequest.findMany({
      where: { kind: "POLICY_EXCEPTION", ...statusWhere },
      include: { requestedBy: ACTOR_SELECT, reviewedBy: ACTOR_SELECT },
      orderBy: { createdAt: "desc" },
      take: UNIFIED_QUEUE_SOURCE_CAP,
    }),
  ]);

  const items: UnifiedExceptionQueueItem[] = [
    ...newBookingRows.map(
      (row): UnifiedExceptionQueueItem => ({
        source: "NEW_BOOKING",
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        bookingId: null,
        lodgeId: row.lodgeId,
        requestedBy: row.requestedBy,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt,
        memberMessage: row.memberMessage,
        proposalHash: row.proposalHash,
        aggregateCapacityMode: row.aggregateCapacityMode,
        reasonCodes: frozenReasonCodes(row.frozenEvidence),
        affectedNights: frozenAffectedNights(row.frozenEvidence),
        attemptCount: row.attemptCount,
        conflictCount: row.conflictCount,
        lastConflictAt: row.lastConflictAt,
        lastConflictReason: row.lastConflictReason,
        supersededByRequestId: row.supersededByRequestId,
        summary: null,
      }),
    ),
    ...modificationRows.map(
      (row): UnifiedExceptionQueueItem => ({
        source: "MODIFICATION",
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        bookingId: row.bookingId,
        lodgeId: null,
        requestedBy: row.requestedBy,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt,
        memberMessage: row.memberMessage,
        proposalHash: row.proposalHash,
        aggregateCapacityMode: row.aggregateCapacityMode,
        reasonCodes: frozenReasonCodes(row.frozenEvidence),
        affectedNights: frozenAffectedNights(row.frozenEvidence),
        attemptCount: row.attemptCount,
        conflictCount: row.conflictCount,
        lastConflictAt: row.lastConflictAt,
        lastConflictReason: row.lastConflictReason,
        supersededByRequestId: row.supersededByRequestId,
        summary: summaryFromRequestedChanges(row.requestedChanges),
      }),
    ),
  ];

  items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const total = items.length;
  const start = (input.page - 1) * input.pageSize;
  const data = items.slice(start, start + input.pageSize);

  return { data, page: input.page, pageSize: input.pageSize, total };
}
