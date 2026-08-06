import { describe, expect, it, vi } from "vitest";

import {
  enqueueActiveHostingIncidentPolicyReconciliation,
  type HostingPolicyReconciliationSnapshot,
} from "@/lib/adult-member-hosting-policy-reconciliation";

const club = (
  overrides: Partial<HostingPolicyReconciliationSnapshot> = {},
): HostingPolicyReconciliationSnapshot => ({
  id: "club-policy",
  scopeKey: "club-wide",
  lodgeId: null,
  mode: "ENFORCED",
  capacityMode: "NO_HOLD",
  version: 1,
  hostScopeSameBooking: true,
  hostScopeSameBookingOwner: false,
  ...overrides,
});

const lodge = (
  lodgeId: string,
  overrides: Partial<HostingPolicyReconciliationSnapshot> = {},
): HostingPolicyReconciliationSnapshot => ({
  id: `policy-${lodgeId}`,
  scopeKey: lodgeId,
  lodgeId,
  mode: "INHERIT",
  capacityMode: "NO_HOLD",
  version: 1,
  hostScopeSameBooking: null,
  hostScopeSameBookingOwner: null,
  ...overrides,
});

function incident(id: string, lodgeId: string, memberId = `owner-${id}`) {
  return {
    booking: {
      id: `booking-${id}`,
      memberId,
      lodgeId,
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
    },
  };
}

function dbDouble(params: {
  afterPolicies: HostingPolicyReconciliationSnapshot[];
  incidents: ReturnType<typeof incident>[];
}) {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `queue-${String(data.sourceBookingId)}`,
  }));
  return {
    create,
    db: {
      adultMemberHostingPolicy: {
        findMany: vi.fn().mockResolvedValue(params.afterPolicies),
      },
      hostingCoverageIncident: {
        findMany: vi.fn().mockResolvedValue(params.incidents),
      },
      hostingCoverageReevaluation: { create },
    } as never,
  };
}

describe("adult-hosting policy incident reconciliation", () => {
  it("queues every active incident whose inherited enforcement changed, but not an unaffected override", async () => {
    const before = [
      club(),
      lodge("lodge-b", {
        mode: "ENFORCED",
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: false,
      }),
    ];
    const after = [
      club({ mode: "ADMIN_REVIEW_REQUIRED", version: 2 }),
      before[1],
    ];
    const { db, create } = dbDouble({
      afterPolicies: after,
      incidents: [incident("a", "lodge-a"), incident("b", "lodge-b")],
    });

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before, actorMemberId: "admin-1" },
        db,
      ),
    ).resolves.toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "owner-a",
        lodgeId: "lodge-a",
        nights: ["2026-08-01", "2026-08-02"],
        cause: "SYSTEM_CHANGE",
        sourceBookingId: "booking-a",
        actorMemberId: "admin-1",
      }),
      select: { id: true },
    });
  });

  it("queues a still-enforced incident when its effective host scopes change", async () => {
    const before = [club()];
    const { db, create } = dbDouble({
      afterPolicies: [
        club({
          version: 2,
          hostScopeSameBookingOwner: true,
        }),
      ],
      incidents: [incident("a", "lodge-a")],
    });

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before },
        db,
      ),
    ).resolves.toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not queue for revision or capacity-only changes", async () => {
    const before = [club()];
    const { db, create } = dbDouble({
      afterPolicies: [club({ version: 2, capacityMode: "HOLD" })],
      incidents: [incident("a", "lodge-a")],
    });

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before, actorMemberId: "admin-1" },
        db,
      ),
    ).resolves.toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("propagates an enqueue failure so the authoritative policy transaction can roll back", async () => {
    const before = [club()];
    const { db, create } = dbDouble({
      afterPolicies: [club({ mode: "DISABLED", version: 2 })],
      incidents: [incident("a", "lodge-a")],
    });
    create.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(
      enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies: before },
        db,
      ),
    ).rejects.toThrow("queue unavailable");
  });
});
