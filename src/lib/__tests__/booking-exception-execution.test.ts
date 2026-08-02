import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveAndExecutePolicyExceptionRequest,
  PolicyExceptionIntegrityHookMissingError,
  resolvePolicyExceptionRequestTerminal,
  type PolicyExceptionApprovalHooks,
} from "@/lib/booking-exception-execution";
import {
  computeProposalHash,
  freezePolicyExceptionEvidence,
  type ModificationProposalSnapshot,
  type NewBookingProposalSnapshot,
} from "@/lib/booking-exception-requests";
import type { MinimumStayPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";

const LODGE = "lodge-a";

const SNAPSHOT: NewBookingProposalSnapshot = {
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

// A MODIFICATION snapshot: its frozen `base` party can drift from the live
// booking, so the live-integrity hook is the only gate that catches that drift.
const MOD_SNAPSHOT: ModificationProposalSnapshot = {
  kind: "MODIFICATION",
  lodgeId: LODGE,
  bookingId: "bk-1",
  base: {
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
      {
        firstName: "Grace",
        lastName: "Hopper",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        nights: ["2026-07-01", "2026-07-02"],
      },
    ],
  },
};
const MOD_HASH = computeProposalHash(MOD_SNAPSHOT);

function minStay(
  policyId = "pol-1",
  version = 1,
  nights = ["2026-07-01"],
  minimumNights = 2,
): MinimumStayPolicyExceptionViolation {
  return {
    reasonCode: "MINIMUM_STAY",
    policyId,
    policyVersion: version,
    policyName: "Weekend minimum stay",
    resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: LODGE },
    affectedNights: nights,
    exceptionEligible: true,
    capacityMode: "HOLD",
    message: "Two-night minimum on weekends.",
    triggerDay: nights[0],
    minimumNights,
    actualNights: 1,
    requirements: {
      kind: "MINIMUM_STAY",
      minimumNights,
      actualNights: 1,
      triggerDays: [6],
    },
  };
}

const REVIEWED = minStay();
const EVIDENCE = freezePolicyExceptionEvidence([REVIEWED]);
const HASH = computeProposalHash(SNAPSHOT);

type RowOverrides = Partial<{
  status: string;
  version: number;
  kind: string;
  proposalHash: string | null;
  aggregateCapacityMode: string | null;
  // #2553: the refusal tests need a snapshot the parser rejects, so the shape is
  // deliberately open here rather than the parsed snapshot type.
  proposalSnapshot: unknown;
}>;

function baseRow(overrides: RowOverrides = {}) {
  return {
    id: "req-1",
    status: "REQUESTED",
    kind: "POLICY_EXCEPTION",
    version: 1,
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    proposalSnapshot: SNAPSHOT,
    proposalHash: HASH,
    frozenEvidence: EVIDENCE,
    aggregateCapacityMode: "HOLD",
    ...overrides,
  };
}

/** A fake transaction client + an ordered activity log. */
function makeDb(opts: {
  row: ReturnType<typeof baseRow> | null;
  claimCount?: number;
  bumpCount?: number;
  releaseCount?: number;
}) {
  const order: string[] = [];
  // #2553: `where` is part of the recorded call shape too — the EXPIRED test
  // asserts the guarded claim is scoped to REQUESTED + the exact version, so the
  // mock's parameter type has to admit it.
  const updateMany = vi.fn(async ({
    data,
  }: {
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => {
    if (data.status === "APPROVED") {
      order.push("claim-approved");
      return { count: opts.claimCount ?? 1 };
    }
    if (
      data.status === "REJECTED" ||
      data.status === "CANCELLED" ||
      data.status === "SUPERSEDED" ||
      data.status === "EXPIRED"
    ) {
      order.push(`claim-${String(data.status).toLowerCase()}`);
      return { count: opts.claimCount ?? 1 };
    }
    order.push("conflict-bump");
    return { count: opts.bumpCount ?? 1 };
  });
  const deleteMany = vi.fn(async () => {
    order.push("release");
    return { count: opts.releaseCount ?? 2 };
  });
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      order.push(sql.includes("hashtextextended") ? "lodge-lock" : "global-lock");
      return 1;
    }),
    bookingChangeRequest: {
      findUnique: vi.fn(async () => opts.row),
      updateMany,
    },
    policyExceptionReservationNight: { deleteMany },
  };
  const db = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const result = await fn(tx);
      order.push("commit");
      return result;
    }),
  };
  return { db, tx, order, updateMany, deleteMany };
}

