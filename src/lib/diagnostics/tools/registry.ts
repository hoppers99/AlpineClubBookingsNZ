/**
 * AI Diagnostics — the SERVER-OWNED tool registry (AID-5, #2374; contracts in
 * ADR-001 §2, ADR-002 §2/§4, ADR-007).
 *
 * This table is the whole answer to "can the model run a query?". It cannot: a
 * registry entry pairs a FIXED SQL text with a FIXED parameter binding, a FIXED
 * projection, FIXED row/byte ceilings and a FIXED admin-permission requirement.
 * The model chooses an entry by id and supplies arguments that a `.strict()` Zod
 * schema has already accepted; the entry's `bind` turns those arguments into
 * positional parameters. There is no code path — here or in `invoke.ts` — that
 * concatenates caller text into SQL.
 *
 * AID-5 SHIPS NO DOMAIN TOOL. Epic #2369 keeps the tool packs in their own
 * children (AID-6A #2375 config/readiness, AID-6B #2376 booking/membership,
 * AID-6C #2377 finance/Xero) so each gets its own permission review and its own
 * table grant. The single entry below reads NO relation at all: it exists to
 * prove the plumbing end to end — that the dedicated role connects, that the
 * transaction really is READ ONLY, that the timeout is set, that authorization
 * runs, and that the audit row is written — without exposing one row of club
 * data. It is the substrate's readiness probe, not a data tool.
 *
 * ADDING A TOOL (the checklist a reviewer should hold you to):
 *  1. `requiredAreas` names the area(s) that already govern this data in the
 *     admin UI, at `view`. A cross-area tool lists every area (ADR-002 §3 — AND).
 *  2. `sql` is one statement, no semicolon, schema-qualified, parameterised.
 *  3. `bind` maps parsed args to parameters positionally; it never formats SQL.
 *  4. `project` returns ONLY allowlisted columns, as flat scalars, and the SAME
 *     field set for every row (the executor refuses rows whose shapes disagree).
 *  5. Add the table's `GRANT SELECT` to `SELECT_GRANTS` in `provision-role.ts`
 *     in the SAME pull request, and never a blanket schema grant.
 *  6. `surfacesPersonalData` is true if any projected field identifies a person;
 *     ADR-004 §1 then requires a per-invocation opt-in from the operator.
 *  7. Any entry that can return more than one row carries a TOTAL `ORDER BY`.
 *     Without one PostgreSQL may return the same rows in a different order run to
 *     run, and the audit `resultHash` — which is the hash of the projected rows in
 *     order — would then differ for identical evidence, making the hash useless
 *     for the "was this the same answer?" question it exists to settle.
 */

import { z } from "zod";

import type { AdminPermissionArea } from "@/lib/admin-permissions";

import {
  DIAGNOSTICS_TOOL_BOUNDS,
  DIAGNOSTICS_TOOL_ID_PATTERN,
  type DiagnosticsToolRow,
} from "./types";

/**
 * The JSON Schema shape handed to the provider. Hand-written rather than derived
 * so the bytes sent to Anthropic are reviewable in the diff, and
 * `additionalProperties: false` is part of the type so no entry can forget it.
 */
export interface DiagnosticsToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

/** What the author of a tool writes. Fully typed in its own argument shape. */
export interface DiagnosticsToolSpec<TArgs> {
  id: string;
  /** Operator-facing label. Server-owned; used in the evidence block and audit summary. */
  label: string;
  /** Model-facing description. Server-owned text; never operator or model input. */
  description: string;
  /** Areas required at `view`, AND-ed, re-checked fresh on every invocation. */
  requiredAreas: readonly AdminPermissionArea[];
  /** `.strict()` so an unknown argument is a REJECTION, not something ignored. */
  argsSchema: z.ZodType<TArgs>;
  inputSchema: DiagnosticsToolInputSchema;
  /** One fixed statement. No semicolon — the executor wraps it in a LIMIT subquery. */
  sql: string;
  /** Parsed args to positional parameters. Must be pure and never build SQL. */
  bind: (args: TArgs) => readonly unknown[];
  /** Column allowlist, applied to every row. Must return flat scalars only. */
  project: (row: Record<string, unknown>) => DiagnosticsToolRow;
  rowLimit: number;
  byteLimit: number;
  /** True when a projected field can identify a person (ADR-004 §1 opt-in). */
  surfacesPersonalData: boolean;
}

