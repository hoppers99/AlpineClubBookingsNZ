import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MinimumStayPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";
import { PolicyExceptionMemberMessageError } from "@/lib/booking-exception-requests";
import { parseDateOnly } from "@/lib/date-only";

const mocks = vi.hoisted(() => ({
  nbCreate: vi.fn(),
  nbUpdateMany: vi.fn(),
  nbFindMany: vi.fn(),
  bcrCreate: vi.fn(),
  bcrUpdateMany: vi.fn(),
  bcrFindMany: vi.fn(),
  bcrFindUnique: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingCreate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  // #2525 reservation ledger + advisory-lock raw statements.
  peUpsert: vi.fn(),
  peDeleteMany: vi.fn(),
  execRaw: vi.fn(),
  validateMinimumStay: vi.fn(),
  evaluateHosting: vi.fn(),
  // #2525 FIX 4: the admission check the hold path runs before reserving.
  checkCapacity: vi.fn(),
  // #2543: the two reads the D-12 presence derivation makes — the requester's
  // family boundary, and the live rows' stored consent status on a modification.
  familyGroupMemberFindMany: vi.fn(async () => []),
  bookingGuestFindMany: vi.fn(async () => []),
  /**
   * #2543 owner arm (owner decision, 3 Aug 2026): the paid-up-adult requirement
   * also fires when the BOOKING OWNER is an unfinancial member, so a MODIFICATION
   * proposal reads the live booking's own `memberId` to find out who that is —
   * deliberately server-side rather than trusting the requester to be the owner.
   *
   * Defaults to a booking with no member owner, which is the neutral answer: the
   * owner arm cannot fire, and every existing expectation in this suite is judged
   * exactly as it was before the arm existed.
   */
  bookingFindUnique: vi.fn(
    async (): Promise<{ memberId: string | null } | null> => ({
      memberId: null,
    }),
  ),
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    // #2525: the global lock(1) and the per-lodge capacity lock both run through
    // tx.$executeRaw; a no-op mock lets the real lock helpers execute.
    $executeRaw: (...a: unknown[]) => mocks.execRaw(...a),
    newBookingPolicyExceptionRequest: {
      create: (...a: unknown[]) => mocks.nbCreate(...a),
      updateMany: (...a: unknown[]) => mocks.nbUpdateMany(...a),
    },
    bookingChangeRequest: {
      create: (...a: unknown[]) => mocks.bcrCreate(...a),
      updateMany: (...a: unknown[]) => mocks.bcrUpdateMany(...a),
      findUnique: (...a: unknown[]) => mocks.bcrFindUnique(...a),
    },
    policyExceptionReservationNight: {
      upsert: (...a: unknown[]) => mocks.peUpsert(...a),
      deleteMany: (...a: unknown[]) => mocks.peDeleteMany(...a),
    },
    booking: {
      update: (...a: unknown[]) => mocks.bookingUpdate(...a),
      create: (...a: unknown[]) => mocks.bookingCreate(...a),
      updateMany: (...a: unknown[]) => mocks.bookingUpdateMany(...a),
      // #2543 owner arm: a modification proposal reads the live booking's owner.
      findUnique: () => mocks.bookingFindUnique(),
    },
    // #2543 — the D-12 presence derivation resolves the requester's family
    // boundary and, for a modification, reads the live rows' consent status. Both
    // are ordinary reads on the same client; stubbing them keeps the suite honest
    // about what the service really touches.
    familyGroupMember: {
      findMany: () => mocks.familyGroupMemberFindMany(),
    },
    bookingGuest: {
      findMany: () => mocks.bookingGuestFindMany(),
    },
  };
  return {
    prisma: {
      ...tx,
      newBookingPolicyExceptionRequest: {
        create: (...a: unknown[]) => mocks.nbCreate(...a),
        updateMany: (...a: unknown[]) => mocks.nbUpdateMany(...a),
        findMany: (...a: unknown[]) => mocks.nbFindMany(...a),
      },
      bookingChangeRequest: {
        create: (...a: unknown[]) => mocks.bcrCreate(...a),
        updateMany: (...a: unknown[]) => mocks.bcrUpdateMany(...a),
        findMany: (...a: unknown[]) => mocks.bcrFindMany(...a),
        findUnique: (...a: unknown[]) => mocks.bcrFindUnique(...a),
      },
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

// #2525 FIX 4: override checkCapacityForGuestRanges, but keep the REAL
// acquireLodgeCapacityLock (it runs through the mocked tx.$executeRaw, so the
// advisory-lock accounting and the "two raw statements" assertion stay honest).
vi.mock("@/lib/capacity", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/capacity")>();
  return {
    ...actual,
    checkCapacityForGuestRanges: (...a: unknown[]) => mocks.checkCapacity(...a),
  };
});

vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: (...a: unknown[]) => mocks.validateMinimumStay(...a),
}));

