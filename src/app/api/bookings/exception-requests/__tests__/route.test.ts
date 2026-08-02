import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  logAudit: vi.fn(),
  sendAlert: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  createNew: vi.fn(),
  cancelNew: vi.fn(),
  nbFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mocks.checkRateLimit(...a),
  getClientIp: (...a: unknown[]) => mocks.getClientIp(...a),
  rateLimiters: { bookingChangeRequest: { id: "bcr", limit: 5, windowSeconds: 86400 } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => mocks.logAudit(...a) }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: (...a: unknown[]) => mocks.sendAlert(...a),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: (...a: unknown[]) => mocks.getDefaultLodgeId(...a),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    newBookingPolicyExceptionRequest: {
      findMany: (...a: unknown[]) => mocks.nbFindMany(...a),
    },
  },
}));
// Keep the REAL error classes (so the http mapper's instanceof checks work), but
// swap the two service functions the routes call for mocks.
vi.mock("@/lib/booking-exception-request-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-exception-request-service")>();
  return {
    ...actual,
    createNewBookingExceptionRequest: (...a: unknown[]) => mocks.createNew(...a),
    cancelNewBookingExceptionRequest: (...a: unknown[]) => mocks.cancelNew(...a),
  };
});

import { POST, GET } from "@/app/api/bookings/exception-requests/route";
import { PATCH } from "@/app/api/bookings/exception-requests/[id]/route";
import {
  NoEligiblePolicyExceptionError,
  OpenExceptionRequestConflictError,
} from "@/lib/booking-exception-request-service";

const CREATED = {
  id: "req-1",
  status: "REQUESTED",
  proposalHash: "a".repeat(64),
  reasonCodes: ["MINIMUM_STAY"],
  aggregateCapacityMode: "HOLD",
};

function postReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/bookings/exception-requests", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const VALID_BODY = {
  checkIn: "2026-07-04",
  checkOut: "2026-07-05",
  guests: [{ firstName: "Ada", lastName: "Lovelace", ageTier: "ADULT", isMember: true, memberId: "m1" }],
  memberMessage: "please allow this stay",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "m1", email: "a@x.nz", name: "Ada Lovelace", role: "member" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ success: true, resetAt: Date.now() + 1000 });
  mocks.getClientIp.mockReturnValue("0.0.0.0");
  mocks.getDefaultLodgeId.mockResolvedValue("lodge_1");
  mocks.createNew.mockResolvedValue(CREATED);
  mocks.sendAlert.mockResolvedValue(undefined);
});

describe("POST /api/bookings/exception-requests", () => {
  it("creates a request (201), audits, and fires the officer alert", async () => {
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
  });

  it("notify-post-commit-never-throws: a rejected alert still returns 201", async () => {
    mocks.sendAlert.mockRejectedValue(new Error("smtp down"));
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(201);
    // Let the swallowed rejection settle; the route must not have awaited it.
    await Promise.resolve();
  });

  it("maps NoEligiblePolicyExceptionError to 400 and does not notify", async () => {
    mocks.createNew.mockRejectedValue(new NoEligiblePolicyExceptionError());
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(400);
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("maps the one-open-request conflict to 409", async () => {
    mocks.createNew.mockRejectedValue(new OpenExceptionRequestConflictError());
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(409);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(401);
    expect(mocks.createNew).not.toHaveBeenCalled();
  });

  it("rejects check-out on/before check-in with 400", async () => {
    const res = await POST(postReq({ ...VALID_BODY, checkOut: "2026-07-04" }));
    expect(res.status).toBe(400);
    expect(mocks.createNew).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/bookings/exception-requests/[id] (member cancel)", () => {
  function patchReq() {
    return new NextRequest("http://localhost/api/bookings/exception-requests/req-1", {
      method: "PATCH",
      body: JSON.stringify({ action: "cancel" }),
      headers: { "content-type": "application/json" },
    });
  }

  it("cancels an open request (200) and audits", async () => {
    mocks.cancelNew.mockResolvedValue(true);
    const res = await PATCH(patchReq(), { params: Promise.resolve({ id: "req-1" }) });
    expect(res.status).toBe(200);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
  });

  it("lost-claim-no-side-effect: a claim that lands nothing is 409 and never audits", async () => {
    mocks.cancelNew.mockResolvedValue(false);
    const res = await PATCH(patchReq(), { params: Promise.resolve({ id: "req-1" }) });
    expect(res.status).toBe(409);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});

describe("GET /api/bookings/exception-requests (member's own list)", () => {
  it("returns the member's own requests", async () => {
    mocks.nbFindMany.mockResolvedValue([{ id: "req-1", status: "REQUESTED" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(mocks.nbFindMany.mock.calls[0][0].where).toMatchObject({ requestedByMemberId: "m1" });
  });
});
