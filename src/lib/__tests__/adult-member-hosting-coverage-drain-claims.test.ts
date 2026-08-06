import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  loadPolicy: vi.fn(),
  loadDependents: vi.fn(),
  reconcile: vi.fn(),
  claimNotification: vi.fn(),
  completeNotification: vi.fn(),
  releaseNotification: vi.fn(),
  resolveIncidents: vi.fn(),
  sendEmail: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/adult-member-hosting-coverage-queue", () => ({
  claimHostingCoverageReevaluations: mocks.claim,
  completeHostingCoverageReevaluation: mocks.complete,
  failHostingCoverageReevaluation: mocks.fail,
}));

vi.mock("@/lib/adult-member-hosting-coverage-incidents", () => ({
  claimHostingCoverageOwnerNotification: mocks.claimNotification,
  completeHostingCoverageOwnerNotification: mocks.completeNotification,
  releaseHostingCoverageOwnerNotification: mocks.releaseNotification,
  resolveHostingCoverageIncidents: mocks.resolveIncidents,
}));

vi.mock("@/lib/adult-member-hosting-review", () => ({
  loadAdultMemberHostingPolicy: mocks.loadPolicy,
  loadSameOwnerCoverageDependentIds: mocks.loadDependents,
  reconcileSameOwnerCoverageIncident: mocks.reconcile,
}));

vi.mock("@/lib/email/booking", () => ({
  sendHostingCoverageLostEmail: mocks.sendEmail,
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: mocks.warn, error: mocks.error },
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { drainHostingCoverageReevaluations } from "@/lib/adult-member-hosting-coverage-drain";

const CLAIMED_ITEM = {
  id: "queue-1",
  memberId: "owner-1",
  lodgeId: "lodge-a",
  nights: ["2026-07-03"],
  cause: "SYSTEM_CHANGE" as const,
  sourceBookingId: null,
  actorMemberId: null,
  reason: null,
  attempts: 1,
  claimToken: "claim-current",
};

function makeDb() {
  return {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({}),
    ),
  } as any;
}

describe("hosting coverage drain claim fences (#2596)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue([{ ...CLAIMED_ITEM }]);
    mocks.complete.mockResolvedValue(true);
    mocks.fail.mockResolvedValue(true);
    mocks.loadPolicy.mockResolvedValue({
      hostScopes: { sameBookingOwner: true },
    });
    mocks.loadDependents.mockResolvedValue([]);
    mocks.resolveIncidents.mockResolvedValue(0);
  });

  it("does not count work as processed when completion loses the exact claim", async () => {
    mocks.complete.mockResolvedValue(false);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 0 });
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "queue-1", claimToken: "claim-current" }),
      expect.anything(),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "queue-1" }),
      expect.stringContaining("claim was replaced"),
    );
  });

  it("does not attribute a failure to a worker after its claim was replaced", async () => {
    mocks.loadPolicy.mockRejectedValue(new Error("reconciliation failed"));
    mocks.fail.mockResolvedValue(false);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 0 });
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "queue-1", claimToken: "claim-current" }),
      "reconciliation failed",
      expect.anything(),
    );
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "queue-1" }),
      expect.stringContaining("claim was replaced"),
    );
  });
});
