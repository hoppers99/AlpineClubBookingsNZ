import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  bashFixtureEnv,
  bashGateArgs,
} from "../../src/lib/__tests__/helpers/bash-fixture-path";
import { MIGRATION_GATE_TIMEOUT_MS } from "../../src/lib/__tests__/helpers/migration-gate-timeouts";

/**
 * Check 4 of `scripts/check-migration-safety-coverage.sh` (#3002): an expand and
 * its own contract may not land in one deploy.
 *
 * WHY THESE BUILD THROWAWAY GIT REPOSITORIES. "Added on this branch" is a fact
 * only git holds, so a test that mocked git would assert nothing about the one
 * question this check asks. Each case is a few files in a temp directory with
 * `git init`, a base branch, and commits on top — the shape
 * `scripts/__tests__/file-size-base.test.ts` established for the file-size
 * ratchet, for the same reason.
 *
 * The gate is RUN, not modelled: `bash scripts/check-migration-safety-coverage.sh`
 * against the fixture, with the real validator behind it. A gate that is only
 * modelled is a gate nobody has proved.
 *
 * WINDOWS. These spawn `bash`, which on a stock Windows 11 box is the WSL
 * launcher, so fixture paths and gate variables go through the helpers in
 * `src/lib/__tests__/helpers/bash-fixture-path.ts` (#2886) — an env var put on
 * `spawnSync`'s `env` option is silently NOT forwarded into WSL, which would run
 * the gate against the repository's real ledger while looking like it worked.
 * Measured for this suite: WSL's git reads these throwaway repositories on
 * /mnt/c correctly, though it cannot read a git WORKTREE — which is why the gate
 * skips rather than fails when git cannot see a work tree on a developer machine.
 */

const LEDGER_HEADER =
  "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan";

/** The ledger's first data row: everything at or after it is in scope. */
const BASELINE_ROW = "20260507000000_base\texpand\tn/a\tyes\tbaseline row";

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type Fixture = {
  root: string;
  migrationsDir: string;
  ledgerPath: string;
  addMigration: (name: string, sql?: string) => void;
  addFileToMigration: (name: string, file: string, body: string) => void;
  writeLedger: (rows: string[]) => void;
  commit: (message: string) => string;
  branch: (name: string) => void;
};

/** A git repository shaped like this one: prisma/migrations plus a ledger TSV. */
function newFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "acb-samerelease-"));
  ROOTS.push(root);
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  // A commit signature would prompt or fail in CI; this suite never signs.
  git(root, "config", "commit.gpgsign", "false");
  // The fixture's own content must not be rewritten on checkout: this repository
  // pins migration SQL to LF (#2399) and a throwaway repo has no .gitattributes.
  git(root, "config", "core.autocrlf", "false");

  const migrationsDir = path.join(root, "prisma", "migrations");
  const ledgerPath = path.join(root, "safety.tsv");
  mkdirSync(migrationsDir, { recursive: true });

  const addMigration = (name: string, sql = "SELECT 1;\n") => {
    // Test fixture: joins the fixture's own migrations directory with a
    // test-controlled name; no user input.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const dir = path.join(migrationsDir, name);
    mkdirSync(dir, { recursive: true });
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    writeFileSync(path.join(dir, "migration.sql"), sql, "utf8");
  };

  const addFileToMigration = (name: string, file: string, body: string) => {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const dir = path.join(migrationsDir, name);
    mkdirSync(dir, { recursive: true });
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    writeFileSync(path.join(dir, file), body, "utf8");
  };

  const writeLedger = (rows: string[]) => {
    writeFileSync(ledgerPath, [LEDGER_HEADER, BASELINE_ROW, ...rows].join("\n") + "\n", "utf8");
  };

  const commit = (message: string) => {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", message);
    return git(root, "rev-parse", "HEAD").trim();
  };

  const branch = (name: string) => {
    git(root, "branch", name);
  };

  writeLedger([]);
  return {
    root,
    migrationsDir,
    ledgerPath,
    addMigration,
    addFileToMigration,
    writeLedger,
    commit,
    branch,
  };
}

