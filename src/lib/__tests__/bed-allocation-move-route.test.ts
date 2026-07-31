import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireAdmin,
  mockModuleEnabled,
  mockMoveBedAllocationsSameDate,
  mockCreateAuditLog,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockModuleEnabled: vi.fn(),
  mockMoveBedAllocationsSameDate: vi.fn(),
  mockCreateAuditLog: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: () => mockModuleEnabled(),
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => mockCreateAuditLog(...args),
}));
vi.mock("@/lib/admin-bed-allocation", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/admin-bed-allocation")
  >("@/lib/admin-bed-allocation");
  return {
    ...actual,
    moveBedAllocationsSameDate: (...args: unknown[]) =>
      mockMoveBedAllocationsSameDate(...args),
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn(),
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));

function patch(body: unknown) {
  return import("@/app/api/admin/bed-allocation/allocations/route").then(
    ({ PATCH }) =>
      PATCH(
        new Request("http://localhost/api/admin/bed-allocation/allocations", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      ),
  );
}

describe("PATCH /api/admin/bed-allocation/allocations (#2366)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mockModuleEnabled.mockResolvedValue(true);
    mockMoveBedAllocationsSameDate.mockResolvedValue({
      noop: false,
      promotedPartners: [],
      allocations: [
        {
          id: "allocation-1",
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          roomId: "room-2",
          bedId: "bed-2",
          stayDate: new Date("2026-07-01T00:00:00.000Z"),
          source: "MANUAL",
        },
      ],
    });
  });

  it("passes only allocation ids, destination bed and actor to the atomic service", async () => {
    const response = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      noop: false,
      allocations: [
        {
          id: "allocation-1",
          bedId: "bed-2",
          stayDate: "2026-07-01",
        },
      ],
    });
    expect(mockMoveBedAllocationsSameDate).toHaveBeenCalledWith({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
      actorMemberId: "admin-1",
    });
    // The service writes the move, promotion and audit inside one transaction.
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("rejects any client-supplied target date before the service runs", async () => {
    const response = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
      stayDate: "2026-07-09",
    });

    expect(response.status).toBe(400);
    expect(mockMoveBedAllocationsSameDate).not.toHaveBeenCalled();
  });

  it("returns a server-side no-op without adding a route audit", async () => {
    mockMoveBedAllocationsSameDate.mockResolvedValue({
      noop: true,
      allocations: [],
      promotedPartners: [],
    });

    const response = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-1",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      noop: true,
      allocations: [],
    });
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("keeps module and admin authorization on the move route", async () => {
    mockModuleEnabled.mockResolvedValue(false);
    const disabled = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
    });
    expect(disabled.status).toBe(404);

    mockModuleEnabled.mockResolvedValue(true);
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });
    const forbidden = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
    });
    expect(forbidden.status).toBe(403);
    expect(mockMoveBedAllocationsSameDate).not.toHaveBeenCalled();
  });
});
