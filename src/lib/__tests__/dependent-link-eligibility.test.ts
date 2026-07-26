import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import {
  DEPENDENT_LINK_INELIGIBILITY_ERRORS,
  DEPENDENT_LINK_INELIGIBILITY_EXPLANATIONS,
  DEPENDENT_LINK_INELIGIBILITY_REASONS,
  dependentLinkBlockers,
  dependentLinkCandidateWhere,
  type DependentLinkCandidate,
} from "@/lib/dependent-link-eligibility";

/**
 * #2254. The dependant-link candidate search returned "No eligible members
 * found" for perfectly valid members, because `{ not: parentId }` on the
 * NULLABLE `parentMemberId` / `secondaryParentId` columns compiles to a bare
 * `"col" <> $1`, and `NULL <> 'x'` is UNKNOWN in SQL — so every member with no
 * parent recorded was silently dropped.
 *
 * A mocked Prisma client cannot catch that: the fault is not in the JS object
 * we hand to Prisma, it is in the SQL Prisma compiles it to. So this suite does
 * not mock Prisma. It:
 *
 *   1. lets the REAL Prisma client compile the real `where` to real SQL,
 *      captured through a driver adapter that records instead of connecting
 *      (no database, no DATABASE_URL, no network); then
 *   2. executes that SQL over fixture rows in an in-memory SQLite database
 *      (`node:sqlite`), because SQL's three-valued NULL logic — the entire
 *      subject of this bug — is identical in SQLite and Postgres.
 *
 * What that proves: the compiled predicate returns the right members, NULLs
 * included. What it does not prove: Postgres-specific behaviour (collations,
 * `mode: "insensitive"` ILIKE, index use). Those are out of scope here — the
 * eligibility predicate uses only equality, IS NULL, and NOT EXISTS.
 */

// ── The recording driver adapter ────────────────────────────────────────────

type CapturedQuery = { sql: string; args: unknown[] };

function recordingAdapterFactory(captured: CapturedQuery[]) {
  const queryable = {
    provider: "postgres" as const,
    adapterName: "@prisma/adapter-pg",
    async queryRaw(params: CapturedQuery) {
      captured.push({ sql: params.sql, args: params.args });
      return { columnTypes: [], columnNames: [], rows: [] };
    },
    async executeRaw(params: CapturedQuery) {
      captured.push({ sql: params.sql, args: params.args });
      return 0;
    },
    async executeScript() {},
    async startTransaction(): Promise<never> {
      throw new Error("the SQL probe never opens a transaction");
    },
    async dispose() {},
    getConnectionInfo() {
      return { supportsRelationJoins: false };
    },
  };

  return {
    provider: "postgres" as const,
    adapterName: "@prisma/adapter-pg",
    async connect() {
      return queryable;
    },
  };
}

/** Compile a `Member.findMany` where clause to SQL without touching a database. */
async function compileMemberWhereToSql(
  where: Record<string, unknown>,
): Promise<CapturedQuery> {
  const captured: CapturedQuery[] = [];
  const prisma = new PrismaClient({
    adapter: recordingAdapterFactory(captured) as never,
  });
  await prisma.member.findMany({ where, select: { id: true } });
  expect(captured).toHaveLength(1);
  return captured[0];
}

/**
 * Postgres -> SQLite, for the narrow shape Prisma emits here: drop the schema
 * qualifier, drop the trailing paging clause (we only exercise the predicate),
 * and turn `$n` into positional `?`. The ascending-order assertion is what
 * makes positional binding safe; if Prisma ever emits placeholders out of
 * order this fails loudly rather than binding the wrong values.
 */
