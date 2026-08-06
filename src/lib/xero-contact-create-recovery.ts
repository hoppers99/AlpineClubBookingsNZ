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
    responsePayload: {
      path: ["phase"],
      equals: XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE,
    },
  };
}

export async function hasUnresolvedMemberContactCreateRecovery(
  memberId: string,
): Promise<boolean> {
  const operation = await prisma.xeroSyncOperation.findFirst({
    where: unresolvedMemberContactCreateRecoveryWhere(memberId),
    select: { id: true },
  });
  return operation !== null;
}

export async function getMemberContactCreateRecoveryPending(params: {
  memberId: string;
  xeroContactId: string | null;
}): Promise<boolean> {
  if (params.xeroContactId) return false;
  return hasUnresolvedMemberContactCreateRecovery(params.memberId);
}
