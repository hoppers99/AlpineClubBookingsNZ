import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { parseDateOnly, formatDateOnly } from "@/lib/date-only";
import { getStayNights } from "@/lib/policies/pricing";
import { validateMinimumStay } from "@/lib/booking-policies";
import { evaluateProposedAdultMemberHosting } from "@/lib/adult-member-hosting-review";
import {
  type PolicyExceptionCapacityMode,
  type PolicyExceptionReasonCode,
  type PolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";
import {
  canonicalizeProposalParty,
  canonicalizeProposalSnapshot,
  computeProposalHash,
  freezePolicyExceptionEvidence,
  modificationExceptionOpenStateKey,
  newBookingExceptionOpenStateKey,
  normalizeMemberMessage,
  type ModificationProposalSnapshot,
  type NewBookingProposalSnapshot,
  type ProposalGuest,
  type ProposalParty,
} from "@/lib/booking-exception-requests";

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

  return violations;
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

  try {
    const created = await prisma.$transaction(async (tx) => {
      if (input.supersedeRequestId) {
        const claim = await tx.bookingChangeRequest.updateMany({
          where: {
            id: input.supersedeRequestId,
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
 * claim. Scoped to POLICY_EXCEPTION so it can never touch a locked-period row.
 */
export async function cancelModificationExceptionRequest(input: {
  id: string;
  requestedByMemberId: string;
}): Promise<boolean> {
  const claim = await prisma.bookingChangeRequest.updateMany({
    where: {
      id: input.id,
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
  return claim.count === 1;
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
