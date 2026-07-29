import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Custodian bed hold — the hut-leaders write routes (#2286).
 *
 * Both handlers were transaction-free before this change, so the things worth
 * pinning are structural rather than arithmetic:
 *
 *  - a BED-HOLDING create runs inside one transaction that takes the per-lodge
 *    advisory lock FIRST, before any validation read;
 *  - a role-only create keeps its old unlocked path, so nothing about the
 *    pre-#2286 behaviour changed;
 *  - the PIN email stays OUTSIDE that transaction (AGENTS.md: no provider call
 *    inside a DB transaction) and a failing send still leaves the assignment
 *    created, reported as `emailSent: false`;
 *  - PUT's `bedId` is genuinely three-state: absent leaves the hold alone,
 *    explicit null clears it, a string sets it.
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
  mocks.memberFindUnique.mockResolvedValue({
    id: "member-1",
    active: true,
    email: "sam@example.nz",
    firstName: "Sam",
    ageTier: "ADULT",
    accessRoles: [{ role: "USER" }],
  });
  mocks.assignmentFindMany.mockResolvedValue([]);
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
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => {
    callOrder.push("txBegin");
    const result = await run({
      hutLeaderAssignment: {
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
    expect(callOrder.slice(0, 5)).toEqual([
      "txBegin",
      "lock",
      "validate",
      "create",
      "txEnd",
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

  it("keeps a ROLE-ONLY create on its original unlocked path — the pre-#2286 behaviour is untouched", async () => {
    const res = await POST(postRequest(CREATE_BODY));
    expect(res.status).toBe(201);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.acquireLodgeCapacityLock).not.toHaveBeenCalled();
    expect(mocks.validateCustodianBedHold).not.toHaveBeenCalled();
    expect(mocks.assignmentCreate).toHaveBeenCalledOnce();
    // No bed on the row at all — not `bedId: null`, just absent.
    expect(mocks.assignmentCreate.mock.calls[0][0].data).not.toHaveProperty(
      "bedId",
    );
  });

  it("warns that a minor custodian will never be named on the lodge screen", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-1",
      active: true,
      email: "kid@example.nz",
      firstName: "Kid",
      ageTier: "YOUTH",
      accessRoles: [{ role: "USER" }],
    });
    const res = await POST(postRequest({ ...CREATE_BODY, bedId: "bed-1" }));
    const body = await res.json();
    expect(body.minorCustodianWarning).toMatch(/never their name/i);
  });

  it("does not warn about a minor when no bed is held — a role-only minor is not on the screen at all", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-1",
      active: true,
      email: "kid@example.nz",
      firstName: "Kid",
      ageTier: "YOUTH",
      accessRoles: [{ role: "USER" }],
    });
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
    expect(callOrder.slice(0, 4)).toEqual([
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
