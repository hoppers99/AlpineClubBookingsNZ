import type { Prisma } from "@prisma/client";

/**
 * Serialize capacity and roster-eligibility mutations for one immutable lodge
 * id. Kept dependency-light so configuration import does not load the capacity
 * engine or club configuration during bootstrap imports.
 */
export async function acquireLodgeCapacityLock(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  lodgeId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lodgeId}, 0))`;
}