vi.mock("@/lib/adult-member-hosting-review", () => ({
  evaluateProposedAdultMemberHosting: (...a: unknown[]) =>
    mocks.evaluateHosting(...a),
}));

import {
  buildModificationProposalParties,
  cancelModificationExceptionRequest,
  cancelNewBookingExceptionRequest,
  createModificationExceptionRequest,
  createNewBookingExceptionRequest,
  evaluateProposalPartyViolations,
  LostSupersedeClaimError,
  NoEligiblePolicyExceptionError,
  OpenExceptionRequestConflictError,
  PolicyExceptionCapacityUnavailableError,
  readUnifiedExceptionQueue,
  type ExceptionRequestGuestInput,
} from "@/lib/booking-exception-request-service";

function minStayViolation(): MinimumStayPolicyExceptionViolation {
  return {
    reasonCode: "MINIMUM_STAY",
    policyId: "pol_min",
    policyVersion: 1,
    policyName: "Weekend minimum",
    resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge_1" },
    affectedNights: ["2026-07-04"],
    exceptionEligible: true,
    capacityMode: "HOLD",
    message: "min stay",
    triggerDay: "Saturday",
    minimumNights: 2,
    actualNights: 1,
    requirements: {
      kind: "MINIMUM_STAY",
      minimumNights: 2,
      actualNights: 1,
      triggerDays: [6],
    },
  };
}

const GUESTS: ExceptionRequestGuestInput[] = [
  { firstName: "Ada", lastName: "Lovelace", ageTier: "ADULT", isMember: true, memberId: "m1" },
];

function newBookingInput(overrides: Record<string, unknown> = {}) {
  return {
    requestedByMemberId: "m1",
    lodgeId: "lodge_1",
    checkIn: parseDateOnly("2026-07-04"),
    checkOut: parseDateOnly("2026-07-05"),
    guests: GUESTS,
    memberMessage: "  please allow this one-night weekend stay  ",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // #2543: a requester with no family links, and no live rows, is the neutral
  // default — every existing case in this file predates the derivation.
  mocks.familyGroupMemberFindMany.mockResolvedValue([]);
  mocks.bookingGuestFindMany.mockResolvedValue([]);
  mocks.bookingFindUnique.mockResolvedValue({ memberId: null });
  mocks.validateMinimumStay.mockResolvedValue({ valid: false, violations: [minStayViolation()] });
  mocks.evaluateHosting.mockResolvedValue(null);
  mocks.nbCreate.mockResolvedValue({ id: "req-1", status: "REQUESTED" });
  mocks.nbUpdateMany.mockResolvedValue({ count: 1 });
  mocks.bcrCreate.mockResolvedValue({ id: "bcr-1", status: "REQUESTED" });
  mocks.bcrUpdateMany.mockResolvedValue({ count: 1 });
  // Cancel pre-reads the request to resolve its frozen lodge for the lock.
  mocks.bcrFindUnique.mockResolvedValue({
    proposalSnapshot: { lodgeId: "lodge_1" },
    kind: "POLICY_EXCEPTION",
  });
  mocks.peUpsert.mockResolvedValue({});
  mocks.peDeleteMany.mockResolvedValue({ count: 0 });
  mocks.execRaw.mockResolvedValue(undefined);
  // Default: the lodge has room, so the hold path proceeds to reserve.
  mocks.checkCapacity.mockResolvedValue({
    available: true,
    minAvailable: 10,
    nightDetails: [],
  });
});

