import { PrismaClient } from "@prisma/client";

import { createPrismaPgAdapter } from "../../src/lib/prisma-adapter";

type RateLimitCounterSnapshot = Readonly<{
  id: string;
  count: number;
  resetAt: Date;
}>;

/**
 * Read exact counters from the isolated E2E PostgreSQL database.
 *
 * Direct database reads are exceptional in the browser suite. #2599 needs one
 * because an HTTP response alone cannot distinguish the shared Postgres path
 * from the production in-process fallback. This helper is deliberately
 * read-only: it never creates, resets, expires, or deletes a limiter row.
 *
 * `E2E_DATABASE_URL` is exported only by `scripts/e2e-stack.sh`. Passing it
 * explicitly to the adapter prevents dotenv from silently selecting a
 * developer or shared database when the isolated-stack contract is absent.
 */
export async function readRateLimitCounters(
  ids: readonly string[],
): Promise<ReadonlyMap<string, RateLimitCounterSnapshot>> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) {
    throw new Error(
      "E2E_DATABASE_URL is not set. Rate-limit counter evidence must run " +
        "through scripts/e2e-stack.sh against an isolated staging database.",
    );
  }

  const prisma = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
  try {
    const rows = await prisma.rateLimitCounter.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, count: true, resetAt: true },
    });
    return new Map(rows.map((row) => [row.id, Object.freeze(row)]));
  } finally {
    await prisma.$disconnect();
  }
}
