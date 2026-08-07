import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type ContactCreateRecoveryDb = Pick<
  Prisma.TransactionClient,
  "xeroSyncOperation"
>;

export const XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE =
  "local_link_after_xero_resolution";
export const XERO_CONTACT_CREATE_PROVIDER_CREATED_PENDING_LINK_PHASE =
  "provider_contact_created_local_link_pending";
export const XERO_CONTACT_CREATE_STALE_RUNNING_ERROR_CODE =
  "ORPHANED_STALE_RUNNING";

export type MemberContactCreateRecoveryState =
  | "CREATE_IN_PROGRESS"
  | "PROVIDER_CREATED_LINK_PENDING";

const contactCreateIdentityWhere = (memberId: string) => ({
  direction: "OUTBOUND",
  entityType: "CONTACT",
  operationType: "CREATE",
  localModel: "Member",
  localId: memberId,
  manuallyResolvedAt: null,
}) satisfies Prisma.XeroSyncOperationWhereInput;

const providerCreatedPayloadWhere = (phase: string) => [
  {
    responsePayload: {
      path: ["phase"],
      equals: phase,
    },
  },
  {
    responsePayload: {
      path: ["providerContactCreated"],
      equals: true,
    },
  },
] satisfies Prisma.XeroSyncOperationWhereInput[];

export function ambiguousMemberContactCreateReservationWhere(
  memberId: string,
): Prisma.XeroSyncOperationWhereInput {
  return {
    ...contactCreateIdentityWhere(memberId),
    OR: [
      { status: "RUNNING" },
      {
        status: "FAILED",
        lastErrorCode: XERO_CONTACT_CREATE_STALE_RUNNING_ERROR_CODE,
      },
    ],
  };
}

export function unresolvedMemberContactCreateRecoveryWhere(
  memberId: string,
): Prisma.XeroSyncOperationWhereInput {
  return {
    ...contactCreateIdentityWhere(memberId),
    OR: [
      {
        status: "FAILED",
        AND: providerCreatedPayloadWhere(
          XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE,
        ),
      },
      {
        status: { in: ["RUNNING", "FAILED"] },
        AND: providerCreatedPayloadWhere(
          XERO_CONTACT_CREATE_PROVIDER_CREATED_PENDING_LINK_PHASE,
        ),
      },
    ],
  };
}

export function memberContactCreateMergeBlockerWhere(
  memberId: string,
): Prisma.XeroSyncOperationWhereInput {
  return {
    ...contactCreateIdentityWhere(memberId),
    OR: [
      { status: "RUNNING" },
      {
        status: "FAILED",
        lastErrorCode: XERO_CONTACT_CREATE_STALE_RUNNING_ERROR_CODE,
      },
      {
        status: "FAILED",
        OR: [
          {
            AND: providerCreatedPayloadWhere(
              XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE,
            ),
          },
          {
            AND: providerCreatedPayloadWhere(
              XERO_CONTACT_CREATE_PROVIDER_CREATED_PENDING_LINK_PHASE,
            ),
          },
        ],
      },
    ],
  };
}

export function isProviderCreatedLocalLinkFailurePayload(
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  return (
    (record.phase === XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE ||
      record.phase ===
        XERO_CONTACT_CREATE_PROVIDER_CREATED_PENDING_LINK_PHASE) &&
    record.providerContactCreated === true
  );
}

export async function recordProviderCreatedContactPendingLocalLink(params: {
  operationId: string;
  resolvedContactId: string;
  db?: ContactCreateRecoveryDb;
}): Promise<void> {
  const db = params.db ?? prisma;
  const updated = await db.xeroSyncOperation.updateMany({
    where: {
      id: params.operationId,
      status: "RUNNING",
      manuallyResolvedAt: null,
    },
    data: {
      responsePayload: {
        phase: XERO_CONTACT_CREATE_PROVIDER_CREATED_PENDING_LINK_PHASE,
        providerContactCreated: true,
        resolvedContactId: params.resolvedContactId,
      },
      xeroObjectType: "CONTACT",
      xeroObjectId: params.resolvedContactId,
    },
  });
  if (updated.count !== 1) {
    throw new Error(
      `Could not record provider-created Xero contact for operation ${params.operationId}`,
    );
  }
}

export async function hasUnresolvedMemberContactCreateRecovery(
  memberId: string,
  db: ContactCreateRecoveryDb = prisma,
): Promise<boolean> {
  const operation = await db.xeroSyncOperation.findFirst({
    where: unresolvedMemberContactCreateRecoveryWhere(memberId),
    select: { id: true, responsePayload: true },
  });
  return (
    operation !== null &&
    isProviderCreatedLocalLinkFailurePayload(operation.responsePayload)
  );
}

export async function hasMemberContactCreateMergeBlocker(
  memberId: string,
  db: ContactCreateRecoveryDb = prisma,
): Promise<boolean> {
  const operation = await db.xeroSyncOperation.findFirst({
    where: memberContactCreateMergeBlockerWhere(memberId),
    select: {
      id: true,
      status: true,
      lastErrorCode: true,
      responsePayload: true,
    },
  });
  return (
    operation !== null &&
    (operation.status === "RUNNING" ||
      (operation.status === "FAILED" &&
        operation.lastErrorCode ===
          XERO_CONTACT_CREATE_STALE_RUNNING_ERROR_CODE) ||
      isProviderCreatedLocalLinkFailurePayload(operation.responsePayload))
  );
}

export async function getMemberContactCreateRecoveryPending(params: {
  memberId: string;
  xeroContactId: string | null;
}): Promise<boolean> {
  if (params.xeroContactId) return false;
  return hasUnresolvedMemberContactCreateRecovery(params.memberId);
}

export async function getMemberContactCreateRecoveryState(params: {
  memberId: string;
  xeroContactId: string | null;
}): Promise<MemberContactCreateRecoveryState | null> {
  if (params.xeroContactId) return null;
  if (await hasUnresolvedMemberContactCreateRecovery(params.memberId)) {
    return "PROVIDER_CREATED_LINK_PENDING";
  }
  const reservation = await prisma.xeroSyncOperation.findFirst({
    where: ambiguousMemberContactCreateReservationWhere(params.memberId),
    select: { id: true },
  });
  return reservation ? "CREATE_IN_PROGRESS" : null;
}