function makeHooks(
  over: Partial<PolicyExceptionApprovalHooks> = {},
  order?: string[],
): PolicyExceptionApprovalHooks {
  return {
    reauthorizeBookingOfficer: vi.fn(async () => true),
    evaluateCurrentViolations: vi.fn(async () => [minStay()]),
    recheckCapacity: vi.fn(async () => ({ ok: true })),
    executeApprovedProposal: vi.fn(async () => {
      order?.push("execute");
      return {
        deferredPostCommit: vi.fn(async () => {
          order?.push("deferred");
        }),
      };
    }),
    notifyApproved: vi.fn(async () => {
      order?.push("notify");
    }),
    ...over,
  };
}

describe("approveAndExecutePolicyExceptionRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("HOLD happy path: locks global→lodge, claims, releases, executes, then post-commit", async () => {
    const { db, order } = makeDb({ row: baseRow() });
    const hooks = makeHooks({}, order);
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });

    expect(result).toEqual({ outcome: "executed", requestId: "req-1" });
    // Lock order, claim, atomic release + execute in-tx, THEN post-commit.
    expect(order).toEqual([
      "global-lock",
      "lodge-lock",
      "claim-approved",
      "release",
      "execute",
      "commit",
      "deferred",
      "notify",
    ]);
    // The executor received the tx and the override (still-tripping reviewed rule).
    const call = (hooks.executeApprovedProposal as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.override.overridable).toEqual([
      { reasonCode: "MINIMUM_STAY", policyId: "pol-1" },
    ]);
    expect(call.override.clearedReviewed).toEqual([]);
  });

  it("NOT AUTHORIZED: fresh-role refusal writes nothing and executes nothing", async () => {
    const { db, order, updateMany, deleteMany } = makeDb({ row: baseRow() });
    const hooks = makeHooks({ reauthorizeBookingOfficer: vi.fn(async () => false) });
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "attacker",
      hooks,
      db: db as never,
    });
    expect(result).toEqual({ outcome: "notAuthorized" });
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(hooks.executeApprovedProposal).not.toHaveBeenCalled();
    // Locks were still acquired before the auth check (order matters for safety).
    expect(order.slice(0, 2)).toEqual(["global-lock", "lodge-lock"]);
  });

  it("LOST CLAIM (stale version): no execution, no release", async () => {
    const { db, deleteMany } = makeDb({ row: baseRow({ version: 7 }) });
    const hooks = makeHooks();
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result).toEqual({ outcome: "claimLost" });
    expect(hooks.executeApprovedProposal).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("LOST CLAIM at the guarded CAS (updateMany count 0): no release, no execute", async () => {
    const { db, deleteMany } = makeDb({ row: baseRow(), claimCount: 0 });
    const hooks = makeHooks();
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result).toEqual({ outcome: "claimLost" });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(hooks.executeApprovedProposal).not.toHaveBeenCalled();
  });

  it("PROPOSAL TAMPER: stored hash ≠ recomputed hash → proposalDrift, no side effect", async () => {
    const { db, updateMany, deleteMany } = makeDb({
      row: baseRow({ proposalHash: "deadbeef" }),
    });
    const hooks = makeHooks();
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result.outcome).toBe("proposalDrift");
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(hooks.evaluateCurrentViolations).not.toHaveBeenCalled();
  });

  it("PROPOSAL DRIFT: live-integrity hook fails → proposalDrift", async () => {
    const { db } = makeDb({ row: baseRow() });
    const hooks = makeHooks({
      verifyLiveProposalIntegrity: vi.fn(async () => false),
    });
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result.outcome).toBe("proposalDrift");
    expect(hooks.executeApprovedProposal).not.toHaveBeenCalled();
  });

  it("POLICY DRIFT (a NEW violation appeared): keeps pending, no claim/execute", async () => {
    const { db, updateMany, deleteMany } = makeDb({ row: baseRow() });
    const hooks = makeHooks({
      // Reviewed pol-1 still trips AND a never-reviewed pol-2 now trips.
      evaluateCurrentViolations: vi.fn(async () => [
        minStay("pol-1"),
        minStay("pol-2"),
      ]),
    });
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result.outcome).toBe("policyDrift");
    if (result.outcome === "policyDrift") {
      expect(result.newViolations).toEqual([
        { reasonCode: "MINIMUM_STAY", policyId: "pol-2" },
      ]);
    }
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("DISAPPEARED reviewed rule: executes WITHOUT override, records resolution", async () => {
    const { db } = makeDb({ row: baseRow() });
    const hooks = makeHooks({
      evaluateCurrentViolations: vi.fn(async () => []), // rule switched off
    });
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result).toEqual({ outcome: "executed", requestId: "req-1" });
    const call = (hooks.executeApprovedProposal as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    // Nothing to override; the disappeared rule is recorded as cleared.
    expect(call.override.overridable).toEqual([]);
    expect(call.override.clearedReviewed).toEqual([
      { reasonCode: "MINIMUM_STAY", policyId: "pol-1" },
    ]);
  });

  it("NO_HOLD capacity conflict: keeps pending, bumps conflict, no execute/release", async () => {
    const { db, order, deleteMany } = makeDb({
      row: baseRow({ aggregateCapacityMode: "NO_HOLD" }),
    });
    const hooks = makeHooks({
      recheckCapacity: vi.fn(async () => ({ ok: false, message: "Full." })),
    });
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result).toEqual({ outcome: "keptPendingCapacity", message: "Full." });
    expect(order).toContain("conflict-bump");
    expect(order).not.toContain("claim-approved");
    expect(deleteMany).not.toHaveBeenCalled();
    expect(hooks.executeApprovedProposal).not.toHaveBeenCalled();
  });

  it("NO_HOLD capacity OK: proceeds to execute", async () => {
    const { db } = makeDb({ row: baseRow({ aggregateCapacityMode: "NO_HOLD" }) });
    const hooks = makeHooks();
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result.outcome).toBe("executed");
    expect(hooks.recheckCapacity).toHaveBeenCalledTimes(1);
    expect(hooks.executeApprovedProposal).toHaveBeenCalledTimes(1);
  });

  it("NOT FOUND / wrong kind: no locks taken, no side effect", async () => {
    const { db, order } = makeDb({ row: baseRow({ kind: "LOCKED_PERIOD" }) });
    const hooks = makeHooks();
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result).toEqual({ outcome: "notFound" });
    expect(order).toEqual(["commit"]); // pre-read only, then the tx returns
    expect(hooks.reauthorizeBookingOfficer).not.toHaveBeenCalled();
  });

  it("APPROVE frees the one-open-request slot: the CAS claim nulls openStateKey", async () => {
    // #2525 FIX 1: APPROVED is terminal, so if the approve claim did not null
    // openStateKey the member could never open another policy-exception request
    // on this booking (createModification would P2002 on the unique slot index).
    const { db, updateMany } = makeDb({ row: baseRow() });
    const hooks = makeHooks();
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result).toEqual({ outcome: "executed", requestId: "req-1" });
    const approveClaim = updateMany.mock.calls.find(
      (c) => (c[0] as { data: { status?: string } }).data.status === "APPROVED",
    );
    expect(approveClaim).toBeDefined();
    // Mutation guard: revert `openStateKey: null` on the approve claim and this
    // reddens (the field becomes undefined).
    expect((approveClaim![0] as { data: { openStateKey?: unknown } }).data.openStateKey).toBeNull();
  });

  it("HOLD capacity no longer fits: post-release recheck keeps it pending, never executes", async () => {
    // #2525 FIX 2: a HOLD approval releases its own hold then rechecks real
    // capacity; if the lodge is now full it rolls back to keptPendingCapacity
    // instead of executing an overbooking. Its own beds must not count against it,
    // which is why the recheck runs AFTER the release.
    const { db, order, deleteMany } = makeDb({ row: baseRow() }); // HOLD by default
    const hooks = makeHooks(
      { recheckCapacity: vi.fn(async () => ({ ok: false, message: "No room now." })) },
      order,
    );
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result).toEqual({
      outcome: "keptPendingCapacity",
      message: "No room now.",
    });
    // The recheck ran, and it ran AFTER the release freed the request's own beds.
    expect(hooks.recheckCapacity).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    // Nothing executed and the transaction did NOT commit (rolled back).
    expect(hooks.executeApprovedProposal).not.toHaveBeenCalled();
    expect(order).not.toContain("execute");
    expect(order).not.toContain("commit");
    // Claim + release happened (then rolled back); execute did not.
    expect(order).toContain("claim-approved");
    expect(order).toContain("release");
  });

  it("HOLD capacity still fits: post-release recheck passes and it executes", async () => {
    const { db } = makeDb({ row: baseRow() });
    const hooks = makeHooks(); // recheckCapacity defaults to ok:true
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result.outcome).toBe("executed");
    // HOLD now rechecks capacity too (previously only NO_HOLD did).
    expect(hooks.recheckCapacity).toHaveBeenCalledTimes(1);
    expect(hooks.executeApprovedProposal).toHaveBeenCalledTimes(1);
  });

  it("MODIFICATION with NO live-integrity hook FAILS CLOSED (never executes)", async () => {
    // #2525 FIX 3: for a MODIFICATION the frozen base may have drifted from the
    // live booking; the integrity hook is the only gate for that. Absent, refuse
    // loudly rather than execute against a possibly-stale base.
    const modRow = baseRow({ proposalHash: MOD_HASH });
    modRow.proposalSnapshot = MOD_SNAPSHOT as never;
    const { db } = makeDb({ row: modRow });
    const hooks = makeHooks(); // no verifyLiveProposalIntegrity provided
    await expect(
      approveAndExecutePolicyExceptionRequest({
        requestId: "req-1",
        expectedVersion: 1,
        actorMemberId: "admin-1",
        hooks,
        db: db as never,
      }),
    ).rejects.toBeInstanceOf(PolicyExceptionIntegrityHookMissingError);
    // Mutation guard: without the fail-closed branch this instead executes.
    expect(hooks.executeApprovedProposal).not.toHaveBeenCalled();
  });

  it("MODIFICATION WITH a passing live-integrity hook executes normally", async () => {
    const modRow = baseRow({ proposalHash: MOD_HASH });
    modRow.proposalSnapshot = MOD_SNAPSHOT as never;
    const { db } = makeDb({ row: modRow });
    const hooks = makeHooks({
      verifyLiveProposalIntegrity: vi.fn(async () => true),
    });
    const result = await approveAndExecutePolicyExceptionRequest({
      requestId: "req-1",
      expectedVersion: 1,
      actorMemberId: "admin-1",
      hooks,
      db: db as never,
    });
    expect(result.outcome).toBe("executed");
    expect(hooks.verifyLiveProposalIntegrity).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePolicyExceptionRequestTerminal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("REJECTED: guarded claim + atomic release, in global→lodge lock order", async () => {
    const { db, order, updateMany } = makeDb({ row: baseRow(), releaseCount: 2 });
    const result = await resolvePolicyExceptionRequestTerminal({
      requestId: "req-1",
      expectedVersion: 1,
      to: "REJECTED",
      actorMemberId: "admin-1",
      db: db as never,
    });
    expect(result).toEqual({ claimed: true, released: 2 });
    expect(order).toEqual([
      "global-lock",
      "lodge-lock",
      "claim-rejected",
      "release",
      "commit",
    ]);
    // #2524 one-open-slot: every terminal transition frees openStateKey so the
    // member may open a fresh proposal after a rejection.
    expect(updateMany.mock.calls[0][0].data.openStateKey).toBeNull();
  });

  it("LOST CLAIM: no release when the guarded updateMany matches nothing", async () => {
    const { db, deleteMany } = makeDb({ row: baseRow(), claimCount: 0 });
    const result = await resolvePolicyExceptionRequestTerminal({
      requestId: "req-1",
      expectedVersion: 1,
      to: "CANCELLED",
      db: db as never,
    });
    expect(result).toEqual({ claimed: false, released: 0 });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  // #2553: the hold reaper closes an abandoned request through this SAME helper,
  // so it inherits the lock order, the guarded claim and the atomic release
  // rather than forking a second release path.
  it("EXPIRED: same guarded claim + atomic release, in global→lodge lock order", async () => {
    const { db, order, updateMany } = makeDb({ row: baseRow(), releaseCount: 3 });
    const result = await resolvePolicyExceptionRequestTerminal({
      requestId: "req-1",
      expectedVersion: 1,
      to: "EXPIRED",
      db: db as never,
    });
    expect(result).toEqual({ claimed: true, released: 3 });
    expect(order).toEqual([
      "global-lock",
      "lodge-lock",
      "claim-expired",
      "release",
      "commit",
    ]);
    const claim = updateMany.mock.calls[0][0];
    // Guarded on REQUESTED + the exact version, like every other transition.
    expect(claim.where).toMatchObject({
      status: "REQUESTED",
      version: 1,
      kind: "POLICY_EXCEPTION",
    });
    // The one-open-request slot is freed, so a lapse never locks the member out
    // of raising a fresh proposal.
    expect(claim.data.openStateKey).toBeNull();
    // An expiry is nobody's decision: it stamps no reviewer and no cancelledAt.
    expect(claim.data.reviewedByMemberId).toBeUndefined();
    expect(claim.data.cancelledAt).toBeUndefined();
  });

  it("EXPIRED: a lost version claim releases nothing (a decision won the race)", async () => {
    const { db, deleteMany } = makeDb({ row: baseRow(), claimCount: 0 });
    const result = await resolvePolicyExceptionRequestTerminal({
      requestId: "req-1",
      expectedVersion: 1,
      to: "EXPIRED",
      db: db as never,
    });
    // No `refused` reason: this is the ordinary race, which the next scan re-reads
    // and either claims or finds already closed. The reaper stays silent for it.
    expect(result).toEqual({ claimed: false, released: 0 });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  // #2553: the two PRE-claim refusals are reported distinctly from a lost claim,
  // because they are permanent for that row. An unattended caller that cannot tell
  // them apart treats "I can never resolve this" as "somebody beat me to it" and
  // its stranded beds never surface.
  it("REFUSED: a missing or non-policy-exception row says so, and locks nothing", async () => {
    const { db, order, deleteMany } = makeDb({
      row: baseRow({ kind: "LOCKED_PERIOD" }),
    });
    const result = await resolvePolicyExceptionRequestTerminal({
      requestId: "req-1",
      expectedVersion: 1,
      to: "EXPIRED",
      db: db as never,
    });
    expect(result).toEqual({
      claimed: false,
      released: 0,
      refused: "not-policy-exception",
    });
    // Refused before any lock is taken, so a bad row cannot serialise the lodge.
    expect(order).toEqual(["commit"]);
    expect(deleteMany).not.toHaveBeenCalled();

    const missing = makeDb({ row: null });
    expect(
      await resolvePolicyExceptionRequestTerminal({
        requestId: "req-1",
        expectedVersion: 1,
        to: "EXPIRED",
        db: missing.db as never,
      }),
    ).toEqual({ claimed: false, released: 0, refused: "not-policy-exception" });
  });

  it("REFUSED: an unparsable proposalSnapshot says so rather than looking like a race", async () => {
    const { db, order, deleteMany } = makeDb({
      // A MODIFICATION snapshot whose lodgeId is not a string: there is no lodge
      // to lock, so no retry can ever resolve this row.
      row: baseRow({
        proposalSnapshot: {
          kind: "MODIFICATION",
          lodgeId: 42,
          bookingId: "bk-1",
          base: {},
          proposed: {},
        },
      }),
    });
    const result = await resolvePolicyExceptionRequestTerminal({
      requestId: "req-1",
      expectedVersion: 1,
      to: "EXPIRED",
      db: db as never,
    });
    expect(result).toEqual({
      claimed: false,
      released: 0,
      refused: "unreadable-proposal",
    });
    expect(order).toEqual(["commit"]);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("SUPERSEDED: records the superseding request id and releases", async () => {
    const { db, updateMany } = makeDb({ row: baseRow(), releaseCount: 1 });
    const result = await resolvePolicyExceptionRequestTerminal({
      requestId: "req-1",
      expectedVersion: 1,
      to: "SUPERSEDED",
      supersededByRequestId: "req-2",
      db: db as never,
    });
    expect(result).toEqual({ claimed: true, released: 1 });
    expect(updateMany.mock.calls[0][0].data.supersededByRequestId).toBe("req-2");
  });
});
