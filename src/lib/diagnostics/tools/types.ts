/**
 * AI Diagnostics — SELECT-only tool substrate: shared types and bounds (AID-5,
 * epic #2369, issue #2374).
 *
 * THE ONE INVARIANT THAT MATTERS: the model never supplies SQL. A tool is a
 * server-owned pairing of a fixed SQL text, a fixed projection, a fixed row/byte
 * ceiling, and a fixed admin-permission requirement. The model may only choose
 * WHICH registered tool to call and supply arguments that a `.strict()` Zod
 * schema has already accepted; those arguments become positional query
 * parameters and nothing else. There is no string interpolation into SQL
 * anywhere in this substrate, and no code path that accepts SQL from a caller.
 *
 * SECURITY POSTURE (do not weaken without an owner decision on #2370):
 *  - ADR-001: read-only. No mutation tool, no model SQL, no raw credentials, no
 *    raw provider payloads. The only writes this substrate performs are its own
 *    approved-metadata audit rows, on the APPLICATION connection — never the
 *    SELECT-only one.
 *  - ADR-002: every invocation re-reads the caller's permission matrix FRESH
 *    from the database-joined access roles and requires `view` on EVERY area the
 *    tool declares (AND, never OR). Withholding a tool definition from the model
 *    is a courtesy; the server-side check is the control, and it runs on every
 *    invocation whether the definition was offered or not.
 *  - ADR-003: a tool result is UNTRUSTED, prompt-injection-capable evidence with
 *    an observed-at instant. It carries no system authority.
 *  - ADR-004: an audit row carries tool id, auth outcome, row/byte/timing counts
 *    and non-reversible hashes — never raw arguments, never raw results.
 *  - ADR-007: the queries run as a dedicated non-superuser SELECT-only role
 *    (`AI_DIAGNOSTICS_DATABASE_URL`), inside a READ ONLY transaction, under a
 *    statement timeout, with a SQL-level row cap the executor imposes itself.
 *
 * FAIL CLOSED EVERYWHERE. Unknown tool, malformed arguments, exhausted round
 * budget, unhealthy metering, denied authorization, missing or mis-privileged
 * database role, timeout, oversized result, failed redaction, failed audit write
 * — every one of them returns a result carrying NO rows.
 */

import type { AdminPermissionArea } from "@/lib/admin-permissions";

/**
 * Result/registry format version. A consumer pins the exact value so it can
 * never silently read a shape it does not understand (same discipline as the
 * knowledge bundle in AID-3 and the page context in AID-4).
 */
export const DIAGNOSTICS_TOOL_SCHEMA_VERSION = 1 as const;

/**
 * Every ceiling the substrate enforces. They are deliberately small: a
 * diagnostics tool exists to answer "what does the deployed system currently say
 * about X", not to move data. A tool that wants more than this is a report, and
 * a report belongs in the admin UI where it is already governed.
 *
 * `maxRows`/`maxResultBytes` are HARD CEILINGS on top of each tool's own
 * declared limit — a registry entry may be stricter, never looser, and
 * `registry.ts`'s contract test refuses a looser one.
 */
export const DIAGNOSTICS_TOOL_BOUNDS = {
  /** Registry key, e.g. `diagnostics.substrate_probe`. */
  toolIdMaxChars: 64,
  /** Hard ceiling on rows any tool may return, imposed in SQL by the executor. */
  maxRows: 200,
  /** Hard ceiling on the UTF-8 byte length of one tool's projected result. */
  maxResultBytes: 32_768,
  /** Cap on any single free-text value inside a projected row, after redaction. */
  fieldValueMaxChars: 200,
  /** Cap on the number of projected columns one row may carry. */
  maxFieldsPerRow: 24,
  /** `statement_timeout` for the tool's read-only transaction. */
  statementTimeoutMs: 5_000,
  /** `lock_timeout` — a diagnostics read must never queue behind a writer. */
  lockTimeoutMs: 2_000,
  /** `idle_in_transaction_session_timeout` — a wedged read frees its backend. */
  idleInTransactionTimeoutMs: 10_000,
  /** Tool calls allowed inside ONE provider round. */
  maxToolCallsPerRound: 4,
  /** Tool calls allowed across a whole diagnostics session. */
  maxToolCallsPerSession: 16,
  /** Connections the dedicated SELECT-only pool may open. */
  maxPoolConnections: 3,
  /** Hard cap on the rendered evidence block handed to the model. */
  renderedBlockMaxChars: 8_000,
} as const;

/**
 * A registered tool id. Lowercase dotted segments only — a closed server-side
 * table key, never a pathname or anything else with prefix semantics.
 */
export const DIAGNOSTICS_TOOL_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Why an invocation produced no rows. Every value is a stable machine code; the
 * operator-facing sentence travels beside it so neither the UI nor the model has
 * to invent one.
 *
 * `unknown_tool` and `permission_denied` are deliberately DISTINCT even though
 * both deny: conflating them would make a misconfigured registry and an
 * authorization anomaly the same audit row.
 */
