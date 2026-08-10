import type { Prisma } from "@prisma/client";

/** Acquire canonical partner-link locks in deterministic member-id order. */
export async function acquireMemberPartnerLinkLocks(
  tx: Prisma.TransactionClient,
  memberIds: readonly string[],
): Promise<void> {
  for (const memberId of [...new Set(memberIds.filter(Boolean))].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-partner-link:${memberId}`}))`;
  }
}
