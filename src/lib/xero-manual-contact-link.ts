import type { PrismaClient } from "@prisma/client";

import { buildXeroContactUrl } from "@/lib/xero-links";
import { lockMemberForManualXeroContactLink } from "@/lib/xero-contact-create-recovery";
import { prisma } from "@/lib/prisma";
import { upsertXeroObjectLink } from "@/lib/xero-sync";

/**
 * Commit the Member pointer and its FK-less canonical CONTACT ledger row under
 * one exact target-Member FOR UPDATE fence. Provider lookup/cache work belongs
 * outside this helper and outside the transaction.
 */
export async function commitManualXeroContactLink(
  input: {
    memberId: string;
    xeroContactId: string;
    contactName: string | null;
  },
  db: PrismaClient = prisma,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockMemberForManualXeroContactLink(tx, input.memberId);
    await tx.member.update({
      where: { id: input.memberId },
      data: { xeroContactId: input.xeroContactId },
    });
    // `XeroObjectLink.localId` has no FK. Keeping this write in the same
    // transaction prevents merge from deleting the loser between the pointer
    // update and ledger upsert.
    await upsertXeroObjectLink(
      {
        localModel: "Member",
        localId: input.memberId,
        xeroObjectType: "CONTACT",
        xeroObjectId: input.xeroContactId,
        xeroObjectUrl: buildXeroContactUrl(input.xeroContactId),
        role: "CONTACT",
        metadata: {
          contactName: input.contactName,
          linkedManually: true,
        },
      },
      { store: tx },
    );
  });
}
