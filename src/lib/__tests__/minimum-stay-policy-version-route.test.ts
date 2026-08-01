import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  transaction: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  executeRaw: vi.fn(),
  logAudit: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidate,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

import {
  DELETE,
  PUT,
} from "@/app/api/admin/booking-policies/minimum-stay/[id]/route";

const policy = {
  id: "policy-1",
  name: "Winter weekends",
  startDate: new Date("2026-06-01T00:00:00.000Z"),
  endDate: new Date("2026-09-30T00:00:00.000Z"),
  triggerDays: [5, 6],
  minimumNights: 2,
  capacityMode: "HOLD",
  active: true,
  lodgeId: "lodge-1",
  version: 4,
};

function request(method: "PUT" | "DELETE", body: unknown) {
  return new NextRequest("https://example.test/api/policy/policy-1", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: "policy-1" }) };

describe("minimum-stay policy versioned writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.transaction.mockImplementation((callback) =>
      callback({
        minimumStayPolicy: {
          findUnique: mocks.findUnique,
          updateMany: mocks.updateMany,
        },
        $executeRaw: mocks.executeRaw,
      }),
    );
  });

  it("rejects a stale PUT with the current version and no side effects", async () => {
    mocks.findUnique.mockResolvedValue({ ...policy, version: 5 });

    const response = await PUT(request("PUT", { version: 4, name: "Changed" }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This policy changed since it was loaded. Reload it and try again.",
      code: "POLICY_VERSION_CONFLICT",
      currentVersion: 5,
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0],
    );
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("does not increment, audit or revalidate a pristine PUT", async () => {
    mocks.findUnique.mockResolvedValue(policy);

    const response = await PUT(request("PUT", { version: 4, name: policy.name }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ id: "policy-1", version: 4 }),
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("guards a material PUT by version and increments exactly once", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(policy)
      .mockResolvedValueOnce({ ...policy, capacityMode: "NO_HOLD", version: 5 });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const response = await PUT(
      request("PUT", { version: 4, capacityMode: "NO_HOLD" }),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "policy-1", version: 4 },
      data: {
        capacityMode: "NO_HOLD",
        version: { increment: 1 },
      },
    });
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0],
    );
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
  });

  it("requires a version for deactivation and guards the material write", async () => {
    const invalid = await DELETE(request("DELETE", {}), context);
    expect(invalid.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();

    mocks.findUnique.mockResolvedValue(policy);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const response = await DELETE(request("DELETE", { version: 4 }), context);

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "policy-1", version: 4, active: true },
      data: { active: false, version: { increment: 1 } },
    });
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0],
    );
  });
});
