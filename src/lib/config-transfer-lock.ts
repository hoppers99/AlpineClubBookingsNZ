import type { Prisma } from "@prisma/client";

/**
 * Single-flight configuration import and lodge-identity mutation lock. Lodge
 * create/rename shares this key so an import's bundle-slug to lodge-id mapping
 * cannot change after affected lodge locks are selected.
 */
export async function acquireConfigImportLock(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('config-transfer-import'))`;
}
