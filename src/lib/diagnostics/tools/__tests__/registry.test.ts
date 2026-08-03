/**
 * The registry CONTRACT, enforced over every entry that will ever be added. These
 * assertions are the mechanical half of the "adding a tool" checklist in
 * `registry.ts`: a future tool pack (AID-6A/B/C) that ships an unbounded query, a
 * multi-statement string, a missing permission requirement, or a schema that
 * silently ignores unknown arguments fails here rather than in production.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ADMIN_PERMISSION_AREAS } from "@/lib/admin-permissions";
import { canonicalStringify, sha256Hex } from "@/lib/diagnostics/knowledge/hash";

import { readSqlPlaceholderNumbers } from "../database";
import {
  defineDiagnosticsTool,
  DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID,
  DIAGNOSTICS_TOOLS,
  type DiagnosticsToolEntry,
  findDiagnosticsTool,
  FORBIDDEN_TOOL_SQL_PATTERNS,
  isValidDiagnosticsToolId,
} from "../registry";
import { DIAGNOSTICS_TOOL_BOUNDS } from "../types";

const AREA_KEYS = new Set(ADMIN_PERMISSION_AREAS.map((area) => area.key));

/**
 * Representative VALID arguments for each entry, so the parameter-arity contract
 * below can actually reach `bind`. A new tool pack must add its own row — the test
 * fails loudly rather than skipping, because a skipped arity check is exactly how a
 * one-parameter-short entry would ship.
 */
const EXAMPLE_ARGS: Record<string, unknown> = {
  [DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID]: {},
};

/**
 * A throwaway entry built around a caller-supplied schema, so the NESTED argument
 * shapes below can actually be exercised.
 *
 * Every entry AID-5 ships takes `z.object({}).strict()`, which rejects a nested
 * argument on the schema alone — so a nested-key assertion against the shipped
 * registry cannot fail, whatever the guard does. That is exactly how a
 * depth-limited scan shipped green in the first place. This fixture is the same
 * `defineDiagnosticsTool` an author calls, with the argument shape the next tool
 * packs (AID-6B/#2376, AID-6C/#2377) need.
 */
function nestedArgumentFixture<TArgs>(argsSchema: z.ZodType<TArgs>) {
  return defineDiagnosticsTool<TArgs>({
    id: "diagnostics.nested_args_fixture",
    label: "Nested-argument fixture",
    description:
      "Test-only entry with a nested argument shape, used to pin the depth-total reserved-key scan.",
    requiredAreas: ["support"],
    argsSchema,
    inputSchema: {
      type: "object",
      properties: { filters: { type: "object" } },
      additionalProperties: false,
    },
    sql: "SELECT true AS ok",
    bind: () => [],
    project: (row) => ({ ok: row.ok === true }),
    rowLimit: 1,
    byteLimit: 64,
    surfacesPersonalData: false,
  });
}

/**
 * The nesting shapes a reserved key can hide in, each with a schema that ACCEPTS the
 * polluted input so the assertion is not satisfied by the schema instead of the
 * guard.
 *
 * `hashesAsIfAbsent` records what zod 4.4.3 actually does with the key, because the
 * two answers are different defects. For `__proto__` it STRIPS: the parse succeeds and
 * the accepted arguments are byte-identical to a call that never sent the key, so
 * ADR-004's durable `argsHash` cannot tell the two apart — the audit-integrity defect.
 * For `constructor` inside a `z.record(...)` it KEEPS the key (measured: the canonical
 * hashes differ), so the record would at least be faithful — but it is still an
 * argument the registry documents as a REJECTION, and the guard refuses it.
 */
interface NestedReservedKeyCase {
  label: string;
  polluted: string;
  clean: string;
  hashesAsIfAbsent: boolean;
  /** The schema ALONE, to measure what zod does when nothing guards it. */
  parseWithSchemaOnly: (raw: unknown) => { success: boolean; data: unknown };
  /** The same schema behind `defineDiagnosticsTool`, which must refuse. */
  entry: DiagnosticsToolEntry;
}

