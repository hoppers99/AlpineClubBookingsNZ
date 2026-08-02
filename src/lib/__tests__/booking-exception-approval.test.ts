import { beforeEach, describe, expect, it, vi } from "vitest";

// The approval hooks compose the real capacity engine, the real canonical
// booking services and the real hosting reconciler. Each is mocked here so the
// tests assert the CONTRACT this module owes them — which arguments it passes,
// and what it does with each answer — rather than re-testing their internals.
const checkCapacityForGuestRanges = vi.fn();
vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: (...args: unknown[]) =>
    checkCapacityForGuestRanges(...args),
  acquireLodgeCapacityLock: vi.fn(async () => undefined),
}));

const createConfirmedBooking = vi.fn();
vi.mock("@/lib/booking-create", () => ({
  createConfirmedBooking: (...args: unknown[]) => createConfirmedBooking(...args),
}));

const modifyBookingBatch = vi.fn();
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: (...args: unknown[]) => modifyBookingBatch(...args),
}));

const recordAdultMemberHostingReviewDecision = vi.fn();
vi.mock("@/lib/adult-member-hosting-review", () => ({
  recordAdultMemberHostingReviewDecision: (...args: unknown[]) =>
    recordAdultMemberHostingReviewDecision(...args),
  evaluateProposedAdultMemberHosting: vi.fn(async () => null),
}));

const getNonMemberHoldPolicy = vi.fn();
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldPolicy: (...args: unknown[]) => getNonMemberHoldPolicy(...args),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  buildPolicyExceptionApprovalHooks,
  buildOverrideReason,
  proposalGuestToCreateInput,
  reauthorizeBookingOfficerFromDb,
  resolveNewBookingExecutionParams,
  PolicyExceptionExecutionCapacityError,
  PolicyExceptionUnverifiedExecutionError,
} from "@/lib/booking-exception-approval";
import {
  computeProposalHash,
  formatPolicyExceptionRequestAge,
  type ModificationProposalSnapshot,
  type NewBookingProposalSnapshot,
} from "@/lib/booking-exception-requests";
import { buildModificationProposalParties } from "@/lib/booking-exception-request-service";
import type { ConfirmedOverride } from "@/lib/booking-exception-execution";

const LODGE = "lodge-a";
const OFFICER = "officer-1";

const LIVE_GUEST = {
  id: "g-1",
  firstName: "Ada",
  lastName: "Lovelace",
  ageTier: "ADULT",
  isMember: true,
  memberId: "m-1",
  stayStart: new Date("2026-07-01T00:00:00.000Z"),
  stayEnd: new Date("2026-07-03T00:00:00.000Z"),
};

const DELTA = {
  addGuests: [
    {
      firstName: "Grace",
      lastName: "Hopper",
      ageTier: "ADULT",
      isMember: false,
    },
  ],
};

/** The MODIFICATION snapshot the member's request would have frozen. */
function frozenModificationSnapshot(): ModificationProposalSnapshot {
  const { base, proposed } = buildModificationProposalParties({
    bookingCheckIn: new Date("2026-07-01T00:00:00.000Z"),
    bookingCheckOut: new Date("2026-07-03T00:00:00.000Z"),
    liveGuests: [LIVE_GUEST],
    delta: DELTA,
  });
  return {
    kind: "MODIFICATION",
    lodgeId: LODGE,
    bookingId: "bk-1",
    base,
    proposed,
  };
}

const NEW_BOOKING_SNAPSHOT: NewBookingProposalSnapshot = {
  kind: "NEW_BOOKING",
  lodgeId: LODGE,
  proposed: {
    checkIn: "2026-07-01",
    checkOut: "2026-07-03",
    guests: [
      {
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m-1",
        nights: ["2026-07-01", "2026-07-02"],
      },
    ],
  },
};