/** Run the real gate against a fixture. `base` is passed as `--base`. */
function runGate(
  fixture: Pick<Fixture, "migrationsDir" | "ledgerPath">,
  base: string,
): { status: number | null; stderr: string } {
  const result = spawnSync(
    "bash",
    bashGateArgs(
      "scripts/check-migration-safety-coverage.sh",
      ["--base", base],
      bashFixtureEnv({
        MIGRATIONS_DIR: fixture.migrationsDir,
        MIGRATION_SAFETY_LEDGER: fixture.ledgerPath,
      }),
    ),
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  return { status: result.status, stderr: result.stderr ?? "" };
}

/**
 * The contract row shape these cases use, with the expand it names.
 * `old_code_compatible=yes` keeps the other three checks quiet: a `windowed` row
 * with no `rollback.sql` fails the pre-existing ledger-coverage check, which
 * would mask which check actually fired.
 */
function contractRow(contract: string, expand: string, plan = "Probe contract row."): string {
  return `${contract}\tcontract\t${expand}\tyes\t${plan}`;
}

function expandRow(name: string): string {
  return `${name}\texpand\tn/a\tno\tProbe expand row.`;
}

describe("same-release expand/contract check (#3002)", () => {
  it(
    "FAILS when a branch adds an expand and its own contract",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // The load-bearing case. Since #3002 an epic reaches `main` as one merge,
      // so both of these land in a single deploy and nothing has drained.
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("the epic adds both halves");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(
        "Same-release expand/contract check FAILED: an expand and its own contract land in one deploy.",
      );
      // Both migrations named, so the reader does not have to go looking.
      expect(result.stderr).toContain("20990102000000_drop_thing");
      expect(result.stderr).toContain("20990101000000_add_thing");
      // And it says what to do, which is what stops a gate being worked around.
      expect(result.stderr).toContain("move the contract half to a release");
      // It is THIS check that failed, not one of the three that came before.
      expect(result.stderr).toContain("Ledger well-formedness check passed");
      expect(result.stderr).toContain("Ledger coverage check passed");
    },
  );

  it(
    "passes when the branch adds only the expand half",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.writeLedger([expandRow("20990101000000_add_thing")]);
      fixture.commit("the epic adds the expand half only");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        "Same-release expand/contract check passed for 1 migration(s)",
      );
    },
  );

  it(
    "passes when the contract's named expand is already on the base ref",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // The ordinary, correct two-release retirement. The expand shipped and
      // drained in an earlier release; only the contract half is new here.
      const fixture = newFixture();
      fixture.addMigration("20990101000000_add_thing");
      fixture.writeLedger([expandRow("20990101000000_add_thing")]);
      fixture.commit("the expand shipped in an earlier release");
      fixture.branch("base-main");

      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("this release contracts it");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Same-release expand/contract check passed");
    },
  );

  it(
    "FAILS rather than passing when the base ref cannot be resolved",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // A gate that cannot read its comparison must not report a green it has
      // not earned — the rule `npm run pr:check` and the file-size ratchet
      // follow. On CI this is the depth-1-checkout case.
      const fixture = newFixture();
      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("everything in one commit");

      const result = runGate(fixture, "origin/no-such-ref");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(
        "Same-release expand/contract check FAILED: the base ref origin/no-such-ref does not resolve",
      );
      expect(result.stderr).toContain("must not report a green it has not earned");
      expect(result.stderr).toContain("git fetch origin no-such-ref");
    },
  );

  it(
    "FAILS on a shallow clone rather than narrowing the diff silently",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // A shallow clone does not error on `merge-base`: it hands back HEAD, so
      // the added-migration set comes back empty and the check would pass over a
      // tree holding the very pair it exists to catch. ci.yml records the same
      // trap for the file-size ratchet, where it cost an accepted debt increase.
      const fixture = newFixture();
      fixture.addMigration("20990101000000_add_thing");
      fixture.writeLedger([expandRow("20990101000000_add_thing")]);
      fixture.commit("one commit");

      const cloneRoot = mkdtempSync(path.join(tmpdir(), "acb-samerelease-shallow-"));
      ROOTS.push(cloneRoot);
      const clone = path.join(cloneRoot, "clone");
      execFileSync(
        "git",
        ["clone", "--quiet", "--depth", "1", pathToFileURL(fixture.root).href, clone],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      const result = runGate(
        {
          migrationsDir: path.join(clone, "prisma", "migrations"),
          ledgerPath: path.join(clone, "safety.tsv"),
        },
        "HEAD",
      );

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("this is a shallow clone");
      expect(result.stderr).toContain("fetch-depth: 0");
    },
  );

  it(
    "treats an UNCOMMITTED new migration as added, so the pair is caught before the commit",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      // Never committed: exactly what an implementor's working tree looks like
      // mid-change, and the cheapest moment to be told.
      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("an expand and its own contract land in one deploy");
    },
  );

  it(
    "does not treat a pre-existing migration that only GAINS a rollback.sql as added",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // Keyed on migration.sql on purpose. A migration that shipped in an
      // earlier release and gains a reverse script here is not new, and reading
      // it as new would fail a correct two-release retirement.
      const fixture = newFixture();
      fixture.addMigration("20990101000000_add_thing");
      fixture.writeLedger([expandRow("20990101000000_add_thing")]);
      fixture.commit("the expand shipped earlier");
      fixture.branch("base-main");

      fixture.addFileToMigration("20990101000000_add_thing", "rollback.sql", "SELECT 1;\n");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("contract half, plus a rollback for the old expand");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Same-release expand/contract check passed for 1 migration(s)");
    },
  );

  it(
    "lets an owner-chosen one-release drop through when the LEDGER says so, with a reason",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // The escape hatch, and the reason it exists: a gate with no way to say
      // "the owner chose a maintenance window" gets deleted rather than
      // satisfied. It lives in the contract row's own lock_impact_plan so the
      // justification cannot drift away from the row it excuses.
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow(
          "20990102000000_drop_thing",
          "20990101000000_add_thing",
          "SAME-RELEASE EXPAND/CONTRACT ACKNOWLEDGED: owner chose a one-release drop behind an announced window; old app and workers stopped before migrate.",
        ),
      ]);
      fixture.commit("windowed one-release drop");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        "Same-release expand/contract ACKNOWLEDGED for 20990102000000_drop_thing against 20990101000000_add_thing",
      );
      // Counted in the summary, so an acknowledgement is never silent.
      expect(result.stderr).toContain("(1 acknowledged)");
    },
  );

  it(
    "refuses a bare acknowledgement marker with no reason behind it",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow(
          "20990102000000_drop_thing",
          "20990101000000_add_thing",
          "SAME-RELEASE EXPAND/CONTRACT ACKNOWLEDGED: because",
        ),
      ]);
      fixture.commit("marker with no reason");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("an expand and its own contract land in one deploy");
    },
  );

  it(
    "ignores a contract row whose previous_expand_release is n/a",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // `n/a` names no migration, so there is no pair. The validator already
      // requires a real previous release for a DESTRUCTIVE contract migration;
      // this check must not invent a second, different rule for the rest.
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "n/a"),
      ]);
      fixture.commit("contract row naming nothing");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Same-release expand/contract check passed");
    },
  );

  it(
    "SKIPS, loudly, when the migrations directory is in no git work tree",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // What keeps the pre-existing fixture-based gate tests green: their
      // migration trees live under os.tmpdir() with no repository, so there is
      // no branch to read "added on this branch" from. It says so rather than
      // inventing an answer, and the three checks around it still run.
      const bare = mkdtempSync(path.join(tmpdir(), "acb-samerelease-bare-"));
      ROOTS.push(bare);
      const migrationsDir = path.join(bare, "migrations");
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      mkdirSync(path.join(migrationsDir, "20990101000000_add_thing"), { recursive: true });
      writeFileSync(
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        path.join(migrationsDir, "20990101000000_add_thing", "migration.sql"),
        "SELECT 1;\n",
        "utf8",
      );
      const ledgerPath = path.join(bare, "safety.tsv");
      writeFileSync(
        ledgerPath,
        [LEDGER_HEADER, BASELINE_ROW, expandRow("20990101000000_add_thing")].join("\n") + "\n",
        "utf8",
      );

      const result = runGate({ migrationsDir, ledgerPath }, "HEAD");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Same-release expand/contract check SKIPPED");
      expect(result.stderr).toContain("Ledger well-formedness check passed");
      expect(result.stderr).toContain("Migration safety coverage check passed");
    },
  );

  it(
    "refuses an unrecognised argument instead of running with the defaults",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      const result = spawnSync(
        "bash",
        bashGateArgs("scripts/check-migration-safety-coverage.sh", ["--basse", "main"]),
        { cwd: process.cwd(), env: process.env, encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unrecognised argument --basse");
    },
  );
});