describe("createNewBookingExceptionRequest", () => {
  it("freezes evidence + hash, stores under an nbpe open-slot, and returns reason codes", async () => {
    const result = await createNewBookingExceptionRequest(newBookingInput());

    expect(result).toMatchObject({
      id: "req-1",
      status: "REQUESTED",
      reasonCodes: ["MINIMUM_STAY"],
      aggregateCapacityMode: "HOLD",
    });
    expect(result.proposalHash).toMatch(/^[0-9a-f]{64}$/);

    const data = mocks.nbCreate.mock.calls[0][0].data;
    expect(data.openStateKey).toBe(`nbpe:m1:${result.proposalHash}`);
    // Message trimmed by normalizeMemberMessage, never the raw padded string.
    expect(data.memberMessage).toBe("please allow this one-night weekend stay");
    expect(data.status).toBe("REQUESTED");
    expect(data.aggregateCapacityMode).toBe("HOLD");
  });

  it("live-booking-untouched: never writes a Booking row while creating a request", async () => {
    await createNewBookingExceptionRequest(newBookingInput());
    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a proposal that trips no eligible soft violation (NoEligible)", async () => {
    mocks.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
    mocks.evaluateHosting.mockResolvedValue(null);

    await expect(createNewBookingExceptionRequest(newBookingInput())).rejects.toBeInstanceOf(
      NoEligiblePolicyExceptionError,
    );
    expect(mocks.nbCreate).not.toHaveBeenCalled();
  });

  it("rejects an empty-after-trim member message before any DB write", async () => {
    await expect(
      createNewBookingExceptionRequest(newBookingInput({ memberMessage: "   " })),
    ).rejects.toBeInstanceOf(PolicyExceptionMemberMessageError);
    expect(mocks.validateMinimumStay).not.toHaveBeenCalled();
    expect(mocks.nbCreate).not.toHaveBeenCalled();
  });

  it("rejects an over-long member message before any DB write", async () => {
    await expect(
      createNewBookingExceptionRequest(newBookingInput({ memberMessage: "x".repeat(1001) })),
    ).rejects.toBeInstanceOf(PolicyExceptionMemberMessageError);
    expect(mocks.nbCreate).not.toHaveBeenCalled();
  });

  it("one-open-request: a unique-slot violation maps to a 409 conflict", async () => {
    mocks.nbCreate.mockRejectedValue({ code: "P2002", meta: { target: ["openStateKey"] } });
    await expect(createNewBookingExceptionRequest(newBookingInput())).rejects.toBeInstanceOf(
      OpenExceptionRequestConflictError,
    );
  });

  it("supersede: claims the old request REQUESTED->SUPERSEDED, then creates the new one", async () => {
    await createNewBookingExceptionRequest(newBookingInput({ supersedeRequestId: "old-1" }));

    const claim = mocks.nbUpdateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({
      id: "old-1",
      requestedByMemberId: "m1",
      status: "REQUESTED",
    });
    expect(claim.data).toMatchObject({ status: "SUPERSEDED", openStateKey: null });
    expect(mocks.nbCreate).toHaveBeenCalledTimes(1);
  });

  it("lost-claim-no-side-effect: a supersede that claims 0 rows creates NOTHING", async () => {
    mocks.nbUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      createNewBookingExceptionRequest(newBookingInput({ supersedeRequestId: "old-1" })),
    ).rejects.toBeInstanceOf(LostSupersedeClaimError);
    expect(mocks.nbCreate).not.toHaveBeenCalled();
  });
});