function makeTx(over: Record<string, unknown> = {}) {
  return {
    member: { findUnique: vi.fn(async () => null) },
    booking: {
      findUnique: vi.fn(async () => ({
        checkIn: new Date("2026-07-01T00:00:00.000Z"),
        checkOut: new Date("2026-07-03T00:00:00.000Z"),
        guests: [LIVE_GUEST],
      })),
    },
    bookingChangeRequest: {
      findUnique: vi.fn(async () => ({
        requestedChanges: { source: "POLICY_EXCEPTION", delta: DELTA },
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    newBookingPolicyExceptionRequest: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    ...over,
  } as never;
}

function loadedRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    status: "REQUESTED" as const,
    kind: "POLICY_EXCEPTION" as const,
    version: 1,
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    proposalHash: "hash",
    frozenEvidence: {},
    aggregateCapacityMode: "HOLD" as const,
    ...overrides,
  } as never;
}

const NO_OVERRIDE: ConfirmedOverride = { overridable: [], clearedReviewed: [] };
const MIN_STAY_OVERRIDE: ConfirmedOverride = {
  overridable: [{ reasonCode: "MINIMUM_STAY", policyId: "pol-1" }],
  clearedReviewed: [],
};
const HOSTING_OVERRIDE: ConfirmedOverride = {
  overridable: [
    { reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED", policyId: "host-1" },
  ],
  clearedReviewed: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 5,
    nightDetails: [],
  });
  modifyBookingBatch.mockResolvedValue({ deferredPostCommit: vi.fn() });
  createConfirmedBooking.mockResolvedValue({
    type: "created",
    booking: { id: "bk-new" },
    bumpedBookingIds: [],
    isZeroDollarConfirmed: false,
    deferredPostCommit: vi.fn(),
  });
  recordAdultMemberHostingReviewDecision.mockResolvedValue(true);
  getNonMemberHoldPolicy.mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "period",
  });
});

describe("request age", () => {
  const created = new Date("2026-08-01T00:00:00.000Z");

  it("reads as plain English, not a timestamp", () => {
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-08-01T00:00:30.000Z")),
    ).toBe("just now");
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-08-01T00:40:00.000Z")),
    ).toBe("40 min ago");
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-08-01T05:00:00.000Z")),
    ).toBe("5 hours ago");
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-08-04T00:00:00.000Z")),
    ).toBe("3 days ago");
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-08-22T00:00:00.000Z")),
    ).toBe("3 weeks ago");
  });

  it("never shows a negative age when the clocks disagree", () => {
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-07-31T23:00:00.000Z")),
    ).toBe("just now");
  });
});

describe("reauthorizeBookingOfficerFromDb", () => {
  function db(member: unknown) {
    return { member: { findUnique: vi.fn(async () => member) } } as never;
  }

  it("allows an active officer with bookings edit access", async () => {
    await expect(
      reauthorizeBookingOfficerFromDb(
        db({
          active: true,
          canLogin: true,
          forcePasswordChange: false,
          accessRoles: [{ role: "ADMIN" }],
        }),
        OFFICER,
      ),
    ).resolves.toBe(true);
  });

  it("refuses a deactivated account even though the session guard passed", async () => {
    await expect(
      reauthorizeBookingOfficerFromDb(
        db({
          active: false,
          canLogin: true,
          forcePasswordChange: false,
          accessRoles: [{ role: "ADMIN" }],
        }),
        OFFICER,
      ),
    ).resolves.toBe(false);
  });

  it("refuses an account mid password-reset remediation", async () => {
    await expect(
      reauthorizeBookingOfficerFromDb(
        db({
          active: true,
          canLogin: true,
          forcePasswordChange: true,
          accessRoles: [{ role: "ADMIN" }],
        }),
        OFFICER,
      ),
    ).resolves.toBe(false);
  });

  it("refuses an account whose booking access was revoked since the session was issued", async () => {
    await expect(
      reauthorizeBookingOfficerFromDb(
        db({
          active: true,
          canLogin: true,
          forcePasswordChange: false,
          accessRoles: [],
        }),
        OFFICER,
      ),
    ).resolves.toBe(false);
  });

  it("refuses a member row that no longer exists", async () => {
    await expect(reauthorizeBookingOfficerFromDb(db(null), OFFICER)).resolves.toBe(
      false,
    );
  });
});