export type DiagnosticsToolFailureReason =
  /** No such registry key. */
  | "unknown_tool"
  /** Arguments failed the tool's `.strict()` schema. Details are never echoed. */
  | "invalid_args"
  /** The session's per-round or per-session tool-call budget is spent. */
  | "call_budget_exhausted"
  /** Diagnostics usage can no longer be metered (AID-2 circuit breaker). */
  | "metering_unavailable"
  /** The acting member row does not exist (a stale or forged acting member id). */
  | "actor_unresolved"
  /** The fresh role read itself failed — kept distinct from `actor_unresolved`. */
  | "actor_read_failed"
  /** The caller lacks `view` on at least one area the tool declares. */
  | "permission_denied"
  /** `AI_DIAGNOSTICS_DATABASE_URL` is absent, malformed, or reuses the app role. */
  | "database_not_configured"
  /** The connected role is NOT the least-privilege shape ADR-007 requires. */
  | "database_role_unsafe"
  /** The read failed, or the statement timeout cancelled it. */
  | "query_failed"
  /** The projected result exceeded the tool's byte ceiling. Never truncated. */
  | "result_too_large"
  /** A projection or redaction step threw. Evidence is discarded, not partial. */
  | "redaction_failed"
  /** The approved-metadata audit row could not be written. Rows are discarded. */
  | "audit_unavailable"
  /**
   * A collaborator threw where its contract says it returns a typed refusal.
   * That is a bug, and the executor still has to fail closed rather than let the
   * exception escape and lose the audit trail — so it is a reason of its own
   * rather than being disguised as one of the specific ones above.
   */
  | "internal_error";

/** A projected scalar. Deliberately not `unknown`: a tool returns flat scalars. */
export type DiagnosticsToolFieldValue = string | number | boolean | null;

/** One projected row: an allowlisted, redacted, bounded set of flat scalars. */
export type DiagnosticsToolRow = Record<string, DiagnosticsToolFieldValue>;

/**
 * The APPROVED audit metadata for one invocation (ADR-004 §4). Deliberately a
 * separate object from the evidence so a caller that persists an audit row
 * cannot accidentally persist a row value: nothing here is, or is derived from,
 * a column's contents except through a non-reversible hash.
 */
export interface DiagnosticsToolAudit {
  toolId: string;
  /** The areas the tool declares, recorded even when the check denied. */
  areasChecked: AdminPermissionArea[];
  authOutcome: "allowed" | "denied";
  /** Set on every non-success exit; null on success. */
  failureReason: DiagnosticsToolFailureReason | null;
  /**
   * sha256 of the canonical JSON of the ACCEPTED arguments — never the arguments
   * themselves. Null when the arguments never parsed (there is no canonical form
   * of input we refused to understand, and hashing the raw input would put
   * operator-supplied text into a durable row).
   */
  argsHash: string | null;
  /** sha256 of the canonical JSON of the projected rows. Null when none were produced. */
  resultHash: string | null;
  rowCount: number;
  /** UTF-8 byte length of the projected rows as canonical JSON. */
  byteCount: number;
  /** Wall-clock milliseconds spent inside the read-only transaction. */
  durationMs: number;
  /**
   * 0-based provider round this invocation belonged to, or `-1` when it belonged
   * to no round — an invocation refused before a round was ever opened. `-1` is
   * recorded honestly rather than coerced to 0: a durable row claiming round 0 for
   * a call that never entered the loop would misrepresent the audit trail.
   */
  roundIndex: number;
  observedAt: string;
}

/** A tool invocation that produced evidence. */
export interface DiagnosticsToolSuccess {
  schemaVersion: typeof DIAGNOSTICS_TOOL_SCHEMA_VERSION;
  status: "ok";
  toolId: string;
  /** Operator-facing label from the registry — server-owned, never model text. */
  label: string;
  rows: DiagnosticsToolRow[];
  /**
   * True when the tool's own row limit clipped the result. The model is told, so
   * it reports "the first N" rather than presenting a partial set as complete.
   */
  truncated: boolean;
  observedAt: string;
  audit: DiagnosticsToolAudit;
}

/** A tool invocation that produced nothing, and why. */
export interface DiagnosticsToolFailure {
  schemaVersion: typeof DIAGNOSTICS_TOOL_SCHEMA_VERSION;
  status: "error";
  toolId: string;
  reason: DiagnosticsToolFailureReason;
  /** Plain-English, safe to show an operator verbatim. NEVER echoes input. */
  message: string;
  /** Set only when the failure is a permission one (ADR-002 §3 partial answers). */
  missingAreas?: AdminPermissionArea[];
  observedAt: string;
  audit: DiagnosticsToolAudit;
}

export type DiagnosticsToolResult =
  | DiagnosticsToolSuccess
  | DiagnosticsToolFailure;

/**
 * Operator/model-facing copy for every failure reason. Centralised so the UI
 * (AID-7) and the evidence block render the SAME words the executor enforces,
 * and so no message can accidentally interpolate caller input.
 */
export const DIAGNOSTICS_TOOL_FAILURE_MESSAGES: Record<
  DiagnosticsToolFailureReason,
  string
> = {
  unknown_tool: "That diagnostics tool does not exist.",
  invalid_args:
    "The arguments for that diagnostics tool were not valid, so it was not run.",
  call_budget_exhausted:
    "This diagnostics session has used its allowance of tool calls. Ask a narrower question to start a fresh session.",
  metering_unavailable:
    "Diagnostics usage cannot be recorded at the moment, so no tool was run.",
  actor_unresolved:
    "Your account could not be found, so no diagnostics tool was run.",
  actor_read_failed:
    "Your permissions could not be checked just now, so no diagnostics tool was run.",
  permission_denied:
    "You do not have view access to the area this diagnostics tool reads, so it was not run.",
  database_not_configured:
    "The read-only diagnostics database credential is not configured, so no tool was run.",
  database_role_unsafe:
    "The diagnostics database credential does not have the restricted, read-only privileges this feature requires, so no tool was run.",
  query_failed:
    "That diagnostics read did not complete (it may have taken too long), so no results are available.",
  result_too_large:
    "That diagnostics read returned more data than this feature is allowed to handle. Ask a narrower question.",
  redaction_failed:
    "That diagnostics read could not be safely prepared, so its results were discarded.",
  audit_unavailable:
    "That diagnostics read could not be recorded in the audit trail, so its results were discarded.",
  internal_error:
    "Something went wrong running that diagnostics read, so no results are available.",
};
