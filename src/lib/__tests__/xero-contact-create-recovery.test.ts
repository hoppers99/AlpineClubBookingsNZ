import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, updateMany } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { xeroSyncOperation: { findFirst, updateMany } },
}));

import {
  ambiguousMemberContactCreateReservationWhere,
  assertNoMemberContactCreateBlockerForDeletion,
  getMemberContactCreateRecoveryPending,
  getMemberContactCreateRecoveryState,
  hasMemberContactCreateMergeBlocker,
  hasUnresolvedMemberContactCreateRecovery,
  isProviderCreatedLocalLinkFailurePayload,
  lockMemberForManualXeroContactLink,
  memberContactCreateMergeBlockerWhere,
  recordProviderCreatedContactPendingLocalLink,
  unresolvedMemberContactCreateRecoveryWhere,
  XERO_CONTACT_CREATE_IN_PROGRESS_CODE,
  XERO_CONTACT_CREATE_IN_PROGRESS_MESSAGE,
  XERO_MEMBER_UNAVAILABLE_CODE,
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
          status: { in: ["RUNNING", "FAILED"] },
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

  it("locks the target member before refusing a manual link against an ambiguous create", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const memberFindUnique = vi.fn().mockResolvedValue({
      id: "member-1",
      email: "member@example.test",
      passwordHash: null,
      xeroContactId: null,
    });
    const operationFindFirst = vi.fn().mockResolvedValue({ id: "operation-1" });

    await expect(
      lockMemberForManualXeroContactLink(
        {
          $executeRaw: executeRaw,
          member: { findUnique: memberFindUnique } as never,
          xeroSyncOperation: { findFirst: operationFindFirst } as never,
        },
        "member-1",
      ),
    ).rejects.toMatchObject({
      code: XERO_CONTACT_CREATE_IN_PROGRESS_CODE,
      statusCode: 409,
      message: XERO_CONTACT_CREATE_IN_PROGRESS_MESSAGE,
    });
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      operationFindFirst.mock.invocationCallOrder[0],
    );
    expect(operationFindFirst).toHaveBeenCalledWith({
      where: ambiguousMemberContactCreateReservationWhere("member-1"),
      select: { id: true },
    });
  });

  it("refuses an anonymised member under the manual-link row lock before reading create operations", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const memberFindUnique = vi.fn().mockResolvedValue({
      id: "member-1",
      email: "deleted-member@deleted.invalid",
      passwordHash: "DELETED_ACCOUNT",
      xeroContactId: null,
    });
    const operationFindFirst = vi.fn();

    await expect(
      lockMemberForManualXeroContactLink(
        {
          $executeRaw: executeRaw,
          member: { findUnique: memberFindUnique } as never,
          xeroSyncOperation: { findFirst: operationFindFirst } as never,
        },
        "member-1",
      ),
    ).rejects.toMatchObject({
      code: XERO_MEMBER_UNAVAILABLE_CODE,
      statusCode: 409,
    });
    expect(operationFindFirst).not.toHaveBeenCalled();
  });

  it.each([
    [
      "running",
      { id: "running", status: "RUNNING", lastErrorCode: null, responsePayload: null },
    ],
    [
      "stale orphaned",
      {
        id: "stale",
        status: "FAILED",
        lastErrorCode: "ORPHANED_STALE_RUNNING",
        responsePayload: null,
      },
    ],
    [
      "provider-created link pending",
      {
        id: "provider-created",
        status: "FAILED",
        lastErrorCode: null,
        responsePayload: {
          phase: "provider_contact_created_local_link_pending",
          providerContactCreated: true,
        },
      },
    ],
  ])("blocks deletion on the complete %s recovery proof", async (_label, operation) => {
    const operationFindFirst = vi.fn().mockResolvedValue(operation);

    await expect(
      assertNoMemberContactCreateBlockerForDeletion("member-1", {
        xeroSyncOperation: { findFirst: operationFindFirst } as never,
      }),
    ).rejects.toMatchObject({
      code: "XERO_CONTACT_CREATE_BLOCKS_DELETION",
      statusCode: 409,
    });
    expect(operationFindFirst).toHaveBeenCalledWith({
      where: memberContactCreateMergeBlockerWhere("member-1"),
      select: {
        id: true,
        status: true,
        lastErrorCode: true,
        responsePayload: true,
      },
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
      select: {
        id: true,
        status: true,
        lastErrorCode: true,
        responsePayload: true,
      },
    });
  });

  it("keeps stale-reset pending-link proof unresolved and merge-blocking", async () => {
    const staleResetProof = {
      id: "operation-stale-reset",
      status: "FAILED",
      responsePayload: {
        phase: "provider_contact_created_local_link_pending",
        providerContactCreated: true,
        resolvedContactId: "contact-provider-only",
      },
    };
    findFirst
      .mockResolvedValueOnce(staleResetProof)
      .mockResolvedValueOnce(staleResetProof);

    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(true);
    await expect(
      hasMemberContactCreateMergeBlocker("member-1"),
    ).resolves.toBe(true);
    expect(unresolvedMemberContactCreateRecoveryWhere("member-1")).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            status: { in: ["RUNNING", "FAILED"] },
          }),
        ]),
      }),
    );
    expect(memberContactCreateMergeBlockerWhere("member-1")).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            status: "FAILED",
            OR: expect.arrayContaining([
              expect.objectContaining({
                AND: expect.arrayContaining([
                  expect.objectContaining({
                    responsePayload: {
                      path: ["phase"],
                      equals:
                        "provider_contact_created_local_link_pending",
                    },
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it("reports an unmarked RUNNING reservation without claiming provider creation", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "operation-running" });

    await expect(
      getMemberContactCreateRecoveryState({
        memberId: "member-1",
        xeroContactId: null,
      }),
    ).resolves.toBe("CREATE_IN_PROGRESS");
  });

  it("keeps an unmarked stale-reset reservation ambiguous until resolution", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "operation-stale-reset" })
      .mockResolvedValueOnce({
        id: "operation-stale-reset",
        status: "FAILED",
        lastErrorCode: "ORPHANED_STALE_RUNNING",
        responsePayload: null,
      });

    await expect(
      getMemberContactCreateRecoveryState({
        memberId: "member-1",
        xeroContactId: null,
      }),
    ).resolves.toBe("CREATE_IN_PROGRESS");
    expect(findFirst).toHaveBeenNthCalledWith(2, {
      where: ambiguousMemberContactCreateReservationWhere("member-1"),
      select: { id: true },
    });
    expect(ambiguousMemberContactCreateReservationWhere("member-1")).toEqual(
      expect.objectContaining({
        manuallyResolvedAt: null,
        OR: [
          { status: "RUNNING" },
          {
            status: "FAILED",
            lastErrorCode: "ORPHANED_STALE_RUNNING",
          },
        ],
      }),
    );
    await expect(
      hasMemberContactCreateMergeBlocker("member-1"),
    ).resolves.toBe(true);
  });

  it("retains the stronger state for stale-reset provider-created proof", async () => {
    findFirst.mockResolvedValueOnce({
      id: "operation-stale-reset",
      responsePayload: {
        phase: "provider_contact_created_local_link_pending",
        providerContactCreated: true,
      },
    });

    await expect(
      getMemberContactCreateRecoveryState({
        memberId: "member-1",
        xeroContactId: null,
      }),
    ).resolves.toBe("PROVIDER_CREATED_LINK_PENDING");
    expect(findFirst).toHaveBeenCalledTimes(1);
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
