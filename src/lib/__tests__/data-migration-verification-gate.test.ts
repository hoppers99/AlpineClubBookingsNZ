import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../../../prisma/migration-verification/split-statements";

/**
 * #2418 — the coverage gate that makes a verification fixture non-optional.
 *
 * `scripts/check-data-migration-verification.sh` is the half of #2418 that
 * cannot be forgotten: it classifies every committed migration and fails,
 * naming it, when one rewrites data a club already has and ships no fixture.
 * The gate is only worth having if its classifier is right in both directions —
 * a false negative lets an unverified repair through, and a false positive
 * makes every routine DDL migration demand a fixture until somebody switches
 * the gate off.
 *
 * So these tests drive the real script over throwaway migration trees, the same
 * way `review-findings-contracts.test.ts` drives the blue/green ledger gate. No
 * database is involved: the gate is read-only by design.
 */

const GATE = "scripts/check-data-migration-verification.sh";
const REPO_ROOT = process.cwd();
/**
 * Spawning bash costs ~10s per call on Windows (process creation, not work), so
 * the default 5s test timeout trips on a developer machine while CI finishes in
 * milliseconds. Generous on purpose: a slow gate is not the failure being
 * tested.
 */
const GATE_TIMEOUT_MS = 120_000;

/**
 * A path bash will accept on either platform. Node hands back `C:\Users\…` on
 * Windows and Git Bash's `find` does not resolve backslash paths, so every gate
 * run would pass over an empty tree and report success — a false green in the
 * one place a false green is unacceptable. On Linux this is a no-op.
 */
function bashPath(value: string): string {
  return value.split(path.sep).join("/");
}

type TempMigration = { name: string; sql: string };

function createTree(
  migrations: TempMigration[],
  options: {
    fixtures?: string[];
    registry?: string | null;
    grandfathered?: string[];
  } = {},
) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "tac-data-migration-"));
  const migrationsDir = path.join(tempDir, "migrations");
  const fixturesDir = path.join(tempDir, "migration-verification");
  const grandfatherFile = path.join(tempDir, "grandfathered.txt");

  for (const migration of migrations) {
    // Test fixture: joins the temp migrations dir with a test-controlled name; no user input.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const dir = path.join(migrationsDir, migration.name);
    mkdirSync(dir, { recursive: true });
    // Test fixture: appends the hardcoded "migration.sql" filename.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    writeFileSync(path.join(dir, "migration.sql"), migration.sql);
  }

  mkdirSync(fixturesDir, { recursive: true });
  for (const fixture of options.fixtures ?? []) {
    // Test fixture: joins the temp fixtures dir with a test-controlled name; no user input.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    writeFileSync(
      path.join(fixturesDir, `${fixture}.ts`),
      `export default { migration: "${fixture}" };\n`,
    );
  }
  if (options.registry !== null) {
    const imports = (options.fixtures ?? [])
      .map((fixture, index) => `import f${index} from "./${fixture}";`)
      .join("\n");
    writeFileSync(
      path.join(fixturesDir, "index.ts"),
      `${options.registry ?? imports}\n`,
    );
  }

  writeFileSync(
    grandfatherFile,
    `# temp\n${(options.grandfathered ?? []).join("\n")}\n`,
  );

  return { migrationsDir, fixturesDir, grandfatherFile };
}

function runGate(
  tree: ReturnType<typeof createTree>,
  env: Record<string, string> = {},
) {
  return spawnSync("bash", [GATE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MIGRATIONS_DIR: bashPath(tree.migrationsDir),
      DATA_MIGRATION_VERIFICATION_DIR: bashPath(tree.fixturesDir),
      DATA_MIGRATION_GRANDFATHER_FILE: bashPath(tree.grandfatherFile),
      EXPECTED_GRANDFATHERED_COUNT: "0",
      ...env,
    },
    encoding: "utf8",
  });
}

/** A migration whose only statement is the given SQL, plus a header comment. */
function migrationWith(sql: string): string {
  return `-- A comment mentioning UPDATE, DELETE FROM and TRUNCATE in prose.\n${sql}\n`;
}

const MIGRATION_NAME = "20990101000000_subject";