describe("recheckCapacity — the #2525 handoff contract", () => {
  it("checks the FULL proposed party and EXCLUDES the live booking for a modification", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    const tx = makeTx();

    await expect(hooks.recheckCapacity(snapshot, tx)).resolves.toEqual({ ok: true });

    const [lodgeId, checkIn, checkOut, ranges, excludeBookingId] =
      checkCapacityForGuestRanges.mock.calls[0];
    expect(lodgeId).toBe(LODGE);
    // The FULL proposed party (both guests), not the delta.
    expect(ranges).toHaveLength(2);
    // Excluding the live booking is what makes the full-party check equivalent
    // to an incremental-headroom check — without it the live base is counted
    // twice and a legitimate approval is falsely kept pending.
    expect(excludeBookingId).toBe("bk-1");
    expect(checkIn.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(checkOut.toISOString().slice(0, 10)).toBe("2026-07-03");
  });

  it("excludes nothing for a new-booking proposal (there is no live booking)", async () => {
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    await hooks.recheckCapacity(NEW_BOOKING_SNAPSHOT, makeTx());
    expect(checkCapacityForGuestRanges.mock.calls[0][4]).toBeUndefined();
  });

  it("reports a shortfall as not-ok with the kept-pending message", async () => {
    checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    const result = await hooks.recheckCapacity(NEW_BOOKING_SNAPSHOT, makeTx());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/stays pending/i);
  });
});

