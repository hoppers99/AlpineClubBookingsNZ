import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE =
  "local_link_after_xero_resolution";

export function unresolvedMemberContactCreateRecoveryWhere(
  memberId: string,
): Prisma.XeroSyncOperationWhereInput {
  return {
    direction: "OUTBOUND",
    entityType: "CONTACT",
    operationType: "CREATE",
    localModel: "Member",
    localId: memberId,
    status: "FAILED",
    manuallyResolvedAt: null,
    AND: [
      {
        responsePayload: {
          path: ["phase"],
          equals: XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE,
        },
      },
      {
        responsePayload: {
          path: ["providerContactCreated"],
          equals: true,
        },
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
    record.phase === XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE &&
    record.providerContactCreated === true
  );
}

export async function hasUnresolvedMemberContactCreateRecovery(
  memberId: string,
): Promise<boolean> {
  const operation = await prisma.xeroSyncOperation.findFirst({
    where: unresolvedMemberContactCreateRecoveryWhere(memberId),
    select: { id: true, responsePayload: true },
  });
  return (
    operation !== null &&
    isProviderCreatedLocalLinkFailurePayload(operation.responsePayload)
  );
}

export async function getMemberContactCreateRecoveryPending(params: {
  memberId: string;
  xeroContactId: string | null;
}): Promise<boolean> {
  if (params.xeroContactId) return false;
  return hasUnresolvedMemberContactCreateRecovery(params.memberId);
}