/**
 * Built through a generic function rather than declared as a literal table: each
 * schema has a different argument type, and a single array literal would collapse
 * them into a union that no longer satisfies `z.ZodType<TArgs>`.
 */
function nestedReservedKeyCase<TArgs>(
  label: string,
  argsSchema: z.ZodType<TArgs>,
  polluted: string,
  clean: string,
  hashesAsIfAbsent: boolean,
): NestedReservedKeyCase {
  return {
    label,
    polluted,
    clean,
    hashesAsIfAbsent,
    parseWithSchemaOnly: (raw) => {
      const result = argsSchema.safeParse(raw);
      return {
        success: result.success,
        data: result.success ? result.data : undefined,
      };
    },
    entry: nestedArgumentFixture(argsSchema),
  };
}

const NESTED_RESERVED_KEY_CASES: readonly NestedReservedKeyCase[] = [
  nestedReservedKeyCase(
    "one object down",
    z
      .object({ filters: z.object({ status: z.string().optional() }).strict() })
      .strict(),
    '{"filters":{"__proto__":{"polluted":"yes"},"status":"open"}}',
    '{"filters":{"status":"open"}}',
    true,
  ),
  nestedReservedKeyCase(
    "in a `z.record(...)`, the shape the first tool pack needs",
    z.object({ filters: z.record(z.string(), z.string()) }).strict(),
    '{"filters":{"__proto__":{"polluted":"yes"},"status":"open"}}',
    '{"filters":{"status":"open"}}',
    true,
  ),
  nestedReservedKeyCase(
    "inside an ARRAY element",
    z
      .object({ filters: z.array(z.object({ status: z.string() }).strict()) })
      .strict(),
    '{"filters":[{"__proto__":{"polluted":"yes"},"status":"open"}]}',
    '{"filters":[{"status":"open"}]}',
    true,
  ),
  nestedReservedKeyCase(
    "four levels down",
    z
      .object({
        a: z
          .object({
            b: z.object({ c: z.object({ d: z.string() }).strict() }).strict(),
          })
          .strict(),
      })
      .strict(),
    '{"a":{"b":{"c":{"__proto__":{"polluted":"yes"},"d":"x"}}}}',
    '{"a":{"b":{"c":{"d":"x"}}}}',
    true,
  ),
  nestedReservedKeyCase(
    "as `constructor`, which zod KEEPS rather than strips",
    z.object({ filters: z.record(z.string(), z.string()) }).strict(),
    '{"filters":{"constructor":"x","status":"open"}}',
    '{"filters":{"status":"open"}}',
    false,
  ),
];

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
    "%s REJECTS a reserved key that `.strict()` alone would silently strip",
    (_id, tool) => {
      // `.strict()` is not total. Measured on zod 4.4.3:
      // `z.object({}).strict().safeParse(JSON.parse('{"__proto__":{}}'))` SUCCEEDS
      // with `data: {}` and reports no unrecognized key. The arguments reaching
      // `parseArgs` are the model's `tool_use` input deserialised from provider
      // JSON, so `__proto__` arrives as an ordinary own property exactly like this.
      // Accepting it makes the audit `argsHash` identical to a call that sent `{}`,
      // so ADR-004's durable record cannot tell the two apart — and the first entry
      // with a `z.record(...)` field would silently drop a filter key.
      expect(tool.parseArgs(JSON.parse('{"__proto__":{"polluted":"yes"}}')).ok).toBe(
        false,
      );
      expect(tool.parseArgs(JSON.parse('{"constructor":{}}')).ok).toBe(false);
      expect(tool.parseArgs(JSON.parse('{"prototype":{}}')).ok).toBe(false);
      // And nothing was polluted on the way past.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s REJECTS a reserved key at ANY depth, in an object or an array",
    (_id, tool) => {
      // A top-level-only scan is not the guarantee the registry documents. Zod strips
      // a NESTED `__proto__` exactly as readily as a top-level one, so a guard that
      // stopped at depth 1 would reproduce the same audit-hash defect one level down —
      // measured by the `NESTED_RESERVED_KEY_CASES` table below, which uses a fixture
      // entry because no entry shipped today takes a nested argument. These inputs
      // therefore fail on this entry's schema as well; the assertions exist so the
      // first tool pack with a `filters` object inherits a scan that already looks
      // everywhere, and they will bite the moment such an entry is registered.
      for (const raw of [
        '{"filters":{"__proto__":{"polluted":"yes"},"status":"open"}}',
        '{"filters":[{"__proto__":{"polluted":"yes"}}]}',
        '{"a":{"b":{"c":{"d":{"__proto__":{}}}}}}',
        '{"a":[[{"constructor":{}}]]}',
        '{"a":{"b":{"prototype":{}}}}',
      ]) {
        expect(tool.parseArgs(JSON.parse(raw)).ok, raw).toBe(false);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each(NESTED_RESERVED_KEY_CASES.map((entry) => [entry.label, entry] as const))(
    "refuses a reserved key %s — which zod accepts, and then cannot hash apart",
    (_label, testCase) => {
      const polluted: unknown = JSON.parse(testCase.polluted);
      const clean: unknown = JSON.parse(testCase.clean);

      // 1. Zod ACCEPTS the polluted input. This is the measurement, not a claim: if
      //    a future zod fixes the strip, this assertion is what tells us.
      const pollutedParse = testCase.parseWithSchemaOnly(polluted);
      const cleanParse = testCase.parseWithSchemaOnly(clean);
      expect(pollutedParse.success).toBe(true);
      expect(cleanParse.success).toBe(true);
      if (!pollutedParse.success || !cleanParse.success) return;

      // 2. And where it STRIPS the key it repairs the arguments silently, so the
      //    durable `argsHash` — which `invoke.ts` computes as
      //    `sha256Hex(canonicalStringify(binding.args))` — is BYTE-IDENTICAL for a call
      //    that sent the reserved key and one that did not. That is the audit-integrity
      //    defect, reproduced at depth. Asserted in BOTH directions so this stays a
      //    measurement of zod rather than a belief about it.
      const pollutedHash = sha256Hex(canonicalStringify(pollutedParse.data));
      const cleanHash = sha256Hex(canonicalStringify(cleanParse.data));
      if (testCase.hashesAsIfAbsent) {
        expect(pollutedHash).toBe(cleanHash);
      } else {
        expect(pollutedHash).not.toBe(cleanHash);
      }

      // 3. `parseArgs` is what makes the rejection total: the reserved key never
      //    reaches the schema, so there is no repaired call to hash.
      expect(testCase.entry.parseArgs(polluted).ok).toBe(false);
      expect(testCase.entry.parseArgs(clean).ok).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it("terminates on a cyclic object rather than spinning in the reserved-key scan", () => {
    // `parseArgs` takes `unknown`. JSON cannot carry a cycle, but the type says
    // nothing about that, and an iterative scan without a visited set would hang the
    // request thread instead of refusing.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const tool = DIAGNOSTICS_TOOLS[0];
    expect(tool.parseArgs(cyclic).ok).toBe(false);
  });

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s binds exactly the parameters its SQL references — $1..$N, no gaps",
    (_id, tool) => {
      // The executor appends the row cap as `$${params.length + 1}`, which is
      // correct only while the entry references exactly `$1..$N`. One parameter
      // short does NOT fail at the database: verified on postgres:16, the row cap
      // silently serves as the missing placeholder and the query returns rows, so
      // the tool's own predicate is evaluated against the row cap and the result is
      // projected, hashed and audited as a clean success.
      const example = EXAMPLE_ARGS[tool.id];
      expect(
        example,
        `add an EXAMPLE_ARGS row for ${tool.id} so its parameter arity is checked`,
      ).toBeDefined();
      const binding = tool.parseArgs(example);
      expect(binding.ok, `${tool.id} rejected its own EXAMPLE_ARGS`).toBe(true);
      if (!binding.ok) return;

      const referenced = [...new Set(readSqlPlaceholderNumbers(tool.sql))].sort(
        (a, b) => a - b,
      );
      expect(referenced).toEqual(binding.params.map((_value, index) => index + 1));
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
