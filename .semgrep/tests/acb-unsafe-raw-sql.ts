// Fixtures for `.semgrep/rules/acb-unsafe-raw-sql.yml`. Lines marked `ruleid:`
// MUST be reported and lines marked `ok:` MUST NOT be. This directory is
// excluded from the CI scan, because every violation below is deliberate.
//
// The `Static analysis gate` job runs these on every pull request. To run them
// yourself (the same pinned image CI uses):
//
//   docker run --rm -v "$PWD:/src:ro" -w /src semgrep/semgrep:1.161.0 \
//     semgrep --test --config .semgrep/rules .semgrep/tests --metrics=off

declare const prisma: {
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown>;
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
};
declare const tx: typeof prisma;

// The lock statement the induction baseline takes, held in a module constant —
// the permitted shape, and the one this rule must never make impossible.
const INDUCTION_BASELINE_LOCK_SQL = "SELECT pg_advisory_xact_lock(1)";

const COLUMN_MANIFEST = ["id", "createdAt"] as const;

export async function violations(memberId: string, table: string) {
  // ruleid: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe(`SELECT id FROM "Member" WHERE id = '${memberId}'`);
  // ruleid: acb-unsafe-raw-sql
  await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  // ruleid: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe("SELECT id FROM \"Member\" WHERE id = '" + memberId + "'");
  // ruleid: acb-unsafe-raw-sql
  await tx.$executeRawUnsafe("UPDATE \"Member\" SET name = ".concat(memberId));
  // The parameterised overload does NOT make interpolation safe: the string is
  // still built before Prisma sees it.
  // ruleid: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1`, memberId);
}

export async function permitted(memberId: string) {
  // A plain literal — the connectivity probe shape used by
  // `src/instrumentation.node.ts`.
  // ok: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe("SELECT 1");
  // A module-level constant holding a literal, as
  // `src/lib/booking-envelope-invariants.ts` and
  // `src/lib/induction-baseline.ts` both do.
  // ok: acb-unsafe-raw-sql
  await tx.$executeRawUnsafe(INDUCTION_BASELINE_LOCK_SQL);
  // A template literal with no interpolation at all.
  // ok: acb-unsafe-raw-sql
  await prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '5s'`);
  // The SAFE call forms are untouched by this rule: `$queryRaw` as a tagged
  // template binds every `${}` as a parameter.
  // ok: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe(String(COLUMN_MANIFEST.length > 0 ? "SELECT 1" : "SELECT 1"));
  return memberId;
}