/**
 * The parse-and-bind step, exposed as ONE function so the executor can never
 * call `bind` with arguments the schema did not accept. `args` is the parsed,
 * canonical object — used only to compute the audit `argsHash`, never stored.
 */
export type DiagnosticsToolArgsBinding =
  | { ok: true; args: unknown; params: readonly unknown[] }
  | { ok: false };

/**
 * A registered tool as the executor sees it: the argument type is erased, but
 * the only way to obtain parameters is `parseArgs`, which closes over the typed
 * schema and the typed `bind` together. That is what makes the erasure safe —
 * there is no exported handle on `bind` that could be called with unparsed
 * input.
 */
export interface DiagnosticsToolEntry {
  id: string;
  label: string;
  description: string;
  requiredAreas: readonly AdminPermissionArea[];
  inputSchema: DiagnosticsToolInputSchema;
  sql: string;
  parseArgs: (raw: unknown) => DiagnosticsToolArgsBinding;
  project: (row: Record<string, unknown>) => DiagnosticsToolRow;
  rowLimit: number;
  byteLimit: number;
  surfacesPersonalData: boolean;
}

/**
 * Erase one typed spec into a registry entry. The single `as TArgs` inside is
 * sound because it is applied to the OUTPUT of `argsSchema.safeParse`, i.e. to a
 * value the schema itself has just validated.
 */
export function defineDiagnosticsTool<TArgs>(
  spec: DiagnosticsToolSpec<TArgs>,
): DiagnosticsToolEntry {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    requiredAreas: spec.requiredAreas,
    inputSchema: spec.inputSchema,
    sql: spec.sql,
    parseArgs: (raw) => {
      const parsed = spec.argsSchema.safeParse(raw);
      if (!parsed.success) return { ok: false };
      const args = parsed.data as TArgs;
      return { ok: true, args, params: spec.bind(args) };
    },
    project: spec.project,
    rowLimit: spec.rowLimit,
    byteLimit: spec.byteLimit,
    surfacesPersonalData: spec.surfacesPersonalData,
  };
}

/**
 * The substrate readiness probe. Reads NO relation — it asks the session about
 * itself, which is exactly what makes it safe to ship before any tool pack:
 *
 *  - `transaction_read_only` comes back `on` only if the executor really opened
 *    `BEGIN READ ONLY`, so a regression that dropped the read-only transaction
 *    shows up in the probe's own output.
 *  - `statement_timeout` comes back as the executor's `SET LOCAL` value, so a
 *    regression that dropped the timeout is visible the same way.
 *
 * THE TIMEOUT IS REPORTED TWICE, and that is deliberate. PostgreSQL does not echo
 * a GUC back in the units it was set in: `SET LOCAL statement_timeout = 5000`
 * reads back as `5s`, and the real-PostgreSQL proof caught a string assertion that
 * looked right and was not. The raw setting is kept because it is what an operator
 * sees in `psql`, and `statement_timeout_ms` is derived from it in SQL so the
 * control can be pinned NUMERICALLY — `0` means "no timeout at all", which a
 * string comparison against a formatted value would have let through.
 *
 * It requires `support:view` — the same area that already governs
 * `/admin/ai-diagnostics` and the rest of Admin > Support & System.
 */
export const DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID = "diagnostics.substrate_probe";

