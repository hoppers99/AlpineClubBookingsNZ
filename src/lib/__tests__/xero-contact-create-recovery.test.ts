import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, updateMany } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { xeroSyncOperation: { findFirst, updateMany } },
}));

import {
  getMemberContactCreateRecoveryPending,
  hasMemberContactCreateMergeBlocker,
  hasUnresolvedMemberContactCreateRecovery,
  isProviderCreatedLocalLinkFailurePayload,
  memberContactCreateMergeBlockerWhere,
  recordProviderCreatedContactPendingLocalLink,
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
      manuallyResolvedAt: null,
      OR: [
        {
          status: "FAILED",
          AND: [
            {
              responsePayload: {
                path: ["phase"],
                equals: "local_link_after_xero_resolution",
              },
            },
            {
              responsePayload: {
                path: ["providerContactCreated"],
                equals: true,
              },
            },
          ],
        },
        {
          status: "RUNNING",
          AND: [
            {
              responsePayload: {
                path: ["phase"],
                equals: "provider_contact_created_local_link_pending",
              },
            },
            {
              responsePayload: {
                path: ["providerContactCreated"],
                equals: true,
              },
            },
          ],
        },
      ],
    });
  });

  it("accepts actual provider creation and rejects matched-existing phases", () => {
    expect(
      isProviderCreatedLocalLinkFailurePayload({
        phase: "provider_contact_created_local_link_pending",
        providerContactCreated: true,
      }),
    ).toBe(true);
    expect(
      isProviderCreatedLocalLinkFailurePayload({
        phase: "local_link_after_xero_resolution",
        providerContactCreated: true,
      }),
    ).toBe(true);
    expect(
      isProviderCreatedLocalLinkFailurePayload({
        phase: "local_link_after_xero_resolution",
        providerContactCreated: false,
      }),
    ).toBe(false);
    expect(
      isProviderCreatedLocalLinkFailurePayload({
        phase: "local_link_after_xero_resolution",
      }),
    ).toBe(false);
  });

  it("blocks merge on the exact RUNNING reservation without claiming provider recovery", async () => {
    findFirst
      .mockResolvedValueOnce({ id: "operation-running", status: "RUNNING" })
      .mockResolvedValueOnce({
        id: "operation-running",
        responsePayload: null,
      });

    await expect(
      hasMemberContactCreateMergeBlocker("member-1"),
    ).resolves.toBe(true);
    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(false);
    expect(findFirst).toHaveBeenNthCalledWith(1, {
      where: memberContactCreateMergeBlockerWhere("member-1"),
      select: { id: true, status: true, responsePayload: true },
    });
  });

  it("persists provider-created proof while the operation remains active", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await recordProviderCreatedContactPendingLocalLink({
      operationId: "operation-1",
      resolvedContactId: "contact-1",
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "operation-1",
        status: "RUNNING",
        manuallyResolvedAt: null,
      },
      data: {
        responsePayload: {
          phase: "provider_contact_created_local_link_pending",
          providerContactCreated: true,
          resolvedContactId: "contact-1",
        },
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact-1",
      },
    });
  });

  it("reports pending only when the authoritative query finds a row", async () => {
    findFirst
      .mockResolvedValueOnce({
        id: "operation-1",
        responsePayload: {
          phase: "local_link_after_xero_resolution",
          providerContactCreated: true,
        },
      })
      .mockResolvedValueOnce({
        id: "operation-2",
        responsePayload: {
          phase: "local_link_after_xero_resolution",
          providerContactCreated: false,
        },
      })
      .mockResolvedValueOnce(null);

    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(true);
    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(false);
    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: unresolvedMemberContactCreateRecoveryWhere("member-1"),
      select: { id: true, responsePayload: true },
    });
  });

  it("keeps the next authoritative member GET in recovery while the durable pre-link marker is active", async () => {
    findFirst.mockResolvedValue({
      id: "operation-running",
      responsePayload: {
        phase: "provider_contact_created_local_link_pending",
        providerContactCreated: true,
        resolvedContactId: "contact-provider-only",
      },
    });

    await expect(
      getMemberContactCreateRecoveryPending({
        memberId: "member-1",
        xeroContactId: null,
      }),
    ).resolves.toBe(true);
  });

  it("can run the strict proof lookup on an in-flight transaction client", async () => {
    const txFindFirst = vi.fn().mockResolvedValue({
      id: "operation-tx",
      responsePayload: {
        phase: "local_link_after_xero_resolution",
        providerContactCreated: true,
      },
    });

    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-tx", {
        xeroSyncOperation: { findFirst: txFindFirst } as never,
      }),
    ).resolves.toBe(true);
    expect(txFindFirst).toHaveBeenCalledWith({
      where: unresolvedMemberContactCreateRecoveryWhere("member-tx"),
      select: { id: true, responsePayload: true },
    });
    expect(findFirst).not.toHaveBeenCalled();
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
