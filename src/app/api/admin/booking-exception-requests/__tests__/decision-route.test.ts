import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  // Typed with a rest signature so the `vi.mock` factories below can forward
  // their arguments through with a spread.
  logAudit: vi.fn<(...args: unknown[]) => void>(),
  getClientIp: vi.fn<(...args: unknown[]) => string>(() => "1.2.3.4"),
  approve: vi.fn(),
  resolveTerminal: vi.fn(),
  buildHooks: vi.fn(),
  resolveNewBookingParams: vi.fn(),
  bcrFindFirst: vi.fn(),
  nbFindUnique: vi.fn(),
  fgmFindMany: vi.fn(async () => []),
  memberFindMany: vi.fn(async () => []),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({
  logAudit: (...a: unknown[]) => mocks.logAudit(...a),
}));
vi.mock("@/lib/rate-limit", () => ({
  getClientIp: (...a: unknown[]) => mocks.getClientIp(...a),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingChangeRequest: { findFirst: (...a: unknown[]) => mocks.bcrFindFirst(...a) },
    newBookingPolicyExceptionRequest: {
      findUnique: (...a: unknown[]) => mocks.nbFindUnique(...a),
    },
    // #2526: GET describes the proposed party, including whether each member
    // guest is beyond the requester's family, which reads the family boundary.
    familyGroupMember: { findMany: (...a: unknown[]) => mocks.fgmFindMany(...a) },
    member: { findMany: (...a: unknown[]) => mocks.memberFindMany(...a) },
  },
}));
// Keep the real stores/parsers; swap only the two engine entry points.
vi.mock("@/lib/booking-exception-execution", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/booking-exception-execution")>();
  return {
    ...actual,
    approveAndExecutePolicyExceptionRequest: (...a: unknown[]) => mocks.approve(...a),
    resolvePolicyExceptionRequestTerminal: (...a: unknown[]) =>
      mocks.resolveTerminal(...a),
  };
});
vi.mock("@/lib/booking-exception-approval", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/booking-exception-approval")>();
  return {
    ...actual,
    buildPolicyExceptionApprovalHooks: (...a: unknown[]) => mocks.buildHooks(...a),
    resolveNewBookingExecutionParams: (...a: unknown[]) =>
      mocks.resolveNewBookingParams(...a),
  };
});

import { GET, PATCH } from "@/app/api/admin/booking-exception-requests/[id]/route";
import {
  computeProposalHash,
  freezePolicyExceptionEvidence,
  type ModificationProposalSnapshot,
} from "@/lib/booking-exception-requests";
import type { MinimumStayPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";
import type { AdultMemberHostingPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";

const LODGE = "lodge-a";

const SNAPSHOT: ModificationProposalSnapshot = {
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
    checkOut: "2026-07-02",
    guests: [
      {
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m-1",
        nights: ["2026-07-01"],
      },
    ],
  },
};

const MIN_STAY: MinimumStayPolicyExceptionViolation = {
  reasonCode: "MINIMUM_STAY",
  policyId: "pol-1",
  policyVersion: 1,
  policyName: "Weekend minimum stay",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: LODGE },
  affectedNights: ["2026-07-01"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "Two-night minimum on weekends.",
  triggerDay: "2026-07-01",
  minimumNights: 2,
  actualNights: 1,
  requirements: {
    kind: "MINIMUM_STAY",
    minimumNights: 2,
    actualNights: 1,
    triggerDays: [6],
  },
};

const HOSTING: AdultMemberHostingPolicyExceptionViolation = {
  reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
  policyId: "host-1",
  policyVersion: 3,
  policyName: "Adult member must host",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: LODGE },
  affectedNights: ["2026-07-01"],
  exceptionEligible: true,
  capacityMode: "NO_HOLD",
  message: "An adult member must be present.",
  requirements: {
    kind: "ADULT_MEMBER_HOSTING",
    requiredAdultMemberParticipantsPerGuestNight: 1,
    uncoveredNonMemberGuestNights: 1,
    uncovered: [{ night: "2026-07-01", guestRef: "g-1", guestName: "Bob Smith" }],
    qualifyingHostsByNight: [{ night: "2026-07-01", memberIds: [] }],
  },
};

