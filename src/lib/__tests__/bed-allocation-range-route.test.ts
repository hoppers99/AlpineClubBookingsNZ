import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * POST /api/admin/bed-allocation/allocations/range (#2251).
 *
 * The real route handler, the real requireBedAllocationAdmin guard and the real
 * audit call shape run; assignBedRange is mocked at the lib seam so each of the
 * route's own contracts can be driven directly: ONE audit entry either way,
 * targetId = booking id (so the booking page's audit deep link finds it), and
 * 400-vs-409 on a refusal.
 */
const {
  mockRequireAdmin,
  mockModuleEnabled,
  mockAssignBedRange,
  mockCreateAuditLog,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockModuleEnabled: vi.fn(),
  mockAssignBedRange: vi.fn(),
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
    assignBedRange: (...args: unknown[]) => mockAssignBedRange(...args),
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn(),
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));

function buildResult(
  overrides: Partial<{
    applied: boolean;
    freeNightsOnly: boolean;
    writtenNights: string[];
    freeNights: string[];
    refusals: Array<Record<string, unknown>>;
  }> = {},
) {
  return {
    applied: overrides.applied ?? true,
    freeNightsOnly: overrides.freeNightsOnly ?? false,
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    guestName: "Range Guest",
    bedId: "bed-1",
    bedName: "Bed One",
    roomName: "Room One",
    fromDate: "2026-06-01",
    toDate: "2026-06-04",
    requestedNights: ["2026-06-01", "2026-06-02", "2026-06-03"],
    freeNights: overrides.freeNights ?? [
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ],
    writtenNights: overrides.writtenNights ?? [
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ],
    refusals: overrides.refusals ?? [],
    promotedPartners: [],
  };
}

function post(body: unknown) {
  return import(
    "@/app/api/admin/bed-allocation/allocations/range/route"
  ).then(({ POST }) =>
    POST(
      new Request(
        "http://localhost/api/admin/bed-allocation/allocations/range",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body:
            typeof body === "string" ? body : JSON.stringify(body),
        },
      ),
    ),
  );
}

const validBody = {
  bookingGuestId: "guest-1",
  bedId: "bed-1",
  from: "2026-06-01",
  to: "2026-06-04",
};

describe("POST /api/admin/bed-allocation/allocations/range", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mockModuleEnabled.mockResolvedValue(true);
    mockCreateAuditLog.mockResolvedValue(undefined);
  });

  it("writes ONE audit entry against the booking id on success", async () => {
    mockAssignBedRange.mockResolvedValue(buildResult());

    const response = await post(validBody);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { applied: true, writtenNights: ["2026-06-01", "2026-06-02", "2026-06-03"] },
    });

    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockCreateAuditLog.mock.calls[0][0];
    expect(entry.action).toBe("BED_ALLOCATION_RANGE_SET");
    // The booking page's audit deep link matches targetId, never metadata.
    expect(entry.targetId).toBe("booking-1");
    expect(entry.outcome).toBe("success");
    expect(entry.metadata).toMatchObject({
      requestedFrom: "2026-06-01",
      requestedTo: "2026-06-04",
      requestedNightCount: 3,
      writtenNightCount: 3,
      refusedNightCount: 0,
      autoApproved: true,
      freeNightsOnly: false,
      writtenNightRuns: ["2026-06-01 → 2026-06-03"],
    });
  });

  it("still writes ONE audit entry, as a failure, when the range is refused", async () => {
    mockAssignBedRange.mockResolvedValue(
      buildResult({
        applied: false,
        writtenNights: [],
        freeNights: ["2026-06-01", "2026-06-02"],
        refusals: [
          {
            stayDate: "2026-06-03",
            category: "BED_TAKEN",
            occupiedBy: {
              guestName: "Other Guest",
              memberName: "Other Member",
              bookingId: "booking-other",
              holdsCapacity: false,
            },
          },
        ],
      }),
    );

    const response = await post(validBody);
    // A pure clash is a conflict, not a bad request.
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.result.applied).toBe(false);
    expect(body.result.refusals).toHaveLength(1);
    expect(body.result.freeNights).toEqual(["2026-06-01", "2026-06-02"]);

    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockCreateAuditLog.mock.calls[0][0];
    expect(entry.outcome).toBe("failure");
    expect(entry.targetId).toBe("booking-1");
    expect(entry.metadata.refusedNightCountsByCategory).toEqual({
      EXCLUSIVE_HOLD: 0,
      GUEST_NOT_BOOKED: 0,
      BED_TAKEN: 1,
    });
  });

  it("answers 400 when a night is refused because the guest is not booked", async () => {
    mockAssignBedRange.mockResolvedValue(
      buildResult({
        applied: false,
        writtenNights: [],
        freeNights: ["2026-06-01"],
        refusals: [{ stayDate: "2026-06-03", category: "GUEST_NOT_BOOKED" }],
      }),
    );

    const response = await post(validBody);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("not booked");
    // Same report body whichever status the refusal carries.
    expect(body.result.refusals[0].category).toBe("GUEST_NOT_BOOKED");
  });

  it("passes the admin's explicit free-nights opt-in through", async () => {
    mockAssignBedRange.mockResolvedValue(
      buildResult({
        freeNightsOnly: true,
        writtenNights: ["2026-06-01", "2026-06-02"],
        refusals: [{ stayDate: "2026-06-03", category: "BED_TAKEN" }],
      }),
    );

    const response = await post({ ...validBody, freeNightsOnly: true });
    expect(response.status).toBe(200);
    expect(mockAssignBedRange).toHaveBeenCalledWith(
      expect.objectContaining({
        freeNightsOnly: true,
        approvedByMemberId: "admin-1",
      }),
    );
    // One entry, for one deliberate action, carrying both halves.
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
    expect(mockCreateAuditLog.mock.calls[0][0].metadata).toMatchObject({
      freeNightsOnly: true,
      writtenNightCount: 2,
      refusedNightCount: 1,
    });
  });

  it("rejects unknown keys and malformed JSON without touching the lib", async () => {
    const strict = await post({ ...validBody, lodgeId: "lodge-1" });
    expect(strict.status).toBe(400);

    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);

    expect(mockAssignBedRange).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("404s when the bed allocation module is off", async () => {
    mockModuleEnabled.mockResolvedValue(false);

    const response = await post(validBody);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mockAssignBedRange).not.toHaveBeenCalled();
  });

  it("refuses a non-admin before any work happens", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });

    const response = await post(validBody);
    expect(response.status).toBe(403);
    expect(mockAssignBedRange).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});
