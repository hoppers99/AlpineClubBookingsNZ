/**
 * The registry CONTRACT, enforced over every entry that will ever be added. These
 * assertions are the mechanical half of the "adding a tool" checklist in
 * `registry.ts`: a future tool pack (AID-6A/B/C) that ships an unbounded query, a
 * multi-statement string, a missing permission requirement, or a schema that
 * silently ignores unknown arguments fails here rather than in production.
 */
import { describe, expect, it } from "vitest";

import { ADMIN_PERMISSION_AREAS } from "@/lib/admin-permissions";

import {
  DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID,
  DIAGNOSTICS_TOOLS,
  findDiagnosticsTool,
  FORBIDDEN_TOOL_SQL_PATTERNS,
  isValidDiagnosticsToolId,
} from "../registry";
import { DIAGNOSTICS_TOOL_BOUNDS } from "../types";

const AREA_KEYS = new Set(ADMIN_PERMISSION_AREAS.map((area) => area.key));

describe("diagnostics tool registry contract (#2374)", () => {
  it("registers at least one tool and no duplicate ids", () => {
    expect(DIAGNOSTICS_TOOLS.length).toBeGreaterThan(0);
    const ids = DIAGNOSTICS_TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s has a well-formed id",
    (_id, tool) => {
      expect(isValidDiagnosticsToolId(tool.id)).toBe(true);
      expect(findDiagnosticsTool(tool.id)).toBe(tool);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s requires at least one real admin area, and never `edit`",
    (_id, tool) => {
      // ADR-002 §2: a tool that required nothing would be a tool anyone may run.
      expect(tool.requiredAreas.length).toBeGreaterThan(0);
      for (const area of tool.requiredAreas) {
        expect(AREA_KEYS.has(area)).toBe(true);
      }
      // Diagnostics is read-only, so a level never appears in a requirement —
      // the substrate always checks `view`.
      expect(JSON.stringify(tool.requiredAreas)).not.toContain("edit");
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s carries exactly one SELECT statement",
    (_id, tool) => {
      const trimmed = tool.sql.trim();
      expect(trimmed).toMatch(/^(SELECT|WITH)\b/i);
      // No semicolon: the executor wraps the SQL in a LIMIT subquery, which is
      // only safe for a single statement.
      expect(trimmed).not.toContain(";");
      expect(trimmed.length).toBeGreaterThan(0);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s contains no mutating, DDL, file-reading or locking SQL",
    (_id, tool) => {
      for (const pattern of FORBIDDEN_TOOL_SQL_PATTERNS) {
        expect(
          pattern.test(tool.sql),
          `${tool.id} SQL matches forbidden pattern ${pattern}`,
        ).toBe(false);
      }
    },
  );

  // NEGATIVE CONTROL for the test above. Iterating the exported pattern list and
  // asserting nothing matches would pass just as happily if the list were empty or
  // half-deleted, so this pins that the list actually catches the statements it
  // exists to catch. Without it, "no entry contains a DELETE" is a claim about the
  // list's contents that no test checks.
  it.each([
    ["INSERT INTO public.\"Member\" (id) VALUES ($1)"],
    ["UPDATE public.\"Member\" SET email = $1"],
    ["DELETE FROM public.\"Member\" WHERE id = $1"],
    ["TRUNCATE public.\"Member\""],
    ["DROP TABLE public.\"Member\""],
    ["CREATE TEMP TABLE leak (id int)"],
    ["ALTER TABLE public.\"Member\" ADD COLUMN x text"],
    ["GRANT SELECT ON public.\"Member\" TO someone"],
    ["REVOKE SELECT ON public.\"Member\" FROM someone"],
    ["COPY public.\"Member\" TO '/tmp/leak.csv'"],
    ["VACUUM public.\"Member\""],
    ["SELECT pg_read_file('/etc/passwd')"],
    ["SELECT pg_read_binary_file('/etc/passwd')"],
    ["SELECT pg_ls_dir('/')"],
    ["SELECT lo_import('/etc/passwd')"],
    ["SELECT lo_export(1, '/tmp/leak')"],
    ["SELECT pg_sleep(30)"],
    ["SELECT pg_advisory_lock(1)"],
    ["SELECT dblink('', 'SELECT 1')"],
    ["SELECT id FROM public.\"Member\" FOR UPDATE"],
    ["SELECT id FROM public.\"Member\" FOR SHARE"],
    ["SET LOCAL statement_timeout = 0"],
    ["SET SESSION default_transaction_read_only = off"],
    // Comments would break the executor's LIMIT wrapper.
    ["SELECT 1 -- trailing comment"],
    ["SELECT 1 /* block comment */"],
  ])("the forbidden-pattern list catches %s", (hostileSql) => {
    expect(
      FORBIDDEN_TOOL_SQL_PATTERNS.some((pattern) => pattern.test(hostileSql)),
    ).toBe(true);
  });

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s has balanced parentheses so the executor's LIMIT wrapper still parses",
    (_id, tool) => {
      // The row cap is applied by wrapping the entry's SQL in
      // `SELECT * FROM (<sql>) AS ... LIMIT ($n)`. A stray closing parenthesis
      // would close that wrapper early; a stray opening one would swallow it.
      let depth = 0;
      for (const character of tool.sql) {
        if (character === "(") depth += 1;
        if (character === ")") depth -= 1;
        expect(depth, `${tool.id} SQL closes a parenthesis it never opened`)
          .toBeGreaterThanOrEqual(0);
      }
      expect(depth, `${tool.id} SQL leaves a parenthesis open`).toBe(0);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s declares row and byte limits within the hard ceilings",
    (_id, tool) => {
      expect(tool.rowLimit).toBeGreaterThan(0);
      expect(tool.rowLimit).toBeLessThanOrEqual(DIAGNOSTICS_TOOL_BOUNDS.maxRows);
      expect(tool.byteLimit).toBeGreaterThan(0);
      expect(tool.byteLimit).toBeLessThanOrEqual(
        DIAGNOSTICS_TOOL_BOUNDS.maxResultBytes,
      );
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s REJECTS an unknown argument rather than ignoring it",
    (_id, tool) => {
      // The behavioural equivalent of asserting `.strict()`, and a better test:
      // it holds however the schema is written.
      expect(tool.parseArgs({ __unexpected__: 1 }).ok).toBe(false);
      expect(tool.parseArgs({ toolId: "x" }).ok).toBe(false);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s exposes a closed JSON schema to the provider",
    (_id, tool) => {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      // Every declared `required` name must be a declared property.
      for (const name of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties)).toContain(name);
      }
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.label.length).toBeGreaterThan(0);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s describes every advertised property, and a zero-argument tool accepts {}",
    (_id, tool) => {
      // The JSON Schema handed to the provider is hand-written while the Zod schema
      // is the real gate, so the two can drift. This pins what is checkable from
      // outside the entry: every advertised property is actually described (a bare
      // `{}` property tells the model nothing and invites a guessed value), and a
      // tool advertising NO properties must accept an empty argument object —
      // otherwise the model can never call it successfully at all.
      for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
        expect(
          schema,
          `${tool.id} advertises "${name}" with no description of its shape`,
        ).toMatchObject({ type: expect.any(String) });
      }
      if (Object.keys(tool.inputSchema.properties).length === 0) {
        expect(tool.parseArgs({}).ok).toBe(true);
        // …and still refuses anything else, which is the `.strict()` property.
        expect(tool.parseArgs({ anything: 1 }).ok).toBe(false);
      }
    },
  );

  it("rejects malformed tool ids", () => {
    for (const candidate of [
      "",
      "Diagnostics.Probe",
      "diagnostics probe",
      "diagnostics/probe",
      "../../etc/passwd",
      "diagnostics.probe;DROP",
      "a".repeat(DIAGNOSTICS_TOOL_BOUNDS.toolIdMaxChars + 1),
    ]) {
      expect(isValidDiagnosticsToolId(candidate)).toBe(false);
    }
  });

  it("returns undefined for an unknown id rather than a default tool", () => {
    expect(findDiagnosticsTool("diagnostics.does_not_exist")).toBeUndefined();
    expect(findDiagnosticsTool("")).toBeUndefined();
  });
});

describe("the substrate readiness probe (#2374)", () => {
  const probe = findDiagnosticsTool(DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID);

  it("is registered under support:view and surfaces no personal data", () => {
    expect(probe).toBeDefined();
    expect(probe?.requiredAreas).toEqual(["support"]);
    expect(probe?.surfacesPersonalData).toBe(false);
  });

  it("reads no relation at all — AID-5 carries no domain tool", () => {
    // The property that matters is "names no table or view", NOT "contains no
    // `FROM`": the probe legitimately uses `EXTRACT(epoch FROM …)`, and banning the
    // keyword outright asserted the wrong thing (it failed the moment the timeout
    // was reported numerically). So assert there is no FROM-clause relation
    // reference and no JOIN, and that every function called is `pg_catalog`-
    // qualified — which is what actually makes the probe safe before any grant.
    const sql = probe?.sql ?? "";
    // A relation reference is `FROM <name>`; `FROM <expr>)` inside EXTRACT is not.
    expect(sql).not.toMatch(/\bfrom\s+(?:only\s+)?[A-Za-z_"][\w".]*\s*(?:,|$|\s)/im);
    expect(sql).not.toMatch(/\bjoin\b/i);
    expect(sql).not.toMatch(/\bpublic\./i);
    expect(sql).toContain(
      "pg_catalog.current_setting('transaction_read_only')",
    );
  });

  it("takes no arguments and binds no parameters", () => {
    const binding = probe?.parseArgs({});
    expect(binding?.ok).toBe(true);
    if (binding?.ok) expect(binding.params).toEqual([]);
  });

  it("projects only the flat scalars it declares, dropping any other column", () => {
    const row = probe?.project({
      probe_ok: true,
      transaction_read_only: "on",
      // PostgreSQL's own rendering: a GUC set in ms reads back in the largest unit
      // that divides evenly, so the raw setting is `5s`, not `5000ms`.
      statement_timeout: "5s",
      statement_timeout_ms: 5000,
      // A column the projection must drop even though the query returned it.
      leaked_secret: "should not survive",
    });
    expect(row).toEqual({
      probeOk: true,
      transactionReadOnly: "on",
      statementTimeout: "5s",
      statementTimeoutMs: 5000,
    });
  });

  it("projects the timeout as a NUMBER so a dropped timeout cannot pass as a string", () => {
    // The reason the numeric field exists: `statement_timeout = 0` means no timeout
    // at all, and a string comparison against a formatted value let that through.
    const row = probe?.project({
      probe_ok: true,
      transaction_read_only: "off",
      statement_timeout: "0",
      statement_timeout_ms: 0,
    });
    expect(row?.statementTimeoutMs).toBe(0);
    expect(typeof row?.statementTimeoutMs).toBe("number");
  });

  it("projects a finite number even when the database returns nothing for it", () => {
    // `boundedScalar` refuses a non-finite number, so a missing column must not
    // become NaN and turn a healthy probe into `redaction_failed`.
    const row = probe?.project({ probe_ok: true });
    expect(Number.isFinite(row?.statementTimeoutMs)).toBe(true);
    expect(row?.statementTimeout).toBe("");
  });
});