describe("cancelNewBookingExceptionRequest (guarded transition)", () => {
  it("claims REQUESTED->CANCELLED scoped to the member, frees the slot, returns true", async () => {
    mocks.nbUpdateMany.mockResolvedValue({ count: 1 });
    const ok = await cancelNewBookingExceptionRequest({ id: "req-1", requestedByMemberId: "m1" });
    expect(ok).toBe(true);

    const call = mocks.nbUpdateMany.mock.calls[0][0];
    // Mutation guard: the transition MUST be gated on status REQUESTED + owner.
    expect(call.where).toMatchObject({
      id: "req-1",
      requestedByMemberId: "m1",
      status: "REQUESTED",
    });
    expect(call.data).toMatchObject({ status: "CANCELLED", openStateKey: null });
  });

  it("returns false (lost claim) when nothing was REQUESTED to cancel", async () => {
    mocks.nbUpdateMany.mockResolvedValue({ count: 0 });
    const ok = await cancelNewBookingExceptionRequest({ id: "req-1", requestedByMemberId: "m1" });
    expect(ok).toBe(false);
  });
});

describe("createModificationExceptionRequest", () => {
  const base = {
    checkIn: "2026-07-04",
    checkOut: "2026-07-05",
    guests: [
      { firstName: "Ada", lastName: "Lovelace", ageTier: "ADULT", isMember: true, memberId: "m1", nights: ["2026-07-04"] },
    ],
  };

  it("writes a POLICY_EXCEPTION BookingChangeRequest and never touches the live booking", async () => {
    const result = await createModificationExceptionRequest({
      requestedByMemberId: "m1",
      bookingId: "booking-1",
      lodgeId: "lodge_1",
      base,
      proposed: base,
      memberMessage: "please allow",
      requestedSummary: "check-out to 2026-07-05",
      baseHoldsCapacity: true,
    });

    expect(result.reasonCodes).toEqual(["MINIMUM_STAY"]);
    const data = mocks.bcrCreate.mock.calls[0][0].data;
    expect(data.kind).toBe("POLICY_EXCEPTION");
    expect(data.status).toBe("REQUESTED");
    expect(data.openStateKey).toBe("pe:booking-1:m1");
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("lost-claim-no-side-effect: a supersede claiming 0 rows creates NOTHING", async () => {
    mocks.bcrUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      createModificationExceptionRequest({
        requestedByMemberId: "m1",
        bookingId: "booking-1",
        lodgeId: "lodge_1",
        base,
        proposed: base,
        memberMessage: "please allow",
        requestedSummary: "x",
        supersedeRequestId: "old-9",
        baseHoldsCapacity: true,
      }),
    ).rejects.toBeInstanceOf(LostSupersedeClaimError);
    expect(mocks.bcrCreate).not.toHaveBeenCalled();
    // A lost supersede claim releases nothing and reserves nothing.
    expect(mocks.peDeleteMany).not.toHaveBeenCalled();
    expect(mocks.peUpsert).not.toHaveBeenCalled();
  });

  it("held modification reserves ONLY the incremental beds, under the global -> lodge lock", async () => {
    // proposed adds a second guest on the same night, so the incremental hold is
    // one bed on 2026-07-04 (the base guest already holds its own).
    const proposed = {
      checkIn: "2026-07-04",
      checkOut: "2026-07-05",
      guests: [
        { firstName: "Ada", lastName: "Lovelace", ageTier: "ADULT", isMember: true, memberId: "m1", nights: ["2026-07-04"] },
        { firstName: "Grace", lastName: "Hopper", ageTier: "ADULT", isMember: false, memberId: null, nights: ["2026-07-04"] },
      ],
    };

    await createModificationExceptionRequest({
      requestedByMemberId: "m1",
      bookingId: "booking-1",
      lodgeId: "lodge_1",
      base,
      proposed,
      memberMessage: "please allow",
      requestedSummary: "add Grace",
      baseHoldsCapacity: true,
    });

    // Global lock(1) + per-lodge lock were taken (two raw statements at least).
    expect(mocks.execRaw.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Exactly the incremental night is reserved, keyed on the new request id.
    expect(mocks.peUpsert).toHaveBeenCalledTimes(1);
    const upsert = mocks.peUpsert.mock.calls[0][0];
    expect(upsert.where.changeRequestId_night.changeRequestId).toBe("bcr-1");
    expect(upsert.create).toMatchObject({
      changeRequestId: "bcr-1",
      lodgeId: "lodge_1",
      beds: 1,
    });
    // The live booking is never touched.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("a HOLD modification with no added beds reserves NOTHING (only shrinks/holds)", async () => {
    // base === proposed: the live booking already holds every bed, so the
    // incremental reservation is empty even though the aggregate mode is HOLD.
    await createModificationExceptionRequest({
      requestedByMemberId: "m1",
      bookingId: "booking-1",
      lodgeId: "lodge_1",
      base,
      proposed: base,
      memberMessage: "please allow",
      requestedSummary: "no-op footprint",
      baseHoldsCapacity: true,
    });
    expect(mocks.bcrCreate).toHaveBeenCalledTimes(1);
    expect(mocks.peUpsert).not.toHaveBeenCalled();
    // #2553: it also gets NO hold deadline. Nothing is stranded, so the reaper
    // must have no licence to close this request behind the member's back.
    // Mutation guard: gate the stamp on `holdsCapacity` instead of `reservesBeds`
    // and this reddens.
    expect(mocks.bcrCreate.mock.calls[0][0].data.holdExpiresAt).toBeNull();
  });

  it("#2553: a bed-holding modification is stamped with an immutable hold deadline", async () => {
    // The suite runs on the frozen clock (2026-07-01T00:00:00.000Z) and the
    // proposal's only night is 2026-07-04, so the 7-day TTL is capped by the
    // first held night: 2026-07-04 00:00 Pacific/Auckland = 2026-07-03T12:00Z.
    const proposed = {
      checkIn: "2026-07-04",
      checkOut: "2026-07-05",
      guests: [
        { firstName: "Ada", lastName: "Lovelace", ageTier: "ADULT", isMember: true, memberId: "m1", nights: ["2026-07-04"] },
        { firstName: "Grace", lastName: "Hopper", ageTier: "ADULT", isMember: false, memberId: null, nights: ["2026-07-04"] },
      ],
    };

    await createModificationExceptionRequest({
      requestedByMemberId: "m1",
      bookingId: "booking-1",
      lodgeId: "lodge_1",
      base,
      proposed,
      memberMessage: "please allow",
      requestedSummary: "add Grace",
      baseHoldsCapacity: true,
    });

    const holdExpiresAt = mocks.bcrCreate.mock.calls[0][0].data.holdExpiresAt;
    expect(holdExpiresAt).toBeInstanceOf(Date);
    expect((holdExpiresAt as Date).toISOString()).toBe("2026-07-03T12:00:00.000Z");
  });

  it("supersede RELEASES the prior request's hold before reserving the replacement", async () => {
    const proposed = {
      checkIn: "2026-07-04",
      checkOut: "2026-07-05",
      guests: [
        { firstName: "Ada", lastName: "Lovelace", ageTier: "ADULT", isMember: true, memberId: "m1", nights: ["2026-07-04"] },
        { firstName: "Grace", lastName: "Hopper", ageTier: "ADULT", isMember: false, memberId: null, nights: ["2026-07-04"] },
      ],
    };

    await createModificationExceptionRequest({
      requestedByMemberId: "m1",
      bookingId: "booking-1",
      lodgeId: "lodge_1",
      base,
      proposed,
      memberMessage: "please allow",
      requestedSummary: "resubmit",
      supersedeRequestId: "old-9",
      baseHoldsCapacity: true,
    });

    // The old request's provisional reservation is released atomically...
    expect(mocks.peDeleteMany).toHaveBeenCalledWith({
      where: { changeRequestId: "old-9" },
    });
    // ...and the replacement takes its own incremental hold.
    expect(mocks.peUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.peUpsert.mock.calls[0][0].create.changeRequestId).toBe("bcr-1");
  });

  it("FIX 6: the supersede claim is SCOPED to the same bookingId", async () => {
    // #2525 FIX 6: the supersede runs under only the NEW request's lodge lock, so
    // it must only ever release a prior request on the SAME booking/lodge. The
    // guarded claim is scoped to bookingId; a request on another booking claims 0
    // rows (a lost claim) and is never cross-released under the wrong lock.
    const supersedeClaim = mocks.bcrUpdateMany;
    await createModificationExceptionRequest({
      requestedByMemberId: "m1",
      bookingId: "booking-1",
      lodgeId: "lodge_1",
      base,
      proposed: base,
      memberMessage: "please allow",
      requestedSummary: "resubmit",
      supersedeRequestId: "old-9",
      baseHoldsCapacity: true,
    });
    // The FIRST updateMany is the supersede claim; its where must scope bookingId.
    expect(supersedeClaim.mock.calls[0][0].where).toMatchObject({
      id: "old-9",
      bookingId: "booking-1",
      requestedByMemberId: "m1",
      kind: "POLICY_EXCEPTION",
      status: "REQUESTED",
    });
  });

  it("FIX 4: an over-capacity hold is REFUSED and never written", async () => {
    // #2525 FIX 4: the lodge is full for the incremental beds. The request must be
    // refused with a typed capacity error, and NOTHING may be written — no request
    // row, no reservation.
    mocks.checkCapacity.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [],
    });
    const proposed = {
      checkIn: "2026-07-04",
      checkOut: "2026-07-05",
      guests: [
        { firstName: "Ada", lastName: "Lovelace", ageTier: "ADULT", isMember: true, memberId: "m1", nights: ["2026-07-04"] },
        { firstName: "Grace", lastName: "Hopper", ageTier: "ADULT", isMember: false, memberId: null, nights: ["2026-07-04"] },
      ],
    };
    await expect(
      createModificationExceptionRequest({
        requestedByMemberId: "m1",
        bookingId: "booking-1",
        lodgeId: "lodge_1",
        base,
        proposed,
        memberMessage: "please allow",
        requestedSummary: "add Grace",
        baseHoldsCapacity: true,
      }),
    ).rejects.toBeInstanceOf(PolicyExceptionCapacityUnavailableError);
    // Mutation guard: without the admission check the row is created and the
    // over-capacity beds are reserved — both must be absent here.
    expect(mocks.bcrCreate).not.toHaveBeenCalled();
    expect(mocks.peUpsert).not.toHaveBeenCalled();
    // The admission check ran under the lock (excluding the live booking).
    expect(mocks.checkCapacity).toHaveBeenCalledTimes(1);
    expect(mocks.checkCapacity.mock.calls[0][0]).toBe("lodge_1");
    expect(mocks.checkCapacity.mock.calls[0][4]).toBe("booking-1"); // excludeBookingId
  });

  it("FIX 7: a NON-capacity-holding base reserves the FULL proposed footprint", async () => {
    // #2525 FIX 7: a DRAFT / generic-PENDING / un-held base holds no beds of its
    // own, so the request must reserve the FULL proposed footprint — not the delta
    // over a base that reserves nothing. Here base === proposed (one guest, one
    // night): with a holding base the incremental hold is empty, but with a
    // NON-holding base the full one bed must be reserved.
    await createModificationExceptionRequest({
      requestedByMemberId: "m1",
      bookingId: "booking-1",
      lodgeId: "lodge_1",
      base,
      proposed: base,
      memberMessage: "please allow",
      requestedSummary: "draft edit",
      baseHoldsCapacity: false,
    });
    // Mutation guard: revert the baseHoldsCapacity:false branch and this reserves
    // nothing (incremental of base===proposed is empty) → the assertion reddens.
    expect(mocks.peUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.peUpsert.mock.calls[0][0].create).toMatchObject({
      changeRequestId: "bcr-1",
      lodgeId: "lodge_1",
      beds: 1,
    });
  });
});

