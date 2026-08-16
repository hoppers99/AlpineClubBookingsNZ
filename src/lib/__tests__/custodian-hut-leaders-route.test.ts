import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Custodian bed hold — the hut-leaders write routes (#2286).
 *
 * Both handlers were transaction-free before this change, so the things worth
 * pinning are structural rather than arithmetic:
 *
 *  - EVERY create runs inside one transaction that takes the per-lodge advisory
 *    lock FIRST, before any validation read, and re-reads the lodge, the member
 *    and the overlap set under that lock;
 *  - a bed-holding create additionally re-validates the hold under the lock;
 *  - the PIN email stays OUTSIDE that transaction (AGENTS.md: no provider call
 *    inside a DB transaction) and a failing send still leaves the assignment
 *    created, reported as `emailSent: false`;
 *  - PUT's `bedId` is genuinely three-state: absent leaves the hold alone,
 *    explicit null clears it, a string sets it.
 *
 * #2887 changed one of these deliberately. A role-only create used to keep the
 * old unlocked `prisma.hutLeaderAssignment.create`, on the reasoning that it
 * holds no bed and so moves no capacity. That is true of capacity and false of
 * the OVERLAP predicate: two role-only creates for the same lodge and the same
 * nights both read an empty overlap set and both insert, leaving the lodge with
 * two hut leaders for one night — the exact state the >1-day overlap rule
 * exists to prevent. Both paths therefore share the per-lodge key now, which is
 * what serializes that read-then-write. The test below pins the new contract;
 * the old one is gone on purpose, not by accident.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  validateCustodianBedHold: vi.fn(),
  sendHutLeaderAssignmentEmail: vi.fn(),
  isEffectiveModuleEnabled: vi.fn(),
  resolveOptionalActiveLodgeId: vi.fn(),
  transaction: vi.fn(),
  memberFindUnique: vi.fn(),
  assignmentFindMany: vi.fn(),
  assignmentCreate: vi.fn(),
  assignmentFindUnique: vi.fn(),
  assignmentUpdate: vi.fn(),
  lodgeFindUnique: vi.fn(),
  txAssignmentCreate: vi.fn(),
  txAssignmentUpdate: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
}));
vi.mock("@/lib/custodian-assignment", () => ({
  validateCustodianBedHold: mocks.validateCustodianBedHold,
}));
vi.mock("@/lib/custodian-assignment-routes", () => ({
  custodianBedHoldErrorResponse: () => null,
}));
vi.mock("@/lib/email", () => ({
  sendHutLeaderAssignmentEmail: mocks.sendHutLeaderAssignmentEmail,
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: mocks.isEffectiveModuleEnabled,
}));
vi.mock("@/lib/lodges", () => ({
  lodgeNullTolerantScope: (lodgeId: string) => ({ lodgeId }),
  resolveOptionalActiveLodgeId: mocks.resolveOptionalActiveLodgeId,
}));
vi.mock("@/lib/lodge-pin-session", () => ({
  generateHutLeaderPin: () => "1234",
  hashHutLeaderPin: async () => "hashed",
}));
vi.mock("@/lib/access-roles", () => ({ hasAccessRole: () => true }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    member: { findUnique: mocks.memberFindUnique },
    hutLeaderAssignment: {
      findMany: mocks.assignmentFindMany,
      create: mocks.assignmentCreate,
      findUnique: mocks.assignmentFindUnique,
      update: mocks.assignmentUpdate,
    },
    lodge: { findUnique: mocks.lodgeFindUnique },
  },
}));

import { POST } from "@/app/api/admin/hut-leaders/route";
import { PUT } from "@/app/api/admin/hut-leaders/[id]/route";

const LODGE = "lodge-a";

/** Order of operations inside the transaction, so the lock's position is provable. */
let callOrder: string[] = [];

/**
 * The member the route reads, both before and under the lock. Held in a
 * variable rather than a `mockResolvedValue` so a test can change it once and
 * have BOTH reads agree — the pre-lock read and the post-lock re-read are the
 * same person unless a test is deliberately racing them.
 */
type MemberRow = {
  id: string;
  active: boolean;
  email: string;
  firstName: string;
  ageTier: string;
  accessRoles: Array<{ role: string }>;
};
let memberRow: MemberRow;

function postRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/hut-leaders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/hut-leaders/a1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: "a1" });