function toSqliteSelect(query: CapturedQuery) {
  const whereAt = query.sql.indexOf(" WHERE ");
  expect(whereAt).toBeGreaterThan(-1);
  const pagingAt = Math.min(
    ...[" OFFSET ", " LIMIT "]
      .map((token) => query.sql.indexOf(token, whereAt))
      .filter((index) => index > -1)
      .concat([query.sql.length]),
  );

  const clause = query.sql
    .slice(whereAt + " WHERE ".length, pagingAt)
    .replaceAll('"public".', "");

  const placeholders = [...clause.matchAll(/\$(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  expect(placeholders).toEqual(placeholders.map((_, index) => index + 1));

  return {
    sql: `SELECT "id" FROM "Member" WHERE ${clause.replaceAll(/\$\d+/g, "?")}`,
    args: query.args.slice(0, placeholders.length),
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const PARENT_ID = "parent-1";

type Fixture = DependentLinkCandidate & {
  firstName: string;
  active: boolean;
};

/**
 * One row per case the issue calls out, plus the parent themself. `eligible` is
 * the expectation both halves of the predicate must agree on.
 */
const FIXTURES: Array<{ member: Fixture; eligible: boolean; why: string }> = [
  {
    why: "a parentless adult — the case the NULL bug hid",
    eligible: true,
    member: {
      id: "parentless-adult",
      firstName: "Parentless",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: null,
    },
  },
  {
    why: "one parent recorded, second slot free",
    eligible: true,
    member: {
      id: "one-parent",
      firstName: "OneParent",
      active: true,
      archivedAt: null,
      parentMemberId: "other-parent",
      secondaryParentId: null,
    },
  },
  {
    why: "secondary-only parent — the other half of the NULL bug",
    eligible: true,
    member: {
      id: "secondary-parent-only",
      firstName: "SecondaryOnly",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: "other-parent",
    },
  },
  {
    why: "inactive members stay linkable — the write route accepts them",
    eligible: true,
    member: {
      id: "inactive",
      firstName: "Inactive",
      active: false,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: null,
    },
  },
  {
    why: "the child of a candidate is itself linkable",
    eligible: true,
    member: {
      id: "child-of-has-dependants",
      firstName: "Grandchild",
      active: true,
      archivedAt: null,
      parentMemberId: "has-dependants",
      secondaryParentId: null,
    },
  },
  {
    why: "both parent slots taken",
    eligible: false,
    member: {
      id: "two-parents",
      firstName: "TwoParents",
      active: true,
      archivedAt: null,
      parentMemberId: "other-parent",
      secondaryParentId: "another-parent",
    },
  },
  {
    why: "has dependants of their own (two-generation invariant)",
    eligible: false,
    member: {
      id: "has-dependants",
      firstName: "HasDependants",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: null,
      dependents: [{ id: "child-of-has-dependants" }],
    },
  },
  {
    why: "archived members are rejected by the write route",
    eligible: false,
    member: {
      id: "archived",
      firstName: "Archived",
      active: true,
      archivedAt: new Date("2026-01-01T00:00:00.000Z"),
      parentMemberId: null,
      secondaryParentId: null,
    },
  },
  {
    why: "already linked to this very parent",
    eligible: false,
    member: {
      id: "already-linked",
      firstName: "AlreadyLinked",
      active: true,
      archivedAt: null,
      parentMemberId: PARENT_ID,
      secondaryParentId: null,
    },
  },
  {
    why: "already linked to this parent as the SECOND parent",
    eligible: false,
    member: {
      id: "already-linked-secondary",
      firstName: "AlreadySecondary",
      active: true,
      archivedAt: null,
      parentMemberId: "other-parent",
      secondaryParentId: PARENT_ID,
    },
  },
  {
    why: "the parent cannot be their own dependant",
    eligible: false,
    member: {
      id: PARENT_ID,
      firstName: "Parent",
      active: true,
      archivedAt: null,
      parentMemberId: null,
      secondaryParentId: null,
      dependents: [{ id: "already-linked" }],
    },
  },
];

const ELIGIBLE_IDS = FIXTURES.filter((row) => row.eligible).map(
  (row) => row.member.id,
);

function seedFixtureDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE "Member" (
      "id" TEXT PRIMARY KEY,
      "firstName" TEXT NOT NULL,
      "active" INTEGER NOT NULL,
      "archivedAt" TEXT,
      "parentMemberId" TEXT,
      "secondaryParentId" TEXT
    )`,
  );
  const insert = db.prepare(
    `INSERT INTO "Member" VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const { member } of FIXTURES) {
    insert.run(
      member.id,
      member.firstName,
      member.active ? 1 : 0,
      member.archivedAt ? member.archivedAt.toISOString() : null,
      member.parentMemberId,
      member.secondaryParentId,
    );
  }
  return db;
}

async function runWhereAgainstFixtures(where: Record<string, unknown>) {
  const compiled = await compileMemberWhereToSql(where);
  const translated = toSqliteSelect(compiled);
  const db = seedFixtureDatabase();
  try {
    const rows = db
      .prepare(translated.sql)
      .all(...(translated.args as string[]));
    return rows.map((row) => (row as { id: string }).id);
  } finally {
    db.close();
  }
}

// ── The row-level predicate ─────────────────────────────────────────────────

describe("dependentLinkBlockers", () => {
  for (const { member, eligible, why } of FIXTURES) {
    it(`${eligible ? "clears" : "blocks"} ${member.id}: ${why}`, () => {
      const blockers = dependentLinkBlockers(PARENT_ID, member);
      expect(blockers.length === 0).toBe(eligible);
    });
  }

  it("names the specific reason, most specific first", () => {
    expect(dependentLinkBlockers(PARENT_ID, FIXTURES[5].member)).toEqual([
      "TWO_PARENTS",
    ]);
    expect(dependentLinkBlockers(PARENT_ID, FIXTURES[6].member)).toEqual([
      "HAS_DEPENDANTS",
    ]);
    expect(dependentLinkBlockers(PARENT_ID, FIXTURES[7].member)).toEqual([
      "ARCHIVED",
    ]);
    expect(dependentLinkBlockers(PARENT_ID, FIXTURES[8].member)).toEqual([
      "ALREADY_LINKED_TO_PARENT",
    ]);
    // The parent themself trips SELF before the dependants clause, and SELF is
    // what the admin needs to read.
    expect(dependentLinkBlockers(PARENT_ID, FIXTURES[10].member)[0]).toBe(
      "SELF",
    );
  });

  it("returns reasons in the declared order", () => {
    const everyBlocker = dependentLinkBlockers(PARENT_ID, {
      id: PARENT_ID,
      archivedAt: new Date(),
      parentMemberId: PARENT_ID,
      secondaryParentId: "other",
      dependents: [{ id: "x" }],
    });
    expect(everyBlocker).toEqual([...DEPENDENT_LINK_INELIGIBILITY_REASONS]);
  });

  it("gives every reason both an API message and an admin-facing phrase", () => {
    for (const reason of DEPENDENT_LINK_INELIGIBILITY_REASONS) {
      expect(DEPENDENT_LINK_INELIGIBILITY_ERRORS[reason]).toBeTruthy();
      expect(DEPENDENT_LINK_INELIGIBILITY_EXPLANATIONS[reason]).toBeTruthy();
    }
  });
});

// ── The SQL half: shape, then real generated SQL, then real rows ────────────

describe("dependentLinkCandidateWhere", () => {
  it("guards both nullable parent columns with an explicit IS NULL branch", () => {
    expect(dependentLinkCandidateWhere(PARENT_ID)).toEqual([
      { id: { not: PARENT_ID } },
      { OR: [{ parentMemberId: null }, { parentMemberId: { not: PARENT_ID } }] },
      {
        OR: [
          { secondaryParentId: null },
          { secondaryParentId: { not: PARENT_ID } },
        ],
      },
      { OR: [{ parentMemberId: null }, { secondaryParentId: null }] },
      { dependents: { none: {} } },
      { secondaryDependents: { none: {} } },
      { archivedAt: null },
    ]);
  });

  it("compiles to SQL that admits NULL parent columns", async () => {
    const { sql } = await compileMemberWhereToSql({
      AND: dependentLinkCandidateWhere(PARENT_ID),
    });

    expect(sql).toContain(
      `("public"."Member"."parentMemberId" IS NULL OR "public"."Member"."parentMemberId" <> $2)`,
    );
    expect(sql).toContain(
      `("public"."Member"."secondaryParentId" IS NULL OR "public"."Member"."secondaryParentId" <> $3)`,
    );
    expect(sql).toContain(`"public"."Member"."archivedAt" IS NULL`);
  });

  it("returns every eligible member — including members with no parent", async () => {
    const returned = await runWhereAgainstFixtures({
      AND: dependentLinkCandidateWhere(PARENT_ID),
    });
    expect(returned.sort()).toEqual([...ELIGIBLE_IDS].sort());
  });

  it("agrees row-for-row with the row-level predicate (search/write parity)", async () => {
    const returned = new Set(
      await runWhereAgainstFixtures({
        AND: dependentLinkCandidateWhere(PARENT_ID),
      }),
    );

    for (const { member } of FIXTURES) {
      expect({
        id: member.id,
        offeredBySearch: returned.has(member.id),
      }).toEqual({
        id: member.id,
        offeredBySearch: dependentLinkBlockers(PARENT_ID, member).length === 0,
      });
    }
  });

  it("the pre-#2254 filter dropped every parentless member (regression guard)", async () => {
    // The exact clauses this fix replaced. Kept as an executable record of the
    // bug: `{ not: id }` on a nullable column is not "everyone except id".
    const returned = await runWhereAgainstFixtures({
      AND: [
        { id: { not: PARENT_ID } },
        { parentMemberId: { not: PARENT_ID } },
        { secondaryParentId: { not: PARENT_ID } },
        { OR: [{ parentMemberId: null }, { secondaryParentId: null }] },
        { dependents: { none: {} } },
        { secondaryDependents: { none: {} } },
      ],
    });

    expect(returned).not.toContain("parentless-adult");
    expect(returned).not.toContain("one-parent");
    expect(returned).not.toContain("inactive");
    // It matched nobody at all: every candidate has at least one NULL parent
    // column, which is exactly why the dialog looked broken for everyone.
    expect(returned).toEqual([]);
  });
});