describe("cancelModificationExceptionRequest (guarded transition)", () => {
  it("claims REQUESTED->CANCELLED scoped to owner + booking + POLICY_EXCEPTION, returns true", async () => {
    mocks.bcrUpdateMany.mockResolvedValue({ count: 1 });
    const ok = await cancelModificationExceptionRequest({
      id: "bcr-1",
      bookingId: "booking-1",
      requestedByMemberId: "m1",
    });
    expect(ok).toBe(true);

    const call = mocks.bcrUpdateMany.mock.calls[0][0];
    // Mutation guard: the transition MUST also be gated on the request's own
    // bookingId, so a request reached via the wrong booking URL cannot be
    // claimed (and its audit cannot be mislabelled with that URL's booking).
    expect(call.where).toMatchObject({
      id: "bcr-1",
      bookingId: "booking-1",
      requestedByMemberId: "m1",
      kind: "POLICY_EXCEPTION",
      status: "REQUESTED",
    });
    expect(call.data).toMatchObject({ status: "CANCELLED", openStateKey: null });
    // #2525: a landed cancel RELEASES the request's provisional reservation
    // atomically, under the global lock(1) taken first.
    expect(mocks.execRaw).toHaveBeenCalled();
    expect(mocks.peDeleteMany).toHaveBeenCalledWith({
      where: { changeRequestId: "bcr-1" },
    });
  });

  it("returns false (lost claim) when the URL bookingId does not match the request's booking", async () => {
    // A real DB claim scoped by bookingId matches 0 rows when request R (booking
    // B1) is reached via /bookings/B2/... -> false, so the route runs NO side
    // effect (no CANCELLED write, no mislabelled audit).
    mocks.bcrUpdateMany.mockResolvedValue({ count: 0 });
    const ok = await cancelModificationExceptionRequest({
      id: "bcr-1",
      bookingId: "booking-2",
      requestedByMemberId: "m1",
    });
    expect(ok).toBe(false);
    // #2525 mutation guard: a lost claim releases NOTHING.
    expect(mocks.peDeleteMany).not.toHaveBeenCalled();
  });
});

