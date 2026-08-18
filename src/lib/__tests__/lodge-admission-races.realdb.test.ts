/**
 * Real-PostgreSQL probes for the shared lodge lock introduced by #2701.
 * Imported by concurrency-lock-races.realdb.test.ts; skipped unless its guarded
 * disposable loopback database is explicitly enabled.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const TIMEOUT_MS = 30_000;
const LODGE_TABLE = '"_race_2701_lodge"';
const ASSIGNMENT_TABLE = '"_race_2701_assignment"';

let prisma: typeof import("@/lib/prisma")["prisma"];
let clientA: PrismaClient;
let clientB: PrismaClient;
let acquireLodgeCapacityLock: typeof import("@/lib/capacity")["acquireLodgeCapacityLock"];
let acquireConfigImportLock: typeof import("@/lib/config-transfer-lock")["acquireConfigImportLock"];

function assertSafeUrl(value: string): void {
  const parsed = new URL(value);
  const port = Number.parseInt(parsed.port, 10);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    !Number.isFinite(port) ||
    port < 55442 ||
    !name.includes("concurrency_race_1881")
  ) {
    throw new Error("Lodge admission races require the guarded disposable concurrency database.");
  }
}

async function admit(tx: Prisma.TransactionClient, lodgeId: string): Promise<boolean> {
  await acquireLodgeCapacityLock(tx, lodgeId);
  const rows = await tx.$queryRaw<Array<{ active: boolean }>>`
    SELECT active FROM "_race_2701_lodge" WHERE lodge_id = ${lodgeId}
  `;
  if (!rows[0]?.active) return false;
  await tx.$executeRaw`
    UPDATE "_race_2701_lodge" SET admissions = admissions + 1 WHERE lodge_id = ${lodgeId}
  `;
  return true;
}

async function deactivate(tx: Prisma.TransactionClient, lodgeId: string): Promise<boolean> {
  await acquireConfigImportLock(tx);
  await acquireLodgeCapacityLock(tx, lodgeId);
  const rows = await tx.$queryRaw<Array<{ other_active: number; admissions: number }>>`
    SELECT
      COUNT(*) FILTER (WHERE active = true AND lodge_id <> ${lodgeId})::int AS other_active,
      COALESCE(MAX(admissions) FILTER (WHERE lodge_id = ${lodgeId}), 0)::int AS admissions
    FROM "_race_2701_lodge"
  `;
  if ((rows[0]?.other_active ?? 0) === 0 || (rows[0]?.admissions ?? 0) > 0) return false;
  await tx.$executeRaw`
    UPDATE "_race_2701_lodge" SET active = false WHERE lodge_id = ${lodgeId}
  `;
  return true;
}

async function assign(
  tx: Prisma.TransactionClient,
  lodgeId: string,
  startDay: number,
  endDay: number,
): Promise<boolean> {
  await acquireLodgeCapacityLock(tx, lodgeId);
  const rows = await tx.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count
    FROM "_race_2701_assignment"
    WHERE lodge_id = ${lodgeId}
      AND start_day <= ${endDay}
      AND end_day >= ${startDay}
  `;
  if ((rows[0]?.count ?? 0) > 0) return false;
  await tx.$executeRaw`
    INSERT INTO "_race_2701_assignment" (lodge_id, start_day, end_day)
    VALUES (${lodgeId}, ${startDay}, ${endDay})
  `;
  return true;
}

(RUN ? describe : describe.skip)(
  "lodge admission/deactivation/assignment races - real PostgreSQL (#2701)",
  { timeout: TIMEOUT_MS },
  () => {
    beforeAll(async () => {
      assertSafeUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ acquireLodgeCapacityLock } = await import("@/lib/capacity"));
      ({ acquireConfigImportLock } = await import("@/lib/config-transfer-lock"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
      clientA = new SeparatePrismaClient({ adapter: createPrismaPgAdapter(RACE_DB_URL) });
      clientB = new SeparatePrismaClient({ adapter: createPrismaPgAdapter(RACE_DB_URL) });
      await Promise.all([clientA.$connect(), clientB.$connect()]);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${ASSIGNMENT_TABLE}`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${LODGE_TABLE}`);
      await prisma.$executeRawUnsafe(
        `CREATE TABLE ${LODGE_TABLE} (lodge_id text PRIMARY KEY, active boolean NOT NULL, admissions integer NOT NULL DEFAULT 0)`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TABLE ${ASSIGNMENT_TABLE} (id bigserial PRIMARY KEY, lodge_id text NOT NULL, start_day integer NOT NULL, end_day integer NOT NULL)`,
      );
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(`TRUNCATE ${ASSIGNMENT_TABLE}, ${LODGE_TABLE}`);
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${LODGE_TABLE} (lodge_id, active) VALUES ('lodge-a', true), ('lodge-b', true)`,
      );
    });

    afterAll(async () => {
      if (!prisma) return;
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${ASSIGNMENT_TABLE}`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${LODGE_TABLE}`);
      await Promise.all([clientA?.$disconnect(), clientB?.$disconnect()]);
    });

    it("cannot admit after a concurrent deactivation and keeps one of the last two lodges active", async () => {
      const [deactivated, admitted] = await Promise.all([
        clientA.$transaction((tx) => deactivate(tx, "lodge-a")),
        clientB.$transaction((tx) => admit(tx, "lodge-a")),
      ]);
      const lodgeA = await prisma.$queryRaw<Array<{ active: boolean; admissions: number }>>`
        SELECT active, admissions FROM "_race_2701_lodge" WHERE lodge_id = 'lodge-a'
      `;
      expect(deactivated && admitted).toBe(false);
      expect(lodgeA[0]).toEqual(
        deactivated ? { active: false, admissions: 0 } : { active: true, admissions: 1 },
      );

      await prisma.$executeRawUnsafe(`UPDATE ${LODGE_TABLE} SET active = true, admissions = 0`);
      const results = await Promise.all([
        clientA.$transaction((tx) => deactivate(tx, "lodge-a")),
        clientB.$transaction((tx) => deactivate(tx, "lodge-b")),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const active = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM "_race_2701_lodge" WHERE active = true
      `;
      expect(active[0]?.count).toBe(1);
    });

    it("permits one overlapping same-lodge assignment but independent cross-lodge assignments", async () => {
      const sameLodge = await Promise.all([
        clientA.$transaction((tx) => assign(tx, "lodge-a", 10, 12)),
        clientB.$transaction((tx) => assign(tx, "lodge-a", 11, 13)),
      ]);
      expect(sameLodge.filter(Boolean)).toHaveLength(1);

      await prisma.$executeRawUnsafe(`TRUNCATE ${ASSIGNMENT_TABLE}`);
      const crossLodge = await Promise.all([
        clientA.$transaction((tx) => assign(tx, "lodge-a", 10, 12)),
        clientB.$transaction((tx) => assign(tx, "lodge-b", 11, 13)),
      ]);
      expect(crossLodge).toEqual([true, true]);
    });
  },
);
