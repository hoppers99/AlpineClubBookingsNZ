import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { xeroSyncOperation: { findFirst } },
}));

import {
  getMemberContactCreateRecoveryPending,
  hasUnresolvedMemberContactCreateRecovery,
  unresolvedMemberContactCreateRecoveryWhere,
} from "@/lib/xero-contact-create-recovery";

describe("unresolved member Xero contact-create recovery proof", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires the exact failed outbound create phase and unresolved operator state", () => {
    expect(unresolvedMemberContactCreateRecoveryWhere("member-1")).toEqual({
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "CREATE",
      localModel: "Member",
      localId: "member-1",
      status: "FAILED",
      manuallyResolvedAt: null,
      responsePayload: {
        path: ["phase"],
        equals: "local_link_after_xero_resolution",
      },
    });
  });

  it("reports pending only when the authoritative query finds a row", async () => {
    findFirst
      .mockResolvedValueOnce({ id: "operation-1" })
      .mockResolvedValueOnce(null);

    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(true);
    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: unresolvedMemberContactCreateRecoveryWhere("member-1"),
      select: { id: true },
    });
  });

  it("returns false for a linked member without querying recovery operations", async () => {
    await expect(
      getMemberContactCreateRecoveryPending({
        memberId: "member-1",
        xeroContactId: "contact-1",
      }),
    ).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