beforeEach(() => {
  vi.clearAllMocks();
  callOrder = [];
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: {} });
  mocks.isEffectiveModuleEnabled.mockResolvedValue(true);
  mocks.resolveOptionalActiveLodgeId.mockResolvedValue(LODGE);
  memberRow = {
    id: "member-1",
    active: true,
    email: "sam@example.nz",
    firstName: "Sam",
    ageTier: "ADULT",
    accessRoles: [{ role: "USER" }],
  };
  mocks.assignmentCreate.mockResolvedValue({ id: "created-unlocked" });
  mocks.assignmentFindUnique.mockResolvedValue({
    id: "a1",
    lodgeId: LODGE,
    bedId: "bed-1",
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-05T00:00:00.000Z"),
  });
  mocks.assignmentUpdate.mockResolvedValue({ id: "a1" });
  mocks.sendHutLeaderAssignmentEmail.mockResolvedValue(undefined);

  mocks.acquireLodgeCapacityLock.mockImplementation(async () => {
    callOrder.push("lock");
  });
  mocks.validateCustodianBedHold.mockImplementation(async () => {
    callOrder.push("validate");
  });
  mocks.txAssignmentCreate.mockImplementation(async () => {
    callOrder.push("create");
    return { id: "created-locked" };
  });
  mocks.txAssignmentUpdate.mockImplementation(async () => {
    callOrder.push("update");
    return { id: "a1" };
  });
  mocks.sendHutLeaderAssignmentEmail.mockImplementation(async () => {
    callOrder.push("email");
  });
  mocks.memberFindUnique.mockImplementation(async () => {
    callOrder.push("readMember");
    return memberRow;
  });
  mocks.assignmentFindMany.mockImplementation(async () => {
    callOrder.push("readOverlaps");
    return [];
  });
  // The post-lock re-reads go through the SAME doubles as the pre-lock ones, so
  // a test that changes the member row changes what the locked re-read sees too
  // — and `callOrder` records both, which is how the "under the lock" ordering
  // below is provable rather than assumed.
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => {
    callOrder.push("txBegin");
    const result = await run({
      member: { findUnique: mocks.memberFindUnique },
      hutLeaderAssignment: {
        findMany: mocks.assignmentFindMany,
        create: mocks.txAssignmentCreate,
        update: mocks.txAssignmentUpdate,
      },
    });
    callOrder.push("txEnd");
    return result;
  });
});

const CREATE_BODY = {
  memberId: "member-1",
  startDate: "2026-07-01",
  endDate: "2026-07-05",
  lodgeId: LODGE,
};