function modificationRow(
  violations: Array<MinimumStayPolicyExceptionViolation | AdultMemberHostingPolicyExceptionViolation> = [
    MIN_STAY,
  ],
) {
  return {
    id: "req-1",
    status: "REQUESTED",
    version: 3,
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    reviewedAt: null,
    reviewedBy: null,
    requestedBy: {
      id: "m-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    },
    memberMessage: "Please allow the one-night stay.",
    adminNotes: null,
    proposalSnapshot: SNAPSHOT,
    proposalHash: computeProposalHash(SNAPSHOT),
    frozenEvidence: freezePolicyExceptionEvidence(violations),
    aggregateCapacityMode: "HOLD",
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictReason: null,
    supersededByRequestId: null,
    booking: {
      id: "bk-1",
      checkIn: new Date("2026-07-01T00:00:00.000Z"),
      checkOut: new Date("2026-07-03T00:00:00.000Z"),
      status: "PAID",
      finalPriceCents: 12000,
      lodgeId: LODGE,
      member: {
        id: "m-1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      },
    },
  };
}

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/booking-exception-requests/req-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "req-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "officer-1" } },
  });
  mocks.bcrFindFirst.mockResolvedValue(modificationRow());
  mocks.nbFindUnique.mockResolvedValue(null);
  mocks.buildHooks.mockReturnValue({
    hooks: {},
    outcome: { createdBookingId: null, hostingDecisionRecorded: false },
  });
  mocks.approve.mockResolvedValue({ outcome: "executed", requestId: "req-1" });
  mocks.resolveTerminal.mockResolvedValue({ claimed: true, released: 2 });
});