const substrateProbe = defineDiagnosticsTool({
  id: DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID,
  label: "Diagnostics read-only database probe",
  description:
    "Confirms the diagnostics read-only database connection is working and correctly restricted. Reads no club data of any kind — it returns only whether the connection is read-only and what query timeout is in force. Use it when asked whether diagnostics database access is set up.",
  requiredAreas: ["support"],
  argsSchema: z.object({}).strict(),
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  // `::int` and not `::bigint`: node-postgres hands a bigint back as a STRING to
  // avoid precision loss, which would arrive at the projection as a non-numeric
  // scalar. A millisecond timeout always fits in int4.
  sql: `SELECT
  true AS probe_ok,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('statement_timeout') AS statement_timeout,
  (EXTRACT(epoch FROM pg_catalog.current_setting('statement_timeout')::interval) * 1000)::int AS statement_timeout_ms`,
  bind: () => [],
  project: (row) => ({
    probeOk: row.probe_ok === true,
    transactionReadOnly: String(row.transaction_read_only ?? ""),
    statementTimeout: String(row.statement_timeout ?? ""),
    // `?? 0` rather than `?? null`: a missing value must project as a number the
    // caller can compare, and 0 is the honest reading of "no timeout reported".
    statementTimeoutMs: Number(row.statement_timeout_ms ?? 0),
  }),
  rowLimit: 1,
  // The probe's honest output is ~95 bytes ("on", "5s", 5000, true). 256 leaves
  // real margin while keeping the ceiling meaningful: a projected value that
  // ballooned would be REFUSED here rather than quietly shipped, which is how a
  // per-tool byte limit is supposed to behave.
  byteLimit: 256,
  surfacesPersonalData: false,
});

/** Every registered tool. Order is presentation only; lookup is by id. */
export const DIAGNOSTICS_TOOLS: readonly DiagnosticsToolEntry[] = [
  substrateProbe,
];

/** Lookup by id. Returns `undefined` for an unknown key — never a default tool. */
export function findDiagnosticsTool(
  toolId: string,
): DiagnosticsToolEntry | undefined {
  return DIAGNOSTICS_TOOLS.find((tool) => tool.id === toolId);
}

/**
 * SQL fragments a registry entry may never contain. This is a CONTRACT TEST
 * helper, not a runtime sanitiser — the runtime guarantee is that the SQL is
 * server-owned and the role cannot write. It exists so a future entry that
 * pastes in a `DELETE`, a `pg_read_file` or a locking clause fails `npm test` at
 * the point of review rather than at a deployment.
 */
export const FORBIDDEN_TOOL_SQL_PATTERNS: readonly RegExp[] = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\btruncate\b/i,
  /\bdrop\b/i,
  /\bcreate\b/i,
  /\balter\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\bcopy\b/i,
  /\bvacuum\b/i,
  /\bpg_read_file\b/i,
  /\bpg_read_binary_file\b/i,
  /\bpg_ls_dir\b/i,
  /\blo_import\b/i,
  /\blo_export\b/i,
  /\bpg_sleep\b/i,
  /\bpg_advisory/i,
  /\bdblink\b/i,
  /\bfor\s+update\b/i,
  /\bfor\s+share\b/i,
  /\bset\s+(?:local|session)\b/i,
  // A COMMENT would break the executor's LIMIT wrapper, not bypass it: `--` at the
  // end of an entry's SQL comments out the wrapper's own
  // `) AS diagnostics_tool_result LIMIT ($n)` and the statement fails to parse. It
  // is banned here so that failure is caught at review time rather than the first
  // time an operator asks the question that reaches the tool.
  /--/,
  /\/\*/,
];

/** True when the id is a well-formed registry key. */
export function isValidDiagnosticsToolId(toolId: string): boolean {
  return (
    toolId.length > 0 &&
    toolId.length <= DIAGNOSTICS_TOOL_BOUNDS.toolIdMaxChars &&
    DIAGNOSTICS_TOOL_ID_PATTERN.test(toolId)
  );
}
