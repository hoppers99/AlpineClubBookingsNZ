// #2520 — the FamilyGroupMember.role retirement guard, POST-DROP.
//
// The column is gone. `20260803030000_contract_drop_family_group_member_role`
// dropped it under a maintenance window (owner directive, 3 Aug 2026) and this
// release removed the field from prisma/schema.prisma in the same commit.
//
// WHY THIS FILE SURVIVED THE DROP. Its previous version said to delete it here,
// on the reasoning that "once the field is gone from schema.prisma the compiler
// enforces all of it unconditionally". That reasoning is close but not exact, and
// the exact version is what justifies deleting the delegate scans. Measured
// against the generated client on this branch (transcript in
// docs/PRODUCTION_UPGRADE_RUNBOOK.md §7.2):
//
//   * `where: { role: ... }` IS a compile error;
//   * `select: { role: true }` and `create({ data: { role } })` COMPILE, and are
//     rejected at runtime by the client with PrismaClientValidationError before
//     any SQL is emitted.
//
// So no call shape can emit SQL naming the dropped column — the client has no such
// field to put in a SELECT, an INSERT column list, a RETURNING or a WHERE. The
// hazard the old guard existed for was the IMPLICIT one (an `include:` or a bare
// `: true` naming the column with no author intent), and that is now structurally
// impossible rather than merely policed. What is left is explicit, loud and
// unconditional: the first invocation fails, in any test or dev run. On that basis
// the narrowing scans, the nested-relation scans and the write/read scans were all
// deleted, and `familyGroupMember` came out of
// doomed-column-select-guard.test.ts's NARROW_SELECT_MODELS at the same time.
//
// None of that covers the two things kept below:
//
//   * RAW SQL. `$queryRaw`/`$executeRaw` and the psql heredocs in scripts/ are
//     plain strings. The compiler cannot see a dropped column in one, and this is
//     not hypothetical — a retired audit script kept a
//     `SELECT "role" … FROM "FamilyGroupMember"` snapshot query and an
//     `INSERT … ("role") …` fixture right through #2284, invisible to any
//     delegate scan.
//   * THE GENERATED CLIENT'S SHAPE. This is the owner-required proof that the
//     replacement runtime cannot name the dropped column, asserted against the
//     generated client rather than inferred from source. It is also the assertion
//     that fails first if someone re-adds the field to the schema without the
//     migration to match.
//
// The migration and ledger assertions tie the halves together: the field's
// absence from schema.prisma is only correct because a committed migration drops
// the column, and a windowed migration is only valid with a rollback.sql beside
// it.
import fs from "node:fs";
import path from "node:path";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
// scripts/ is walked for the same reason it always was: that is where the last
// survivor hid, in raw fixture SQL a src/+prisma/ scan could never have seen.
const SCAN_DIRS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "prisma"),
  path.join(REPO_ROOT, "scripts"),
];
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma", "schema.prisma");
const DROP_MIGRATION = "20260803030000_contract_drop_family_group_member_role";
const MIGRATION_DIR = path.join(REPO_ROOT, "prisma", "migrations", DROP_MIGRATION);

function walk(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes(".integration.")
  );
}

/**
 * `text` with `//` and block comments blanked out, newline-for-newline so
 * reported line numbers stay true. String and template bodies are KEPT, because
 * the raw-SQL scan needs them: the SQL lives inside them.
 *
 * Comments are stripped so a comment explaining why the column is gone cannot
 * fail the guard that proves it is gone.
 */
function withoutJsComments(text: string): string {
  let out = "";
  const keepNewlines = (chunk: string) => {
    for (const ch of chunk) if (ch === "\n") out += "\n";
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) break;
      keepNewlines(text.slice(i, close + 2));
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const openedAt = i;
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      out += text.slice(openedAt, i + 1);
      continue;
    }
    out += ch;
  }
  return out;
}

