import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * POST /api/admin/bed-allocation/approve — the `bookingId` selector (#2252).
 *
 * The real route handler and the real requireBedAllocationAdmin guard run;
 * approveBedAllocations is mocked at the lib seam so the route's own contracts
 * can be driven directly. The contract that matters most here is scope: the
 * in-booking Bed allocation panel's Confirm sends `{ bookingId }` and NOTHING
 * else, because the `from`/`to` form approves every pending allocation of every
 * booking in the window. The second is audit visibility — a booking-scoped
 * approval must carry `targetId: bookingId`, or the booking page's own
 * "Audit log" deep link (`?q=<bookingId>`, matched against targetId and never
 * against metadata) cannot find the Confirm that was pressed on that page.
 */
const {
  mockRequireAdmin,
  mockModuleEnabled,
  mockApproveBedAllocations,
  mockCreateAuditLog,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockModuleEnabled: vi.fn(),
  mockApproveBedAllocations: vi.fn(),
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
    approveBedAllocations: (...args: unknown[]) =>
      mockApproveBedAllocations(...args),
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn(),
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));

function post(body: unknown) {
  return import("@/app/api/admin/bed-allocation/approve/route").then(
    ({ POST }) =>
      POST(
        new Request("http://localhost/api/admin/bed-allocation/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      ),
  );
}

describe("POST /api/admin/bed-allocation/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mockModuleEnabled.mockResolvedValue(true);
    mockCreateAuditLog.mockResolvedValue(undefined);
    mockApproveBedAllocations.mockResolvedValue({ count: 4 });
  });

  it("accepts { bookingId } on its own and never turns it into a window approval", async () => {
    const response = await post({ bookingId: "booking-1" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ approvedCount: 4 });

    const call = mockApproveBedAllocations.mock.calls[0][0];
    expect(call).toMatchObject({
      approvedByMemberId: "admin-1",
      bookingId: "booking-1",
    });
    // No date range is invented from a booking-scoped Confirm; a `from`/`to`
    // approval would stamp every other booking's drafts in the same window.
    expect(call.range).toBeUndefined();
    expect(call.allocationIds).toBeUndefined();
  });

  it("carries the panel's lodge scope through to the booking selector", async () => {
    // #2252 review: the panel's read is lodge-scoped, so its write must be too
    // — otherwise Confirm could stamp an off-lodge row the card never showed.
    const response = await post({ bookingId: "booking-1", lodgeId: "lodge-1" });

    expect(response.status).toBe(200);
    expect(mockApproveBedAllocations.mock.calls[0][0]).toMatchObject({
      bookingId: "booking-1",
      lodgeId: "lodge-1",
    });
  });

  it("audits a booking-scoped approval against the booking, so the booking's audit deep link finds it", async () => {
    await post({ bookingId: "booking-1" });

    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockCreateAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({
      action: "BED_ALLOCATION_APPROVED",
      memberId: "admin-1",
      entityType: "BedAllocation",
      outcome: "success",
      // The deep link searches targetId — metadata is not searched at all.
      targetId: "booking-1",
    });
    expect(entry.metadata).toMatchObject({
      approvedCount: 4,
      bookingId: "booking-1",
    });
  });

  it("leaves the board's own approvals exactly as they were", async () => {
    await post({ from: "2026-06-01", to: "2026-06-08", lodgeId: "lodge-1" });

    const call = mockApproveBedAllocations.mock.calls[0][0];
    expect(call.bookingId).toBeUndefined();
    expect(call.lodgeId).toBe("lodge-1");
    expect(call.range).toMatchObject({
      fromDate: "2026-06-01",
      toDate: "2026-06-08",
    });
    // A club/lodge-wide approval is not attributable to one booking, so it
    // carries no targetId — unchanged from before #2252.
    expect(mockCreateAuditLog.mock.calls[0][0].targetId).toBeUndefined();
  });

  it("still accepts an explicit allocation id list", async () => {
    await post({ allocationIds: ["alloc-1", "alloc-2"] });

    expect(mockApproveBedAllocations.mock.calls[0][0]).toMatchObject({
      allocationIds: ["alloc-1", "alloc-2"],
    });
  });

  it("rejects unknown keys, an empty booking id, and malformed JSON without touching the lib", async () => {
    const unknownKey = await post({
      bookingId: "booking-1",
      approveEverything: true,
    });
    expect(unknownKey.status).toBe(400);

    const emptyBookingId = await post({ bookingId: "" });
    expect(emptyBookingId.status).toBe(400);

    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);

    expect(mockApproveBedAllocations).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("passes the lib's no-selector refusal back as a 400 and audits nothing", async () => {
    const { BedAllocationAdminError } = await import(
      "@/lib/admin-bed-allocation"
    );
    mockApproveBedAllocations.mockRejectedValue(
      new BedAllocationAdminError(
        "Select allocations, a booking, or a date range to approve.",
        400,
      ),
    );

    const response = await post({});
    expect(response.status).toBe(400);
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("404s when the bed allocation module is off", async () => {
    mockModuleEnabled.mockResolvedValue(false);

    const response = await post({ bookingId: "booking-1" });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mockApproveBedAllocations).not.toHaveBeenCalled();
  });

  it("refuses a non-admin before any work happens", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });

    const response = await post({ bookingId: "booking-1" });
    expect(response.status).toBe(403);
    expect(mockApproveBedAllocations).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});
