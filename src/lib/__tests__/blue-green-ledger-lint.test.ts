import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATION_GATE_TIMEOUT_MS } from "./helpers/migration-gate-timeouts";
import { bashFixturePath, bashGateArgs } from "./helpers/bash-fixture-path";

/**
 * #2818 decision 10 — the safety ledger's own well-formedness.
 *
 * `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` is append-only, hand-edited TSV that
 * `docs/UPGRADING.md` tells an operator to consult before every deploy. It had
 * been corrupted in exactly the way that shape invites: the previous last line
 * carried no trailing newline, so the next lane's append glued its row onto the
 * end of it and three rows became one 9-field physical line.
 *
 * Every gate stayed green. The fused line's `$1` was still a real migration name
 * and its `$4` was still "yes", so the ledger lint passed it; the rows swallowed
 * into columns 6-9 were simply invisible, which meant a migration with NO row at
 * all read as documented. `scan_ledger` now checks each row's field count
 * against the header's, and these tests drive the real script to prove it —
 * the same way `data-migration-verification-gate.test.ts` drives its gate,
 * because a gate that is only modelled is a gate nobody has proved.
 *
 * No database is involved; the validator is read-only by design.
 */

const VALIDATOR = "scripts/validate-blue-green-migrations.sh";
const REPO_ROOT = process.cwd();

const HEADER =
  "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan";

/** One well-formed 5-field data row. */
function row(name: string, compatible = "yes"): string {
  return [name, "expand", "n/a", compatible, `Notes for ${name}.`].join("\t");
}

/** Writes a throwaway ledger and runs the real validator over it. */
function lint(lines: string[], { trailingNewline = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "tac-ledger-"));
  const ledger = path.join(dir, "ledger.tsv");
  writeFileSync(ledger, lines.join("\n") + (trailingNewline ? "\n" : ""));

  // #2886 — the ledger path is made relative to this spawn's `cwd`, and the
  // variables are inlined into the bash command rather than handed to
  // `spawnSync`'s `env`. On Windows `bash` is WSL, which can open neither a
  // drive-letter path nor a Win32 environment variable: the validator used to
  // see MIGRATION_SAFETY_LEDGER unset and lint the REAL
  // `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` instead of this fixture — a false
  // green in the one place a false green is unacceptable. See
  // ./helpers/bash-fixture-path.
  const result = spawnSync(
    "bash",
    bashGateArgs(VALIDATOR, [], {
      MIGRATION_SAFETY_LEDGER: bashFixturePath(ledger, REPO_ROOT),
      ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "0",
      BLUE_GREEN_MIGRATION_OVERRIDE_REASON: "",
    }),
    {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
    },
  );

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("blue/green safety ledger lint (#2818)", () => {
  it(
    "passes a well-formed ledger",
    () => {
      // The control. Without it, every assertion below could be passing because
      // the validator refuses this fixture shape for some unrelated reason.
      const result = lint([HEADER, row("20260101000000_one"), row("20260102000000_two")]);

      expect(result.output).not.toMatch(/field\(s\), expected/);
      expect(result.status).toBe(0);
    },
    MIGRATION_GATE_TIMEOUT_MS,
  );

  it(
    "fails a row with too many fields — the fused-line corruption itself",
    () => {
      // Two rows glued onto one physical line, which is what a missing trailing
      // newline plus an append produces: 9 fields, a valid name in column 1 and a
      // valid "yes" in column 4.
      const fused = `${row("20260101000000_one")}${row("20260102000000_two")}`;
      const result = lint([HEADER, fused]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("has 9 field(s), expected 5");
      // The message has to name the cause, because the file is hand-edited and
      // the reader is an operator mid-deploy, not the author of this script.
      expect(result.output).toMatch(/fused onto one physical line/);
      // And the second migration must be reported as MISSING rather than as
      // present, which is the harm the fusion actually did.
      expect(result.output).not.toContain("20260102000000_two\t");
    },
    MIGRATION_GATE_TIMEOUT_MS,
  );

  it(
    "fails a row with too FEW fields",
    () => {
      // The other direction: a hand-edit that drops a column shifts
      // old_code_compatible into a different position, so the closed-vocabulary
      // check would start reading the wrong cell.
      const result = lint([HEADER, "20260101000000_one\texpand\tn/a\tyes"]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("has 4 field(s), expected 5");
    },
    MIGRATION_GATE_TIMEOUT_MS,
  );

  it(
    "still enforces the closed vocabulary and the duplicate rule",
    () => {
      // The field-count check runs BEFORE these and `next`s on failure, so it
      // could have masked them. Well-formed rows must still reach both.
      const badVocabulary = lint([HEADER, row("20260101000000_one", "Yes")]);
      expect(badVocabulary.status).not.toBe(0);
      expect(badVocabulary.output).toMatch(/must be yes, no, or windowed/);

      const duplicated = lint([
        HEADER,
        row("20260101000000_one"),
        row("20260101000000_one"),
      ]);
      expect(duplicated.status).not.toBe(0);
      expect(duplicated.output).toMatch(/duplicate safety ledger row/);
    },
    MIGRATION_GATE_TIMEOUT_MS,
  );

  it(
    "fails closed when the header cannot be read as a column list",
    () => {
      // A width of zero compared against every row would silently disable the
      // check — the same class of defect it exists to catch — so a header the
      // scan cannot understand is an error, not a skip.
      const result = lint(["# single-column-header", row("20260101000000_one")]);

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/safety ledger header must be a tab-separated/);
    },
    MIGRATION_GATE_TIMEOUT_MS,
  );

  it(
    "accepts a final row with no trailing newline, since that alone is not corruption",
    () => {
      // The missing newline is the CAUSE of a future fusion, not a fault in
      // itself, and awk reads the last line either way. Failing it here would
      // reject the file's whole committed history for a reason no reader could
      // act on.
      const result = lint([HEADER, row("20260101000000_one")], {
        trailingNewline: false,
      });

      expect(result.status).toBe(0);
    },
    MIGRATION_GATE_TIMEOUT_MS,
  );
});

describe("the committed ledger itself is well-formed (#2818)", () => {
  it(
    "has no fused rows, and ends with a newline so the next append cannot create one",
    () => {
      const ledger = path.join(
        REPO_ROOT,
        "docs",
        "BLUE_GREEN_MIGRATION_SAFETY.tsv",
      );
      const text = readFileSync(ledger, "utf8");

      expect(text.endsWith("\n")).toBe(true);

      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      const expectedFields = lines[0]!.split("\t").length;
      expect(expectedFields).toBeGreaterThan(1);

      for (const [index, line] of lines.entries()) {
        if (line.startsWith("#")) continue;
        expect(
          line.split("\t").length,
          `line ${index + 1} of the safety ledger (${line.slice(0, 60)}…)`,
        ).toBe(expectedFields);
      }
    },
    MIGRATION_GATE_TIMEOUT_MS,
  );
});