/** `text` with comments AND string/template bodies blanked out. */
function codeOnly(text: string): string {
  let out = "";
  const keepNewlines = (chunk: string) => {
    for (const ch of chunk) if (ch === "\n") out += "\n";
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) break;
      keepNewlines(text.slice(i, close + 2));
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const openedAt = i;
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      keepNewlines(text.slice(openedAt, i + 1));
      continue;
    }
    out += ch;
  }
  return out;
}

type SourceFile = { rel: string; raw: string };

function productionSources(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (isTestFile(rel)) continue;
      out.push({ rel, raw: withoutJsComments(fs.readFileSync(file, "utf8")) });
    }
  }
  return out;
}

describe("#2520 FamilyGroupMember.role is dropped", () => {
  // ---------------------------------------------------------------------------
  // The owner-required proof: the replacement runtime cannot name the column.
  // ---------------------------------------------------------------------------

  it("the generated Prisma Client does not expose the dropped column at all", () => {
    // Asserted against the generated client, not inferred from the source: with
    // no `role` field there is no SELECT, no INSERT column list and no implicit
    // RETURNING the client can emit that names the dropped column, whatever any
    // call site does. This is what makes the DROP safe for the replacement
    // runtime, and it is the assertion that fires if the field is re-added to
    // prisma/schema.prisma without a migration to match.
    const scalars = Object.keys(Prisma.FamilyGroupMemberScalarFieldEnum);
    expect(
      scalars,
      "FamilyGroupMember.role was DROPPED from the database by " +
        `${DROP_MIGRATION}. The generated client must not carry the field: if it ` +
        "does, Prisma will name a column that no longer exists and every read or " +
        "write of the join table fails with Postgres 42703 / Prisma P2022.",
    ).not.toContain("role");
    // Sanity: the enum is really this model's, so the assertion above is not
    // vacuously true of an empty or wrong object. The surviving scalars are
    // exactly these four — a fifth would mean the model gained a field this
    // guard has not reasoned about.
    expect([...scalars].sort()).toEqual([
      "familyGroupId",
      "id",
      "joinedAt",
      "memberId",
    ]);
  });

  it("the schema declares no rank field on the join table", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    const model = /model FamilyGroupMember \{[\s\S]*?\n\}/.exec(schema);
    expect(model, "FamilyGroupMember model not found in schema.prisma").not.toBeNull();
    const body = model![0];
    // Field declarations only, so the explanatory comment above them (which does
    // name the column, deliberately) cannot fail this.
    const fieldLines = body
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    expect(
      /(^|\s)role\s+\S/.test(fieldLines),
      "FamilyGroupMember must declare no `role` field: the database column is " +
        `dropped (${DROP_MIGRATION}), so a field here would produce SQL naming a ` +
        "column that does not exist. Family-group membership carries no rank — " +
        "see docs/DOMAIN_INVARIANTS.md on the family authorisation boundary.",
    ).toBe(false);
    // The absence is documented rather than accidental, so a future author does
    // not "restore" the column as a live signal.
    expect(body).toContain("NO `role` FIELD");
  });

  // ---------------------------------------------------------------------------
  // The field's absence is only correct because a committed migration drops the
  // column, and a windowed migration is only valid with its reverse script.
  // ---------------------------------------------------------------------------

  it("ships the DROP migration and its reverse script", () => {
    const migrationSql = path.join(MIGRATION_DIR, "migration.sql");
    const rollbackSql = path.join(MIGRATION_DIR, "rollback.sql");
    expect(fs.existsSync(migrationSql), `${DROP_MIGRATION}/migration.sql`).toBe(true);
    expect(
      fs.existsSync(rollbackSql),
      "A windowed migration must ship rollback.sql beside migration.sql " +
        "(docs/BLUE_GREEN_MIGRATION_POLICY.md). The deploy validator enforces " +
        "this too, as a documentation failure the ALLOW_BREAKING override cannot " +
        "rescue.",
    ).toBe(true);

    const migration = fs.readFileSync(migrationSql, "utf8");
    expect(migration).toMatch(/ALTER TABLE "FamilyGroupMember"/);
    expect(migration).toMatch(/DROP COLUMN "role"/);

    // The reverse script must restore the exact shape the previous release's
    // client expects: TEXT, NOT NULL, constant 'MEMBER' default — the shape
    // 20260407120000_add_family_group_member_join_table created.
    const rollback = fs.readFileSync(rollbackSql, "utf8");
    expect(rollback).toMatch(/ADD COLUMN "role" TEXT NOT NULL DEFAULT 'MEMBER'/);
  });

  it("is declared windowed in the blue/green safety ledger", () => {
    const ledger = fs.readFileSync(
      path.join(REPO_ROOT, "docs", "BLUE_GREEN_MIGRATION_SAFETY.tsv"),
      "utf8",
    );
    const row = ledger
      .split("\n")
      .find((line) => line.startsWith(`${DROP_MIGRATION}\t`));
    expect(row, `no ledger row for ${DROP_MIGRATION}`).toBeDefined();
    const fields = row!.split("\t");
    // DROP COLUMN is a destructive removal, so the validator requires
    // phase=contract with a named previous expand release; the owner directive
    // requires the honest `windowed` declaration rather than `yes`; and
    // `windowed` is only meaningful with the window written down.
    expect(fields[1]).toBe("contract");
    expect(fields[2]).not.toBe("n/a");
    expect(fields[2]).not.toBe("");
    expect(fields[3]).toBe("windowed");
    expect(fields[4] ?? "").toContain("MAINTENANCE-WINDOW PLAN");
  });

  // ---------------------------------------------------------------------------
  // The one surface the compiler cannot reach.
  // ---------------------------------------------------------------------------

  it("no raw SQL names the dropped column", () => {
    // Comments are stripped, but STRING BODIES ARE NOT — that is the point, since
    // the SQL lives in them. So prose inside a SQL template literal must not
    // write the quoted identifier; say `role column`, not the quoted form.
    const offenders: string[] = [];
    for (const { rel, raw } of productionSources()) {
      const table = /"FamilyGroupMember"/g;
      let m: RegExpExecArray | null;
      while ((m = table.exec(raw)) !== null) {
        const window = raw.slice(
          Math.max(0, m.index - 500),
          Math.min(raw.length, m.index + 500),
        );
        if (/"role"/.test(window)) {
          offenders.push(`${rel}:${raw.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(
      offenders,
      'Raw SQL naming "FamilyGroupMember" must not name the dropped "role" ' +
        "column. Raw SQL is the one surface the removed Prisma field does not " +
        "protect: the compiler cannot see a column name inside a string, so this " +
        "scan is the only thing standing between a stray $queryRaw or psql " +
        "heredoc and a Postgres 42703 in production.",
    ).toEqual([]);
  });

  it("finds the raw-SQL surface it is meant to police", () => {
    // If the scan matched no "FamilyGroupMember" raw SQL anywhere it would pass
    // vacuously forever, so prove the surface is still there. The retired audit
    // script's fixture INSERT is the standing example.
    const withTable = productionSources().filter(({ raw }) =>
      /"FamilyGroupMember"/.test(raw),
    );
    expect(withTable.length).toBeGreaterThan(0);
  });

  it("member-merge carries no vestigial role-merging behaviour", () => {
    // The `maxFamilyRole` upgrade promoted the surviving membership row to the
    // higher of the two labels when a merge collapsed two memberships of the same
    // family group. The label granted nothing after #2284, so PR #2565 removed
    // the behaviour; this pins that it stays removed, and that no substitute
    // update of the surviving row has crept back in.
    const mergeText = codeOnly(
      fs.readFileSync(path.join(REPO_ROOT, "src", "lib", "member-merge.ts"), "utf8"),
    );
    expect(mergeText).not.toContain("maxFamilyRole");
    expect(mergeText).not.toMatch(/familyGroupMember\s*\.\s*update\b/);
  });
});