describe("buildModificationProposalParties (pure)", () => {
  const liveGuests = [
    {
      id: "g1",
      firstName: "Ada",
      lastName: "Lovelace",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      stayStart: parseDateOnly("2026-07-04"),
      stayEnd: parseDateOnly("2026-07-06"),
    },
    {
      id: "g2",
      firstName: "Grace",
      lastName: "Hopper",
      ageTier: "ADULT",
      isMember: false,
      memberId: null,
      stayStart: parseDateOnly("2026-07-04"),
      stayEnd: parseDateOnly("2026-07-06"),
    },
  ];

  it("base reflects live nights; removing a guest drops them from proposed only", () => {
    const { base, proposed } = buildModificationProposalParties({
      bookingCheckIn: parseDateOnly("2026-07-04"),
      bookingCheckOut: parseDateOnly("2026-07-06"),
      liveGuests,
      delta: { removeGuestIds: ["g2"] },
    });
    expect(base.guests).toHaveLength(2);
    expect(proposed.guests).toHaveLength(1);
    expect(proposed.guests[0].lastName).toBe("Lovelace");
    // Unchanged dates keep the live per-guest nights.
    expect(proposed.guests[0].nights).toEqual(["2026-07-04", "2026-07-05"]);
  });

  it("a date change resets remaining guests to the new envelope", () => {
    const { proposed } = buildModificationProposalParties({
      bookingCheckIn: parseDateOnly("2026-07-04"),
      bookingCheckOut: parseDateOnly("2026-07-06"),
      liveGuests: [liveGuests[0]],
      delta: { checkOut: "2026-07-07" },
    });
    expect(proposed.checkOut).toBe("2026-07-07");
    expect(proposed.guests[0].nights).toEqual(["2026-07-04", "2026-07-05", "2026-07-06"]);
  });
});