/** Runs the gate over a single migration with no fixture and no grandfather row. */
function classify(sql: string) {
  const tree = createTree([{ name: MIGRATION_NAME, sql: migrationWith(sql) }]);
  const result = runGate(tree);
  return {
    dataRewriting: result.status !== 0,
    stderr: result.stderr ?? "",
  };
}

describe("data-migration classifier (#2418)", () => {
  const rewrites: [string, string][] = [
    ["an UPDATE", `UPDATE "Lodge" SET "address" = NULL WHERE "address" = 'x';`],
    ["a DELETE", `DELETE FROM "SiteContent" WHERE "key" = 'FOOTER_BLURB';`],
    ["a TRUNCATE", `TRUNCATE "EmailLog";`],
    [
      "an INSERT that derives from existing rows",
      `INSERT INTO "Lodge" ("id") SELECT "id" FROM "Legacy";`,
    ],
    [
      "an upsert that resolves onto existing rows",
      `INSERT INTO "Setting" ("id", "v") VALUES ('a', 1) ON CONFLICT ("id") DO UPDATE SET "v" = 1;`,
    ],
    [
      "a data-modifying CTE",
      `WITH moved AS (DELETE FROM "Old" RETURNING *) INSERT INTO "New" SELECT * FROM moved;`,
    ],
    [
      "a column type change with a USING transform",
      `ALTER TABLE "Member" ALTER COLUMN "phone" TYPE TEXT USING trim("phone");`,
    ],
    [
      "a DO block that rewrites rows",
      `DO $$ BEGIN UPDATE "Member" SET "canLogin" = true; END $$;`,
    ],
    [
      // #2418 F1: a block-comment header must not hide the UPDATE. The awk
      // splitter used to keep "/* ... */" glued to the front of the statement,
      // so the classifier anchored on "/*" and matched nothing — exit 0, no
      // fixture demanded. The shared splitter now skips block comments.
      "an UPDATE hidden behind a block-comment header",
      `/* Repair addresses corrupted by #1234 */\nUPDATE "Lodge" SET "address" = NULL WHERE "address" = 'x';`,
    ],
    [
      "an UPDATE behind a nested, multi-line block comment",
      `/* repair /* see #1234 */ addresses */\nUPDATE "Lodge" SET "address" = NULL WHERE "address" = 'x';`,
    ],
  ];

  it.each(rewrites)(
    "treats %s as data-rewriting",
    (_label, sql) => {
      const { dataRewriting, stderr } = classify(sql);
      expect(dataRewriting, stderr).toBe(true);
      expect(stderr).toContain(MIGRATION_NAME);
      expect(stderr).toContain("ships no verification fixture");
    },
    GATE_TIMEOUT_MS,
  );

  const shapeOnly: [string, string][] = [
    [
      "a plain CREATE TABLE",
      `CREATE TABLE "Thing" ("id" TEXT NOT NULL, CONSTRAINT "Thing_pkey" PRIMARY KEY ("id"));`,
    ],
    [
      "an additive column with a default",
      `ALTER TABLE "Lodge" ADD COLUMN "note" TEXT DEFAULT 'x';`,
    ],
    [
      "a foreign key declaring ON UPDATE CASCADE",
      `ALTER TABLE "A" ADD CONSTRAINT "A_b_fkey" FOREIGN KEY ("bId") REFERENCES "B"("id") ON DELETE SET NULL ON UPDATE CASCADE;`,
    ],
    [
      "an INSERT of brand new rows",
      `INSERT INTO "Setting" ("id", "v") VALUES ('a', 1), ('b', 2);`,
    ],
    [
      "a trigger function whose body updates rows at runtime",
      `CREATE FUNCTION touch() RETURNS trigger AS $$ BEGIN UPDATE "A" SET "b" = 1; RETURN NEW; END $$ LANGUAGE plpgsql;`,
    ],
    ["a column default change", `ALTER TABLE "A" ALTER COLUMN "b" SET DEFAULT false;`],
  ];

  it.each(shapeOnly)(
    "does not treat %s as data-rewriting",
    (_label, sql) => {
      const { dataRewriting, stderr } = classify(sql);
      expect(dataRewriting, stderr).toBe(false);
    },
    GATE_TIMEOUT_MS,
  );

  it("refuses to classify a migration it cannot tokenise", () => {
    // An unterminated dollar-quote means the splitter cannot see where
    // statements end. Failing closed is the only safe answer: the alternative
    // is grading a file nobody parsed.
    const { dataRewriting, stderr } = classify(
      `UPDATE "A" SET "b" = $cms$never closed;`,
    );
    expect(dataRewriting).toBe(true);
    expect(stderr).toContain("cannot tokenise");
  }, GATE_TIMEOUT_MS);
});