describe("verifyLiveProposalIntegrity", () => {
  it("passes when the stored delta still replays to the reviewed proposal", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    await expect(
      hooks.verifyLiveProposalIntegrity?.(snapshot, makeTx()),
    ).resolves.toBe(true);
  });

  it("FAILS when the live booking drifted since the request was made", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    // Somebody added a guest to the live booking after the request was frozen.
    const tx = makeTx({
      booking: {
        findUnique: vi.fn(async () => ({
          checkIn: new Date("2026-07-01T00:00:00.000Z"),
          checkOut: new Date("2026-07-03T00:00:00.000Z"),
          guests: [
            LIVE_GUEST,
            { ...LIVE_GUEST, id: "g-2", firstName: "Alan", lastName: "Turing" },
          ],
        })),
      },
    });
    await expect(hooks.verifyLiveProposalIntegrity?.(snapshot, tx)).resolves.toBe(
      false,
    );
  });

  it("FAILS when the stored delta was tampered with", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    const tx = makeTx({
      bookingChangeRequest: {
        findUnique: vi.fn(async () => ({
          requestedChanges: {
            delta: {
              addGuests: [
                {
                  firstName: "Grace",
                  lastName: "Hopper",
                  ageTier: "ADULT",
                  isMember: false,
                },
                {
                  firstName: "Smuggled",
                  lastName: "Guest",
                  ageTier: "ADULT",
                  isMember: false,
                },
              ],
            },
          },
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    await expect(hooks.verifyLiveProposalIntegrity?.(snapshot, tx)).resolves.toBe(
      false,
    );
  });

  it("FAILS when the request carries no replayable delta at all", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    const tx = makeTx({
      bookingChangeRequest: {
        findUnique: vi.fn(async () => ({ requestedChanges: { requested: {} } })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    await expect(hooks.verifyLiveProposalIntegrity?.(snapshot, tx)).resolves.toBe(
      false,
    );
  });

  it("FAILS when the live booking has vanished", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    const tx = makeTx({ booking: { findUnique: vi.fn(async () => null) } });
    await expect(hooks.verifyLiveProposalIntegrity?.(snapshot, tx)).resolves.toBe(
      false,
    );
  });

  it("passes a new-booking proposal through — it has no live base to drift", async () => {
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    await expect(
      hooks.verifyLiveProposalIntegrity?.(NEW_BOOKING_SNAPSHOT, makeTx()),
    ).resolves.toBe(true);
  });
});

describe("executeApprovedProposal — modification", () => {
  async function runExecution(override: ConfirmedOverride) {
    const snapshot = frozenModificationSnapshot();
    const { hooks, outcome } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
      adminNotes: "Long-standing member, one-off.",
    });
    const tx = makeTx();
    // The engine always runs the integrity hook first; it is what seeds the
    // verified delta the executor replays.
    await hooks.verifyLiveProposalIntegrity?.(snapshot, tx);
    const result = await hooks.executeApprovedProposal({
      tx,
      request: loadedRequest({ proposalHash: computeProposalHash(snapshot) }),
      snapshot,
      override,
    });
    return { result, outcome, tx };
  }

  it("runs the canonical service on the approval transaction with a HARD capacity refusal", async () => {
    await runExecution(MIN_STAY_OVERRIDE);
    const call = modifyBookingBatch.mock.calls[0][0];
    expect(call.bookingId).toBe("bk-1");
    // ADMIN is what applies the reviewed minimum-stay override.
    expect(call.actor).toEqual({ id: OFFICER, role: "ADMIN" });
    // The two capacity-widening switches are NEVER set by an approval.
    expect(call.input.confirmOverCapacity).toBeUndefined();
    expect(call.input.adminOverride).toBeUndefined();
    // It runs INSIDE the approval transaction — no mark-approved-then-call gap.
    expect(call.tx).toBeDefined();
  });

  it("replays exactly the verified delta", async () => {
    await runExecution(MIN_STAY_OVERRIDE);
    const { input } = modifyBookingBatch.mock.calls[0][0];
    expect(input.addGuests).toEqual([
      {
        firstName: "Grace",
        lastName: "Hopper",
        ageTier: "ADULT",
        isMember: false,
        stayStart: null,
        stayEnd: null,
      },
    ]);
  });

  it("records the officer's hosting decision when that rule was overridden", async () => {
    const { outcome } = await runExecution(HOSTING_OVERRIDE);
    expect(recordAdultMemberHostingReviewDecision).toHaveBeenCalledTimes(1);
    const [bookingId, , decision] =
      recordAdultMemberHostingReviewDecision.mock.calls[0];
    expect(bookingId).toBe("bk-1");
    expect(decision.byMemberId).toBe(OFFICER);
    // D-R4: attributable, and it says which rule and which request.
    expect(decision.reason).toContain("ADULT_MEMBER_HOSTING_REQUIRED");
    expect(decision.reason).toContain("req-1");
    expect(outcome.hostingDecisionRecorded).toBe(true);
  });

  it("does NOT touch the hosting review when that rule was not overridden", async () => {
    await runExecution(MIN_STAY_OVERRIDE);
    expect(recordAdultMemberHostingReviewDecision).not.toHaveBeenCalled();
  });

  it("refuses to execute without a verified delta (fails loudly, never silently)", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    await expect(
      hooks.executeApprovedProposal({
        tx: makeTx(),
        request: loadedRequest(),
        snapshot,
        override: NO_OVERRIDE,
      }),
    ).rejects.toBeInstanceOf(PolicyExceptionUnverifiedExecutionError);
    expect(modifyBookingBatch).not.toHaveBeenCalled();
  });
});

describe("executeApprovedProposal — new booking", () => {
  function hooksFor(adminNotes?: string) {
    return buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
      adminNotes,
      newBookingExecution: {
        status: "PAYMENT_PENDING" as never,
        shouldBePending: false,
        holdDays: 0,
        paymentMethod: "stripe",
      },
    });
  }

  it("creates the reviewed booking on the approval transaction, with capacity HARD", async () => {
    const { hooks, outcome } = hooksFor();
    const tx = makeTx();
    await hooks.executeApprovedProposal({
      tx,
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot: NEW_BOOKING_SNAPSHOT,
      override: MIN_STAY_OVERRIDE,
    });
    const input = createConfirmedBooking.mock.calls[0][0];
    expect(input.effectiveMemberId).toBe("m-1");
    expect(input.sessionUserId).toBe(OFFICER);
    expect(input.isOnBehalf).toBe(true);
    expect(input.confirmOverCapacity).toBeUndefined();
    expect(input.waitlistIntent).toBeUndefined();
    expect(input.tx).toBeDefined();
    // The frozen night set survives the round-trip explicitly (#713).
    expect(input.guests[0].nights).toEqual([
      { stayDate: "2026-07-01" },
      { stayDate: "2026-07-02" },
    ]);
    expect(outcome.createdBookingId).toBe("bk-new");
    // The executed booking is linked back onto the request row in the same tx.
    expect(
      tx.newBookingPolicyExceptionRequest.updateMany.mock.calls[0][0].data
        .createdBookingId,
    ).toBe("bk-new");
  });

  it("THROWS on capacityExceeded so the whole approval rolls back", async () => {
    createConfirmedBooking.mockResolvedValue({
      type: "capacityExceeded",
      fullNights: ["2026-07-01"],
    });
    const { hooks, outcome } = hooksFor();
    await expect(
      hooks.executeApprovedProposal({
        tx: makeTx(),
        request: loadedRequest({ bookingId: null, kind: null }),
        snapshot: NEW_BOOKING_SNAPSHOT,
        override: MIN_STAY_OVERRIDE,
      }),
    ).rejects.toBeInstanceOf(PolicyExceptionExecutionCapacityError);
    // Nothing was recorded as executed: the request must not look approved.
    expect(outcome.createdBookingId).toBeNull();
  });

  it("passes the hosting reason only when that rule was actually overridden", async () => {
    const { hooks } = hooksFor("Parents are staying in the next room.");
    await hooks.executeApprovedProposal({
      tx: makeTx(),
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot: NEW_BOOKING_SNAPSHOT,
      override: HOSTING_OVERRIDE,
    });
    expect(createConfirmedBooking.mock.calls[0][0].adultMemberHostingReason).toContain(
      "Parents are staying in the next room.",
    );

    createConfirmedBooking.mockClear();
    const second = hooksFor("note");
    await second.hooks.executeApprovedProposal({
      tx: makeTx(),
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot: NEW_BOOKING_SNAPSHOT,
      override: MIN_STAY_OVERRIDE,
    });
    expect(
      createConfirmedBooking.mock.calls[0][0].adultMemberHostingReason,
    ).toBeUndefined();
  });

  it("refuses to execute without resolved execution parameters", async () => {
    const { hooks } = buildPolicyExceptionApprovalHooks({
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    await expect(
      hooks.executeApprovedProposal({
        tx: makeTx(),
        request: loadedRequest({ bookingId: null, kind: null }),
        snapshot: NEW_BOOKING_SNAPSHOT,
        override: NO_OVERRIDE,
      }),
    ).rejects.toBeInstanceOf(PolicyExceptionUnverifiedExecutionError);
    expect(createConfirmedBooking).not.toHaveBeenCalled();
  });
});

describe("proposalGuestToCreateInput", () => {
  it("keeps a non-contiguous stay intact and derives its envelope", () => {
    const guest = proposalGuestToCreateInput({
      firstName: "Ada",
      lastName: "Lovelace",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m-1",
      nights: ["2026-07-04", "2026-07-01"],
    });
    expect(guest.nights).toEqual([
      { stayDate: "2026-07-01" },
      { stayDate: "2026-07-04" },
    ]);
    expect(guest.stayStart.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(guest.stayEnd.toISOString().slice(0, 10)).toBe("2026-07-05");
  });

  it("refuses a non-bookable age tier rather than coercing it", () => {
    expect(() =>
      proposalGuestToCreateInput({
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "NOT_A_TIER",
        isMember: true,
        memberId: null,
        nights: ["2026-07-01"],
      }),
    ).toThrow(/non-bookable age tier/);
  });

  it("refuses a guest who occupies no nights", () => {
    expect(() =>
      proposalGuestToCreateInput({
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        isMember: true,
        memberId: null,
        nights: [],
      }),
    ).toThrow(/no nights/);
  });
});

describe("resolveNewBookingExecutionParams", () => {
  it("uses the club's hold policy for a party with non-members", async () => {
    const snapshot: NewBookingProposalSnapshot = {
      ...NEW_BOOKING_SNAPSHOT,
      proposed: {
        ...NEW_BOOKING_SNAPSHOT.proposed,
        guests: [
          { ...NEW_BOOKING_SNAPSHOT.proposed.guests[0], isMember: false, memberId: null },
        ],
      },
    };
    const params = await resolveNewBookingExecutionParams(snapshot);
    expect(getNonMemberHoldPolicy).toHaveBeenCalled();
    expect(params.holdDays).toBe(7);
    expect(params.paymentMethod).toBe("stripe");
  });

  it("does not read the hold policy for an all-member party", async () => {
    const params = await resolveNewBookingExecutionParams(NEW_BOOKING_SNAPSHOT);
    expect(getNonMemberHoldPolicy).not.toHaveBeenCalled();
    expect(params.shouldBePending).toBe(false);
    expect(params.holdDays).toBe(0);
  });
});

describe("buildOverrideReason", () => {
  it("names the request and every rule still being overridden", () => {
    expect(
      buildOverrideReason({
        requestId: "req-9",
        override: MIN_STAY_OVERRIDE,
        adminNotes: "Agreed at committee.",
      }),
    ).toBe(
      "Booking-policy exception approved (request req-9): MINIMUM_STAY. Agreed at committee.",
    );
  });

  it("is still attributable when the officer left no note", () => {
    expect(
      buildOverrideReason({ requestId: "req-9", override: MIN_STAY_OVERRIDE }),
    ).toContain("request req-9");
  });
});
