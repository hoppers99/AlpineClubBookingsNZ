/**
 * The calling contract every admin bed-allocation operation shares (#2688).
 *
 * Two things, and deliberately nothing else: the database client an operation
 * accepts (the ambient client or a caller's transaction), and the error it
 * throws when it refuses. Every other module in this cluster imports both, so
 * they live here rather than in whichever module happened to be written first.
 */
import type { Prisma } from "@prisma/client";
import type { prisma } from "@/lib/prisma";

export class BedAllocationAdminError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "BedAllocationAdminError";
  }
}

export type BedAllocationDb = typeof prisma | Prisma.TransactionClient;