describe("POST /api/admin/hut-leaders — bed hold", () => {
  it("takes the per-lodge advisory lock FIRST, then validates, then writes — all inside one transaction", async () => {
    const res = await POST(postRequest({ ...CREATE_BODY, bedId: "bed-1" }));
    expect(res.status).toBe(201);

    // The lock must precede the validation read: validating outside it would
    // let a concurrent allocation land between the check and the write.
    // Every read the decision rests on sits BETWEEN the lock and the write.
    expect(callOrder).toEqual([
      "readMember", // pre-lock read: cheap refusals before taking a lock
      "readOverlaps",
      "txBegin",
      "lock",
      "readMember", // …and the same reads AGAIN, now serialized
      "readOverlaps",
      "validate",
      "create",
      "txEnd",
      "email",
    ]);
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      LODGE,
    );
  });

  it("sends the PIN email OUTSIDE the transaction — no provider call inside a DB transaction", async () => {
    await POST(postRequest({ ...CREATE_BODY, bedId: "bed-1" }));
    expect(callOrder.indexOf("email")).toBeGreaterThan(
      callOrder.indexOf("txEnd"),
    );
  });

  it("still creates the assignment when the PIN email fails, reporting emailSent false", async () => {
    mocks.sendHutLeaderAssignmentEmail.mockRejectedValue(new Error("SES down"));
    const res = await POST(postRequest({ ...CREATE_BODY, bedId: "bed-1" }));
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ emailSent: false });
    expect(mocks.txAssignmentCreate).toHaveBeenCalledOnce();
  });

  it("puts a ROLE-ONLY create under the same lodge lock, re-reading the overlap set after it (#2887)", async () => {
    const res = await POST(postRequest(CREATE_BODY));
    expect(res.status).toBe(201);

    // The lock is what makes the overlap read-then-write atomic, and a role-only
    // create does exactly that read and that write — so it takes the lock too.
    expect(callOrder).toEqual([
      "readMember",
      "readOverlaps",
      "txBegin",
      "lock",
      "readMember",
      "readOverlaps",
      "create",
      "txEnd",
      "email",
    ]);
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      LODGE,
    );

    // What is still true of a role-only create: it holds no bed, so nothing
    // validates a hold and nothing goes on the row.
    expect(mocks.validateCustodianBedHold).not.toHaveBeenCalled();
    expect(mocks.txAssignmentCreate).toHaveBeenCalledOnce();
    // No bed on the row at all — not `bedId: null`, just absent.
    expect(mocks.txAssignmentCreate.mock.calls[0][0].data).not.toHaveProperty(
      "bedId",
    );
    // And the unlocked writer is gone: nothing reaches the base client.
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it("refuses under the lock when the member stops being eligible after the pre-lock read (#2887)", async () => {
    // The pre-lock read is an optimisation, not the decision. Deactivate the
    // member between the two reads and the locked one must win.
    let read = 0;
    mocks.memberFindUnique.mockImplementation(async () => {
      callOrder.push("readMember");
      read += 1;
      return read === 1 ? memberRow : { ...memberRow, active: false };
    });

    const res = await POST(postRequest(CREATE_BODY));
    // Same refusal the pre-lock read would have given — the locked re-read is
    // the decision, not a different outcome dressed up as a server error.
    expect(res.status).toBe(404);
    expect(mocks.txAssignmentCreate).not.toHaveBeenCalled();
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
    expect(mocks.sendHutLeaderAssignmentEmail).not.toHaveBeenCalled();
  });

  it("refuses under the lock when an overlapping assignment lands after the pre-lock read (#2887)", async () => {
    // This is the race the shared lock exists for: both requests read an empty
    // overlap set outside the lock, and only the serialized re-read can catch
    // the loser.
    let read = 0;
    mocks.assignmentFindMany.mockImplementation(async () => {
      callOrder.push("readOverlaps");
      read += 1;
      return read === 1
        ? []
        : [
            {
              id: "other",
              startDate: new Date("2026-07-01T00:00:00.000Z"),
              endDate: new Date("2026-07-05T00:00:00.000Z"),
              member: { firstName: "Ada", lastName: "Lovelace" },
            },
          ];
    });

    const res = await POST(postRequest(CREATE_BODY));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Ada Lovelace"),
    });
    expect(mocks.txAssignmentCreate).not.toHaveBeenCalled();
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
    expect(mocks.sendHutLeaderAssignmentEmail).not.toHaveBeenCalled();
  });

  it("warns that a minor custodian will never be named on the lodge screen", async () => {
    memberRow = {
      id: "member-1",
      active: true,
      email: "kid@example.nz",
      firstName: "Kid",
      ageTier: "YOUTH",
      accessRoles: [{ role: "USER" }],
    };
    const res = await POST(postRequest({ ...CREATE_BODY, bedId: "bed-1" }));
    const body = await res.json();
    expect(body.minorCustodianWarning).toMatch(/never their name/i);
  });

  it("does not warn about a minor when no bed is held — a role-only minor is not on the screen at all", async () => {
    memberRow = {
      id: "member-1",
      active: true,
      email: "kid@example.nz",
      firstName: "Kid",
      ageTier: "YOUTH",
      accessRoles: [{ role: "USER" }],
    };
    const res = await POST(postRequest(CREATE_BODY));
    await expect(res.json()).resolves.toMatchObject({
      minorCustodianWarning: null,
    });
  });

  it("refuses a bed when the bed-allocation module is off", async () => {
    mocks.isEffectiveModuleEnabled.mockResolvedValue(false);
    const res = await POST(postRequest({ ...CREATE_BODY, bedId: "bed-1" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "MODULE_DISABLED",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/hut-leaders/[id] — three-state bedId", () => {
  it("ABSENT leaves the existing hold alone (and still re-validates it against the final dates)", async () => {
    const res = await PUT(putRequest({ endDate: "2026-07-09" }), { params });
    expect(res.status).toBe(200);
    // The row keeps its bed, so `data` must not name bedId at all…
    const data = mocks.txAssignmentUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("bedId");
    // …but the surviving hold IS re-checked against the new end date, because
    // extending a hold can collide with something the old range did not.
    expect(mocks.validateCustodianBedHold).toHaveBeenCalledWith(
      expect.objectContaining({ bedId: "bed-1", assignmentId: "a1" }),
    );
  });

  it("EXPLICIT NULL clears the bed, with no lock and no validation — releasing capacity is always safe", async () => {
    const res = await PUT(putRequest({ bedId: null }), { params });
    expect(res.status).toBe(200);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.acquireLodgeCapacityLock).not.toHaveBeenCalled();
    expect(mocks.validateCustodianBedHold).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate.mock.calls[0][0].data).toMatchObject({
      bedId: null,
    });
  });

  it("RELEASES the bed even with the bedAllocation module OFF (#2286 review M11)", async () => {
    // A hold created while the module was on still occupies a real bed after it
    // is turned off — physical reality does not follow a feature flag. The
    // module gate deliberately guards only the SET direction, so the hold can
    // always be undone; gating the clear too would strand it with no route back.
    mocks.isEffectiveModuleEnabled.mockResolvedValue(false);

    const res = await PUT(putRequest({ bedId: null }), { params });
    expect(res.status).toBe(200);
    expect(mocks.assignmentUpdate.mock.calls[0][0].data).toMatchObject({
      bedId: null,
    });
  });

  it("still refuses to SET a bed with the module off", async () => {
    mocks.isEffectiveModuleEnabled.mockResolvedValue(false);

    const res = await PUT(putRequest({ bedId: "bed-9" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("MODULE_DISABLED");
  });

  it("A STRING sets the bed, under the lock, validated against the final dates and lodge", async () => {
    mocks.assignmentFindUnique.mockResolvedValue({
      id: "a1",
      lodgeId: LODGE,
      bedId: null,
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      endDate: new Date("2026-07-05T00:00:00.000Z"),
    });
    const res = await PUT(putRequest({ bedId: "bed-9" }), { params });
    expect(res.status).toBe(200);
    expect(callOrder.slice(callOrder.indexOf("txBegin"), callOrder.indexOf("txBegin") + 4)).toEqual([
      "txBegin",
      "lock",
      "validate",
      "update",
    ]);
    expect(mocks.validateCustodianBedHold).toHaveBeenCalledWith(
      expect.objectContaining({ bedId: "bed-9", assignmentId: "a1" }),
    );
  });
});