describe("data-migration verification coverage gate (#2418)", () => {
  const REWRITE = `UPDATE "Lodge" SET "address" = NULL WHERE "address" = 'x';`;

  it("passes when the data migration ships a registered fixture", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      fixtures: [MIGRATION_NAME],
    });
    const result = runGate(tree);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("coverage passed");
  }, GATE_TIMEOUT_MS);

  it("passes when the data migration is grandfathered instead", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      grandfathered: [MIGRATION_NAME],
    });
    const result = runGate(tree, { EXPECTED_GRANDFATHERED_COUNT: "1" });
    expect(result.status, result.stderr).toBe(0);
  }, GATE_TIMEOUT_MS);

  it("fails when a fixture exists but is never imported, so it would never run", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      fixtures: [MIGRATION_NAME],
      registry: "// nothing imported here",
    });
    const result = runGate(tree);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not registered");
  }, GATE_TIMEOUT_MS);

  it("fails when a fixture names a migration that does not exist", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      fixtures: [MIGRATION_NAME, "20990202000000_never_committed"],
    });
    const result = runGate(tree);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("names no migration");
  }, GATE_TIMEOUT_MS);

  it("fails when a migration is both grandfathered and verified", () => {
    // The two states are mutually exclusive; allowing both would let the
    // allowlist decay into decoration that nobody prunes.
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      fixtures: [MIGRATION_NAME],
      grandfathered: [MIGRATION_NAME],
    });
    const result = runGate(tree, { EXPECTED_GRANDFATHERED_COUNT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has a fixture AND a grandfather row");
  }, GATE_TIMEOUT_MS);

  it("fails when the allowlist grows without the pinned count moving", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      grandfathered: [MIGRATION_NAME],
    });
    const result = runGate(tree, { EXPECTED_GRANDFATHERED_COUNT: "0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds 1 entries, expected 0");
  }, GATE_TIMEOUT_MS);

  it("fails on a stale allowlist row whose migration is gone", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      fixtures: [MIGRATION_NAME],
      grandfathered: ["20200101000000_deleted_long_ago"],
    });
    const result = runGate(tree, { EXPECTED_GRANDFATHERED_COUNT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not exist");
  }, GATE_TIMEOUT_MS);

  it("fails on an allowlist row whose migration no longer rewrites data", () => {
    const tree = createTree(
      [{ name: MIGRATION_NAME, sql: `CREATE TABLE "A" ("id" TEXT);` }],
      { grandfathered: [MIGRATION_NAME] },
    );
    const result = runGate(tree, { EXPECTED_GRANDFATHERED_COUNT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no longer classifies as data-rewriting");
  }, GATE_TIMEOUT_MS);

  it("passes over this repository's own migration history", () => {
    // The pinned count and the committed allowlist have to agree with what is
    // actually on disk, or every PR fails for a reason unrelated to its diff.
    const result = spawnSync("bash", [GATE], {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  }, GATE_TIMEOUT_MS);
});

describe("the two statement splitters agree (#2418)", () => {
  /**
   * There are two tokenisers on purpose, with different contracts: the awk one
   * runs in the shell gates before Node exists and normalises each statement
   * onto one line for READING, while the TypeScript one preserves the source
   * byte for byte so the runner can EXECUTE it (a newline inside dollar-quoted
   * HTML is part of the value). Two tokenisers is a drift risk, so this test
   * runs both over every committed migration and fails if they ever disagree
   * about where a statement starts and ends.
   */
  it("split every committed migration the same way", () => {
    const migrationsRoot = path.join(REPO_ROOT, "prisma", "migrations");
    const names = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.length).toBeGreaterThan(100);

    const disagreements: string[] = [];
    for (const name of names) {
      // Test helper: joins the repo's own migrations directory with a name read
      // from that same listing; no user input.
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const file = path.join(migrationsRoot, name, "migration.sql");
      const awkResult = spawnSync(
        "awk",
        [
          "-v",
          "tool=agreement-test",
          "-f",
          "scripts/lib/split-sql-statements.awk",
          bashPath(file),
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      expect(awkResult.status, `${name}: ${awkResult.stderr}`).toBe(0);
      const awkStatements = (awkResult.stdout ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0);

      const tsStatements = splitSqlStatements(readFileSync(file, "utf8"));

      if (awkStatements.length !== tsStatements.length) {
        disagreements.push(
          `${name}: awk found ${awkStatements.length} statements, TypeScript found ${tsStatements.length}`,
        );
        continue;
      }
      for (let index = 0; index < awkStatements.length; index += 1) {
        // Compare the WHOLE statement — comment-stripped and whitespace-collapsed
        // — not just its first two words. A divergence that preserves the count
        // AND the leading keyword (a block comment one splitter drops mid-
        // statement while the other keeps it, say) must still be caught; the
        // leading-keyword check that shipped first could not see it (#2418, F1).
        const awkText = canonicalize(awkStatements[index]);
        const tsText = canonicalize(tsStatements[index]);
        if (awkText !== tsText) {
          disagreements.push(
            `${name} #${index + 1}: awk read <${awkText}>, TypeScript read <${tsText}>`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  }, GATE_TIMEOUT_MS);
});

/**
 * A statement reduced to what PostgreSQL actually executes: comments removed and
 * every run of whitespace collapsed to one space. The awk splitter already
 * strips comments and folds each statement onto one line, so canonicalising both
 * sides makes their outputs directly comparable — and compares the executable
 * text of every statement rather than only its leading keyword (#2418, F1).
 *
 * The one deliberate contract difference between the splitters is the terminator:
 * awk flushes a statement WITHOUT its closing `;`, while the TypeScript splitter
 * keeps the source verbatim (`;` included). That is not a tokenisation divergence,
 * so a single trailing `;` is normalised away here; a genuine boundary
 * disagreement still surfaces as a different statement COUNT.
 */
function canonicalize(statement: string): string {
  return stripSqlComments(statement)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
}

/**
 * Remove SQL `--` line comments and C-style block comments (nested), leaving
 * every single-quoted, double-quoted and dollar-quoted body untouched — a
 * comment token inside a string is data, not a comment. Mirrors the quote/comment
 * handling both splitters implement, so it strips exactly what they strip.
 */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // Single-quoted string, honouring '' doubling and E'...' backslash escapes.
    if (ch === "'") {
      const escapeAware =
        (sql[i - 1] === "E" || sql[i - 1] === "e") &&
        !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (escapeAware && sql[i] === "\\") {
          out += sql.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    // Double-quoted identifier.
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    // Dollar-quoted body: $tag$ ... $tag$ (tag empty or [A-Za-z_][A-Za-z0-9_]*).
    const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
    if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? sql.length : close + tag.length;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    // `--` line comment: drop through the end of the line, keeping the newline.
    if (ch === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? sql.length : newline;
      continue;
    }
    // `/* */` block comment, nested and multi-line.
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe("the shell gates share one awk program (#2418)", () => {
  it("neither embeds its own copy of the tokeniser", () => {
    // Two copies of a 60-line tokeniser is two classifications of the same file
    // one edit apart. The deploy gate and the data-rewrite classifier must agree
    // about what PostgreSQL will run, so they load one file. (The TypeScript
    // splitter above is a deliberate second implementation with a different
    // contract — byte-exact, for execution — and the agreement test pins it.)
    const splitter = "scripts/lib/split-sql-statements.awk";
    for (const script of [GATE, "scripts/validate-blue-green-migrations.sh"]) {
      // Test helper: reads a hardcoded repository path.
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const source = readFileSync(path.join(REPO_ROOT, script), "utf8");
      expect(source, `${script} must load ${splitter}`).toContain(
        "split-sql-statements.awk",
      );
      expect(
        source,
        `${script} appears to embed its own dollar-quote tokeniser`,
      ).not.toContain("function dollar_open(");
    }
  });
});