describe("GET /api/admin/booking-exception-requests/[id]", () => {
  it("returns the frozen evidence and the exact proposal an approval would execute", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/admin/booking-exception-requests/req-1"),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("MODIFICATION");
    expect(body.version).toBe(3);
    expect(body.proposal.kind).toBe("MODIFICATION");
    expect(body.evidence.reasonCodes).toEqual(["MINIMUM_STAY"]);
    expect(body.memberMessage).toContain("one-night stay");
  });

  it("404s an id that is in neither table", async () => {
    mocks.bcrFindFirst.mockResolvedValue(null);
    const res = await GET(
      new NextRequest("http://localhost/api/admin/booking-exception-requests/req-1"),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("is refused for an admin without booking access", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await GET(
      new NextRequest("http://localhost/api/admin/booking-exception-requests/req-1"),
      { params },
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH — approve", () => {
  it("refuses an approval that was not explicitly confirmed", async () => {
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/confirm/i);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("requires a written reason before overriding adult-member hosting (D-R4)", async () => {
    mocks.bcrFindFirst.mockResolvedValue(modificationRow([MIN_STAY, HOSTING]));
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/written reason/i);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("executes, and hands the engine the officer's expectedVersion", async () => {
    mocks.buildHooks.mockReturnValue({
      hooks: {},
      outcome: { createdBookingId: null, hostingDecisionRecorded: true },
    });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
        adminNotes: "One-off, agreed at committee.",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "req-1", status: "APPROVED" });
    expect(mocks.approve.mock.calls[0][0]).toMatchObject({
      requestId: "req-1",
      expectedVersion: 3,
      actorMemberId: "officer-1",
    });
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-policy-exception-request.approve",
        outcome: "success",
      }),
    );
  });

  it("reports a NO_HOLD capacity conflict as STILL PENDING — never as approved", async () => {
    mocks.approve.mockResolvedValue({
      outcome: "keptPendingCapacity",
      message: "The lodge no longer has room for this booking.",
    });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("REQUESTED");
    expect(body.keptPending).toBe(true);
    expect(body.error).toMatch(/no longer has room/);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-policy-exception-request.kept-pending",
        outcome: "failure",
      }),
    );
  });

  it("turns a thrown execution capacity refusal into the same still-pending answer", async () => {
    const { PolicyExceptionExecutionCapacityError } = await import(
      "@/lib/booking-exception-approval"
    );
    mocks.approve.mockRejectedValue(
      new PolicyExceptionExecutionCapacityError(["2026-07-01"]),
    );
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("REQUESTED");
    expect(body.keptPending).toBe(true);
  });

  it("reports a post-commit failure as APPROVED with followUpFailed, never as pending", async () => {
    // #2526 review. The engine's post-commit phase runs after the transaction has
    // already committed, so a provider or audit failure there cannot mean the
    // approval did not happen. Reporting "still pending" made the officer retry
    // into a 409 that blamed a third party, or create the booking again by hand.
    mocks.approve.mockResolvedValue({
      outcome: "executed",
      requestId: "req-1",
      followUpFailed: true,
    });
    mocks.buildHooks.mockReturnValue({
      hooks: {},
      outcome: { createdBookingId: "bk-9", hostingDecisionRecorded: false },
    });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("APPROVED");
    expect(body.keptPending).toBeUndefined();
    expect(body.followUpFailed).toBe(true);
    // The approve audit row is still written, and records the follow-up failure.
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-policy-exception-request.approve",
        outcome: "success",
        metadata: expect.objectContaining({ followUpFailed: true }),
      }),
    );
  });

  it("asks the officer for the refund choice instead of calling it kept-pending", async () => {
    // #2526 review. The archetypal minimum-stay exception is "let me shorten my
    // stay", which reduces a paid booking's price and makes the canonical service
    // demand a card/credit choice. Rendering that as "the request is still
    // pending" named no action and the screen offered none, so the request was
    // permanently un-approvable and could only be refused.
    const { BookingModificationSettlementMethodRequiredError } = await import(
      "@/lib/booking-modify-settlement"
    );
    mocks.approve.mockRejectedValue(
      new BookingModificationSettlementMethodRequiredError(),
    );
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("REQUESTED");
    expect(body.needsSettlementMethod).toBe(true);
    // NOT kept-pending: nothing is waiting on capacity or on anybody else.
    expect(body.keptPending).toBeUndefined();
    expect(body.error).toMatch(/card or to account credit/i);
  });

  it("passes the officer's settlement choice through to the executor", async () => {
    mocks.buildHooks.mockReturnValue({
      hooks: {},
      outcome: { createdBookingId: null, hostingDecisionRecorded: false },
    });
    await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
        settlementMethod: "credit",
      }),
      { params },
    );
    expect(mocks.buildHooks.mock.calls[0][0]).toMatchObject({
      settlementMethod: "credit",
    });
  });

  it("hands the member's own message to the hooks for the supervision review", async () => {
    // The officer never decides adult supervision (#2526 review), so the reason
    // recorded against it has to be the MEMBER's.
    mocks.buildHooks.mockReturnValue({
      hooks: {},
      outcome: { createdBookingId: null, hostingDecisionRecorded: false },
    });
    await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(mocks.buildHooks.mock.calls[0][0].memberMessage).toContain(
      "one-night stay",
    );
  });

  it("refuses a guest-authorisation failure with its own status, not as kept-pending", async () => {
    const { BookingGuestValidationError } = await import("@/lib/booking-guests");
    mocks.approve.mockRejectedValue(
      new BookingGuestValidationError("Invalid guest member reference", 403, {
        code: "GUEST_MEMBER_NOT_ALLOWED",
      }),
    );
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.status).toBe("REQUESTED");
    expect(body.keptPending).toBeUndefined();
    expect(body.code).toBe("GUEST_MEMBER_NOT_ALLOWED");
  });

  it("409s a lost claim (the queue was stale)", async () => {
    mocks.approve.mockResolvedValue({ outcome: "claimLost" });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/reload the queue/i);
  });

  it("403s when the fresh-DB reauthorization refuses mid-flight", async () => {
    mocks.approve.mockResolvedValue({ outcome: "notAuthorized" });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(403);
  });

  it("surfaces policy drift with the rules that moved", async () => {
    mocks.approve.mockResolvedValue({
      outcome: "policyDrift",
      message: "The booking policies have changed since this request was reviewed.",
      changedReviewed: [{ reasonCode: "MINIMUM_STAY", policyId: "pol-1" }],
      newViolations: [],
    });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("REQUESTED");
    expect(body.changedReviewed).toHaveLength(1);
  });

  it("404s when the body's source does not match the table the id lives in", async () => {
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "NEW_BOOKING",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(404);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("requires bookings EDIT access, not merely view", async () => {
    await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level: "edit" },
    });
  });
});

describe("PATCH — reject", () => {
  it("refuses a refusal with no reason for the member", async () => {
    const res = await PATCH(
      patchRequest({ action: "reject", source: "MODIFICATION", expectedVersion: 3 }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(mocks.resolveTerminal).not.toHaveBeenCalled();
  });

  it("refuses and reports the reservation nights released", async () => {
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        adminNotes: "The lodge is full that weekend every year.",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "REJECTED",
      releasedReservationNights: 2,
    });
    expect(mocks.resolveTerminal.mock.calls[0][0]).toMatchObject({
      to: "REJECTED",
      expectedVersion: 3,
      actorMemberId: "officer-1",
    });
  });

  it("409s a refusal whose guarded claim was lost", async () => {
    mocks.resolveTerminal.mockResolvedValue({ claimed: false, released: 0 });
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        adminNotes: "No longer relevant.",
      }),
      { params },
    );
    expect(res.status).toBe(409);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});
