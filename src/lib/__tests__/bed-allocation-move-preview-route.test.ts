import { beforeEach, describe, expect, it, vi } from "vitest";

const { previewMock, readGuardMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  readGuardMock: vi.fn(),
}));

vi.mock("@/lib/admin-bed-allocation-routes", () => ({
  requireBedAllocationRead: () => readGuardMock(),
  bedAllocationErrorResponse: () =>
    Response.json({ error: "Bed allocation request failed" }, { status: 500 }),
}));
vi.mock("@/lib/bed-allocation-move", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bed-allocation-move")>(
    "@/lib/bed-allocation-move",
  );
  return { ...actual, previewBedAllocationMove: previewMock };
});
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

function post(body: unknown) {
  return import("@/app/api/admin/bed-allocation/allocations/move/route").then(
    ({ POST }) =>
      POST(
        new Request(
          "http://localhost/api/admin/bed-allocation/allocations/move",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
      ),
  );
}

describe("POST /api/admin/bed-allocation/allocations/move", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readGuardMock.mockResolvedValue({
      ok: true,
      session: { user: { id: "viewer-1" } },
    });
    previewMock.mockResolvedValue({
      digestVersion: "v1",
      digest: `v1:${"a".repeat(64)}`,
      scope: "ALLOCATION_NIGHT",
      anchor: {
        allocationId: "allocation-1",
        guestName: "Ada Guest",
        stayDate: "2026-08-01",
      },
      destination: {
        bedId: "bed-2",
        label: "Room Two / Bed B",
        available: true,
      },
      resolvedRowCount: 1,
      changedRowCount: 1,
      unchangedRowCount: 0,
      approvedToDraftCount: 0,
      changed: [],
      unchanged: [],
      promotions: [],
      conflicts: [],
    });
  });

  it("allows bookings:view to request the strict read-only preview", async () => {
    const body = {
      anchorAllocationId: "allocation-1",
      destinationBedId: "bed-2",
      scope: "ALLOCATION_NIGHT",
    };
    const response = await post(body);

    expect(response.status).toBe(200);
    expect(previewMock).toHaveBeenCalledWith(body);
  });

  it.each([
    {
      anchorAllocationId: "allocation-1",
      destinationBedId: "bed-2",
      scope: "UNKNOWN",
    },
    {
      anchorAllocationId: "allocation-1",
      destinationBedId: "bed-2",
      scope: "ALLOCATION_NIGHT",
      previewDigest: `v1:${"a".repeat(64)}`,
    },
    {
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
    },
  ])("rejects invalid, apply, and legacy request shapes", async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("returns the bookings:view guard response before previewing", async () => {
    readGuardMock.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });
    const response = await post({
      anchorAllocationId: "allocation-1",
      destinationBedId: "bed-2",
      scope: "ALLOCATION_NIGHT",
    });

    expect(response.status).toBe(403);
    expect(previewMock).not.toHaveBeenCalled();
  });
});