describe("evaluateProposalPartyViolations", () => {
  it("combines minimum-stay and adult-member hosting violations", async () => {
    mocks.validateMinimumStay.mockResolvedValue({ valid: false, violations: [minStayViolation()] });
    mocks.evaluateHosting.mockResolvedValue({
      reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
      policyId: "pol_host",
      policyVersion: 1,
      policyName: "Hosting",
      resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge_1" },
      affectedNights: ["2026-07-04"],
      exceptionEligible: true,
      capacityMode: "NO_HOLD",
      message: "hosting",
      requirements: {
        kind: "ADULT_MEMBER_HOSTING",
        requiredAdultMemberParticipantsPerGuestNight: 1,
        uncoveredNonMemberGuestNights: 1,
        uncovered: [],
        qualifyingHostsByNight: [],
      },
    });

    const violations = await evaluateProposalPartyViolations(
      // The mocked prisma is injected; cast satisfies the strict param type.
      {} as never,
      "lodge_1",
      { checkIn: "2026-07-04", checkOut: "2026-07-05", guests: [] },
    );
    expect(violations.map((v) => v.reasonCode).sort()).toEqual([
      "ADULT_MEMBER_HOSTING_REQUIRED",
      "MINIMUM_STAY",
    ]);
  });
});

describe("readUnifiedExceptionQueue (merges both sources)", () => {
  it("merges new-booking + modification rows, newest first, with one envelope", async () => {
    mocks.nbFindMany.mockResolvedValue([
      {
        id: "nb-1",
        status: "REQUESTED",
        createdAt: new Date("2026-07-10T00:00:00Z"),
        updatedAt: new Date("2026-07-10T00:00:00Z"),
        lodgeId: "lodge_1",
        requestedBy: { id: "m1", firstName: "Ada", lastName: "Lovelace", email: "a@x.nz" },
        reviewedBy: null,
        reviewedAt: null,
        memberMessage: "hi",
        proposalHash: "a".repeat(64),
        aggregateCapacityMode: "HOLD",
        frozenEvidence: { reasonCodes: ["MINIMUM_STAY"], affectedNights: ["2026-07-04"] },
        attemptCount: 1,
        conflictCount: 0,
        lastConflictAt: null,
        lastConflictReason: null,
        supersededByRequestId: null,
      },
    ]);
    mocks.bcrFindMany.mockResolvedValue([
      {
        id: "bcr-1",
        status: "REQUESTED",
        createdAt: new Date("2026-07-11T00:00:00Z"),
        updatedAt: new Date("2026-07-11T00:00:00Z"),
        bookingId: "booking-9",
        requestedBy: { id: "m2", firstName: "Grace", lastName: "Hopper", email: "g@x.nz" },
        reviewedBy: null,
        reviewedAt: null,
        memberMessage: "yo",
        proposalHash: "b".repeat(64),
        aggregateCapacityMode: "NO_HOLD",
        frozenEvidence: { reasonCodes: ["ADULT_MEMBER_HOSTING_REQUIRED"], affectedNights: [] },
        attemptCount: 1,
        conflictCount: 0,
        lastConflictAt: null,
        lastConflictReason: null,
        supersededByRequestId: null,
        requestedChanges: { requested: { summary: "check-out to 2026-07-12" } },
      },
    ]);

    const result = await readUnifiedExceptionQueue({ status: "REQUESTED", page: 1, pageSize: 25 });

    expect(result.total).toBe(2);
    expect(result.data[0]).toMatchObject({ source: "MODIFICATION", id: "bcr-1", summary: "check-out to 2026-07-12" });
    expect(result.data[1]).toMatchObject({ source: "NEW_BOOKING", id: "nb-1", reasonCodes: ["MINIMUM_STAY"] });
    // Modification source filters on kind POLICY_EXCEPTION.
    expect(mocks.bcrFindMany.mock.calls[0][0].where).toMatchObject({ kind: "POLICY_EXCEPTION", status: "REQUESTED" });
  });
});
