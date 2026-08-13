// Fixtures for `.semgrep/rules/acb-unsafe-raw-sql.yml`. Lines marked `ruleid:`
// MUST be reported and lines marked `ok:` MUST NOT be. This directory is
// excluded from the CI scan, because every violation below is deliberate.
//
// The `Static analysis gate` job runs these on every pull request. To run them
// yourself (the same pinned image CI uses):
//
//   docker run --rm -v "$PWD:/src:ro" -w /src semgrep/semgrep:1.161.0 \
//     semgrep --test --config .semgrep/rules .semgrep/tests --metrics=off
//
// `semgrep --test` passes vacuously when a fixture is MISSING — an empty
// directory exits 0 with "No unit tests found" — so
// `src/lib/__tests__/semgrep-rule-fixtures.test.ts` separately asserts that
// every rule file has a same-basename fixture carrying both a `ruleid:` and an
// `ok:` line for each rule id it declares.

declare const prisma: {
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown>;
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
};
declare const tx: typeof prisma;
declare const Prisma: {
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
  raw: (value: string) => unknown;
  join: (values: unknown[]) => unknown;
};

// The lock statement the induction baseline takes, held in a module constant —
// the permitted shape, and the one this rule must never make impossible.
const INDUCTION_BASELINE_LOCK_SQL = "SELECT pg_advisory_xact_lock(1)";

const COLUMN_MANIFEST = ["id", "createdAt"] as const;

export async function violationsInline(memberId: string, table: string) {
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

// Everything below is a shape the first, syntactic version of this rule walked
// straight past. Each is the same defect written one step apart.

export async function violationsIndirect(memberId: string, table: string) {
  // Built one statement earlier and passed by name. This is how the single
  // permitted site in `src/` is written, so a rule that cannot see it cannot
  // see the code it was written for.
  const sql = `SELECT id FROM "Member" WHERE id = '${memberId}'`;
  // ruleid: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe(sql);

  // Accumulated with `+=`.
  let accumulated = "SELECT id FROM \"Member\"";
  accumulated += ` WHERE id = '${memberId}'`;
  // ruleid: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe(accumulated);

  // Assembled with `.join()`.
  const joined = ["SELECT", "id", "FROM", `"${table}"`].join(" ");
  // ruleid: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe(joined);

  // Assembled with `.replace()` against a placeholder.
  const substituted = "SELECT id FROM :table".replace(":table", table);
  // ruleid: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe(substituted);
}

function buildMemberLookup(memberId: string): string {
  return `SELECT id FROM "Member" WHERE id = '${memberId}'`;
}

export async function violationsViaHelper(memberId: string) {
  // Returned by a helper.
  const sql = buildMemberLookup(memberId);
  // ruleid: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe(sql);
}

export async function violationsViaReceiver(memberId: string, table: string) {
  // Destructured receiver.
  const { $queryRawUnsafe } = prisma;
  // ruleid: acb-unsafe-raw-sql
  await $queryRawUnsafe(`SELECT id FROM "${table}"`);

  // Bound receiver. The ALIAS is the violation, reported here — by the time the
  // call is written as `run(sql)` there is nothing left at the call site to
  // recognise, so `acb-unsafe-raw-sql-alias` catches it one line earlier. The
  // call below is deliberately unannotated: it is not reported, and it is not
  // `ok:` either, because what makes it safe is that the line above is red.
  // ruleid: acb-unsafe-raw-sql-alias
  const run = prisma.$executeRawUnsafe.bind(prisma);
  await run(`DELETE FROM "Member" WHERE id = '${memberId}'`);

  // Binding the SAFE tagged-template method is not the same defect and must not
  // be reported: `$executeRaw` binds every `${}` wherever it is finally called.
  // ok: acb-unsafe-raw-sql-alias
  const runSafe = prisma.$executeRaw.bind(prisma);
  await runSafe`DELETE FROM "Member" WHERE id = ${memberId}`;

  // Computed member access.
  // ruleid: acb-unsafe-raw-sql
  await prisma["$queryRawUnsafe"](`SELECT id FROM "${table}"`);
}

async function runRaw(sql: string) {
  // A wrapper whose caller does the interpolation. The parameter is not visibly
  // static here, so this is reported here — which is the right place, because
  // this is the line that decides to send an argument it cannot see.
  // ruleid: acb-unsafe-raw-sql
  return prisma.$queryRawUnsafe(sql);
}

// A rule that requires the argument to be VISIBLY STATIC also reports the
// no-op-looking cases below, and that is deliberate rather than tolerated: a
// reader at the call site cannot tell any of them apart from the tainted ones.
declare const SAFE_STATEMENTS: Record<string, string>;
export async function opaqueButProbablyFine(key: string) {
  // ruleid: acb-unsafe-raw-sql
  await prisma.$queryRawUnsafe(SAFE_STATEMENTS[key]);
}

export async function violationsViaWrapper(table: string) {
  return runRaw(`SELECT id FROM "${table}"`);
}

export async function permitted(memberId: string, table: string) {
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

  // The SAFE call forms this rule's message points at. Every one of them
  // interpolates — that is the point — and none of them is a finding, because
  // none of them reaches an `Unsafe` sink. Promised by the old fixture's prose
  // and never actually written down until #2686's review asked for them.
  //
  // `$queryRaw` as a tagged template: each `${}` becomes a bound parameter.
  // ok: acb-unsafe-raw-sql
  await prisma.$queryRaw`SELECT id FROM "Member" WHERE id = ${memberId}`;
  // `$executeRaw` likewise.
  // ok: acb-unsafe-raw-sql
  await prisma.$executeRaw`DELETE FROM "Member" WHERE id = ${memberId}`;
  // `Prisma.sql` composition.
  const fragment = Prisma.sql`WHERE id = ${memberId}`;
  // ok: acb-unsafe-raw-sql
  await prisma.$queryRaw`SELECT id FROM "Member" ${fragment}`;
  // `Prisma.raw()` for an identifier validated against a fixed allowlist.
  const column = COLUMN_MANIFEST.includes(table as (typeof COLUMN_MANIFEST)[number])
    ? table
    : "id";
  // ok: acb-unsafe-raw-sql
  await prisma.$queryRaw`SELECT ${Prisma.raw(column)} FROM "Member"`;

  return memberId;
}
