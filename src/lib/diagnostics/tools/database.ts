/**
 * AI Diagnostics — the dedicated SELECT-only database connection (AID-5, #2374;
 * contract in ADR-007).
 *
 * This is the ONLY place in the codebase that opens a database connection with
 * the diagnostics credential, and it deliberately does NOT go through
 * `@/lib/prisma`. Two reasons, both load-bearing:
 *
 *  1. The application's Prisma client is bound to `DATABASE_URL`, whose Compose
 *     role is a SUPERUSER (`docker-compose.yml`). Reusing it — even read-only,
 *     even "just for a SELECT" — would put every diagnostics query one bug away
 *     from the encrypted credential store. ADR-007 forbids it outright.
 *  2. A raw `pg` pool is what lets each read run inside an explicit
 *     `BEGIN READ ONLY` with its own `statement_timeout`, `lock_timeout` and
 *     `idle_in_transaction_session_timeout`, and with a SQL-level row cap the
 *     executor imposes itself. Those are transaction-scoped session settings
 *     Prisma does not expose per query.
 *
 * FAIL CLOSED, TWICE OVER. The credential is refused unless it is present,
 * parseable, and demonstrably NOT the application role; and the connected role
 * is refused unless the server itself confirms it is a non-superuser with no
 * TEMP, no CREATE, no dangerous predefined-role membership and no file-reading
 * function privilege. A deployment that has not run the provisioning step gets a
 * loud refusal, never a superuser fallback.
 *
 * WHAT THIS MODULE NEVER DOES: it never accepts SQL from a caller outside the
 * server-owned registry, never interpolates a value into SQL (every argument is
 * a positional parameter), and never surfaces a PostgreSQL error message to a
 * caller — a driver error can quote the failing statement and its values, so the
 * text stays in the server log and the caller gets a fixed sentence.
 */

import "server-only";

import { Pool, type PoolClient, type QueryResult } from "pg";

import { reportAiError } from "@/lib/observability-bridge";

import { FORBIDDEN_PREDEFINED_ROLES } from "./provision-role";
import { DIAGNOSTICS_TOOL_BOUNDS } from "./types";

/**
 * The environment variable holding the dedicated SELECT-only connection string.
 * Deployment-local (ADR-006): it never travels in a config bundle, and there is
 * deliberately NO fallback to `DATABASE_URL`.
 */
export const AI_DIAGNOSTICS_DATABASE_URL_ENV = "AI_DIAGNOSTICS_DATABASE_URL";

/** Marks the diagnostics backends in `pg_stat_activity` for an operator. */
export const DIAGNOSTICS_APPLICATION_NAME = "ai-diagnostics-select-only";

export type DiagnosticsDatabaseConfigProblem =
  /** The env var is absent or blank. */
  | "not_set"
  /** The env var is not a parseable postgres:// URL. */
  | "malformed_url"
  /** The URL carries no username, so the role cannot be checked at all. */
  | "missing_role"
  /** Byte-identical to `DATABASE_URL`, or the same role as the application. */
  | "reuses_application_role";

export type DiagnosticsDatabaseConfigResult =
  | { ok: true; url: string; roleName: string }
  | { ok: false; problem: DiagnosticsDatabaseConfigProblem };

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve and vet the diagnostics connection string WITHOUT connecting. Pure
 * enough to unit-test exhaustively, which matters: this is the check that stops a
 * deployment from pointing diagnostics at its superuser by copy-paste.
 *
 * The role comparison is case-insensitive on purpose. PostgreSQL role names are
 * case-sensitive only when they were created quoted; an operator who writes
 * `TAC` in one URL and `tac` in the other has still reused the application role,
 * and "the check did not fire because of capitalisation" is not a failure mode
 * worth keeping.
 */
export function resolveDiagnosticsDatabaseConfig(): DiagnosticsDatabaseConfigResult {
  const raw = readEnv(AI_DIAGNOSTICS_DATABASE_URL_ENV);
  if (!raw) return { ok: false, problem: "not_set" };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, problem: "malformed_url" };
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    return { ok: false, problem: "malformed_url" };
  }

  const roleName = decodeURIComponent(parsed.username);
  if (!roleName) return { ok: false, problem: "missing_role" };

  const applicationUrl = readEnv("DATABASE_URL");
  if (applicationUrl) {
    if (applicationUrl === raw) {
      return { ok: false, problem: "reuses_application_role" };
    }
    try {
      const applicationRole = decodeURIComponent(new URL(applicationUrl).username);
      if (
        applicationRole &&
        applicationRole.toLowerCase() === roleName.toLowerCase()
      ) {
        return { ok: false, problem: "reuses_application_role" };
      }
    } catch {
      // An unparseable DATABASE_URL is the application's problem, not ours; the
      // byte-equality check above already caught the copy-paste case.
    }
  }

  return { ok: true, url: raw, roleName };
}

/**
 * The privileges the connected role must NOT hold. Each key is checked by the
 * server, not inferred from configuration, so a hand-edited role that drifted
 * back towards write access is caught on the next tool call rather than at the
 * next code review.
 */
export interface DiagnosticsRolePrivilegeReport {
  roleName: string;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  canReplicate: boolean;
  bypassesRls: boolean;
  /** `TEMPORARY` on the current database — enables `CREATE TEMP TABLE`. */
  canCreateTempTables: boolean;
  /** `CREATE` on the current database — enables `CREATE SCHEMA`. */
  canCreateInDatabase: boolean;
  /** `CREATE` on schema `public` — enables `CREATE TABLE`. */
  canCreateInPublicSchema: boolean;
  /** EXECUTE on `pg_read_file(text)` — server-file read. */
  canReadServerFiles: boolean;
  /** Membership count across FORBIDDEN_PREDEFINED_ROLES that exist on this server. */
  forbiddenRoleMemberships: number;
}

/** True only when every checked privilege is absent. */
export function isDiagnosticsRolePrivilegeSafe(
  report: DiagnosticsRolePrivilegeReport,
): boolean {
  return (
    !report.isSuperuser &&
    !report.canCreateDb &&
    !report.canCreateRole &&
    !report.canReplicate &&
    !report.bypassesRls &&
    !report.canCreateTempTables &&
    !report.canCreateInDatabase &&
    !report.canCreateInPublicSchema &&
    !report.canReadServerFiles &&
    report.forbiddenRoleMemberships === 0
  );
}

/**
 * The privilege interrogation, as one statement so it cannot half-run. Written
 * against `pg_catalog` explicitly because `search_path` is attacker-adjacent
 * state and this query is the thing that decides whether we trust the session at
 * all.
 */
const ROLE_PRIVILEGE_SQL = `
SELECT
  current_user::text                                                  AS role_name,
  r.rolsuper                                                          AS is_superuser,
  r.rolcreatedb                                                       AS can_create_db,
  r.rolcreaterole                                                     AS can_create_role,
  r.rolreplication                                                    AS can_replicate,
  r.rolbypassrls                                                      AS bypasses_rls,
  pg_catalog.has_database_privilege(current_user, current_database(), 'TEMPORARY')      AS can_create_temp_tables,
  pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE')         AS can_create_in_database,
  pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')                     AS can_create_in_public_schema,
  pg_catalog.has_function_privilege(current_user, 'pg_catalog.pg_read_file(text)', 'EXECUTE') AS can_read_server_files,
  (
    SELECT count(*)
    FROM pg_catalog.pg_roles forbidden
    WHERE forbidden.rolname = ANY($1::text[])
      AND pg_catalog.pg_has_role(current_user, forbidden.oid, 'USAGE')
  )::int                                                              AS forbidden_role_memberships
FROM pg_catalog.pg_roles r
WHERE r.rolname = current_user
`;

interface PoolCacheEntry {
  url: string;
  pool: Pool;
  /** Resolved once per pool: the privilege verdict, so it is not re-queried per call. */
  privileges: Promise<DiagnosticsRolePrivilegeReport>;
}

let cached: PoolCacheEntry | null = null;

function createPool(url: string): Pool {
  return new Pool({
    connectionString: url,
    max: DIAGNOSTICS_TOOL_BOUNDS.maxPoolConnections,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: DIAGNOSTICS_APPLICATION_NAME,
    // Belt on top of the per-transaction `SET LOCAL`: even a connection that
    // somehow skipped the transaction wrapper cannot sit on a long query.
    statement_timeout: DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
  });
}

async function readRolePrivileges(pool: Pool): Promise<DiagnosticsRolePrivilegeReport> {
  const result = await pool.query(ROLE_PRIVILEGE_SQL, [
    [...FORBIDDEN_PREDEFINED_ROLES],
  ]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("Diagnostics role privilege probe returned no row.");
  }
  return {
    roleName: String(row.role_name ?? ""),
    isSuperuser: row.is_superuser === true,
    canCreateDb: row.can_create_db === true,
    canCreateRole: row.can_create_role === true,
    canReplicate: row.can_replicate === true,
    bypassesRls: row.bypasses_rls === true,
    canCreateTempTables: row.can_create_temp_tables === true,
    canCreateInDatabase: row.can_create_in_database === true,
    canCreateInPublicSchema: row.can_create_in_public_schema === true,
    canReadServerFiles: row.can_read_server_files === true,
    forbiddenRoleMemberships: Number(row.forbidden_role_memberships ?? 0),
  };
}

/**
 * The verified pool, or a typed refusal. The privilege probe runs ONCE per pool
 * and its promise is cached, so a session's eight tool calls pay for one probe —
 * but a fresh process, a changed connection string, or a closed pool all
 * re-probe. A role's privileges are database state, not request state; caching
 * them per pool is not the "stale permission matrix" mistake ADR-002 forbids
 * (that is about the CALLER's authorization, which is re-read every invocation in
 * `authorize.ts`).
 */
export type DiagnosticsDatabaseHandle =
  | { ok: true; pool: Pool; roleName: string }
  | {
      ok: false;
      reason: "database_not_configured" | "database_role_unsafe";
      problem?: DiagnosticsDatabaseConfigProblem;
      report?: DiagnosticsRolePrivilegeReport;
    };

export async function getDiagnosticsDatabase(): Promise<DiagnosticsDatabaseHandle> {
  const config = resolveDiagnosticsDatabaseConfig();
  if (!config.ok) {
    return {
      ok: false,
      reason: "database_not_configured",
      problem: config.problem,
    };
  }

  if (cached && cached.url !== config.url) {
    const stale = cached;
    cached = null;
    void stale.pool.end().catch(() => {});
  }
  if (!cached) {
    const pool = createPool(config.url);
    // A pool-level error listener is mandatory: an idle client that the server
    // terminates emits `error` on the Pool, and an unhandled one takes the whole
    // Node process down.
    pool.on("error", (err) => {
      reportAiError({
        tag: "diagnostics-select-only-pool",
        message: "Idle diagnostics SELECT-only connection errored",
        err,
      });
    });
    cached = {
      url: config.url,
      pool,
      privileges: readRolePrivileges(pool),
    };
  }

  /**
   * The entry THIS call is resolving, captured before any await.
   *
   * Everything below reads `entry` rather than `cached`, and only ever discards
   * `cached` when it is still identically this entry. Two concurrent callers
   * awaiting the same probe would otherwise race: the first nulls `cached`, the
   * second reads it as `null` and dereferences it (a `TypeError` that escaped as
   * `internal_error` instead of `database_role_unsafe`, losing the real reason
   * from the audit row), or worse, ends a pool a third caller has just created.
   */
  const entry = cached;

  /** Discard `entry` from the cache, but only if nobody has replaced it since. */
  const discardEntry = (): void => {
    if (cached === entry) cached = null;
    void entry.pool.end().catch(() => {});
  };

  let report: DiagnosticsRolePrivilegeReport;
  try {
    report = await entry.privileges;
  } catch (err) {
    // Cannot prove the role is safe ⇒ do not use it. Drop the cache so the next
    // call re-probes rather than inheriting a permanent failure.
    discardEntry();
    reportAiError({
      tag: "diagnostics-select-only-privileges",
      message: "Failed to verify the diagnostics SELECT-only role privileges",
      err,
    });
    return { ok: false, reason: "database_role_unsafe" };
  }

  if (!isDiagnosticsRolePrivilegeSafe(report)) {
    reportAiError({
      tag: "diagnostics-select-only-privileges",
      message:
        "Refusing to use the diagnostics database role: it is not SELECT-only",
      // Privilege booleans only — no connection string, no password, no role
      // secret. The role NAME is deployment configuration an operator needs to
      // act on the alert.
      context: { ...report },
    });
    // Drop the cache on an UNSAFE verdict, exactly as the probe-threw branch
    // above does. The verdict is cached per pool so a session's tool calls pay
    // for one probe — but caching a REFUSAL for the life of the process would
    // mean an operator who re-runs `npm run diagnostics:provision-role` to repair
    // a drifted role stays refused until the container restarts, with readiness
    // still reporting the old answer. Re-probing on every call is the right cost
    // for a deployment that is already being refused.
    discardEntry();
    return { ok: false, reason: "database_role_unsafe", report };
  }

  return { ok: true, pool: entry.pool, roleName: report.roleName };
}

/**
 * What the ADMIN READINESS surface (AID-2, `getDiagnosticsReadiness`) is allowed
 * to know about the diagnostics credential. Metadata only: a state and, when the
 * server confirmed one, the role NAME. Never the URL, never the password, never
 * the privilege report — a readiness response is JSON an admin browser receives.
 */
export type DiagnosticsDatabaseState =
  /** `AI_DIAGNOSTICS_DATABASE_URL` is absent. Nothing was contacted. */
  | "not_configured"
  /** Present but unusable as configured: malformed, no role, or the app's role. */
  | "misconfigured"
  /** Present, but the server could not be asked — so the role is NOT trusted. */
  | "unverified"
  /** Present and reachable, and the server says it is NOT least-privilege. */
  | "over_privileged"
  /** The server itself confirmed a non-superuser, SELECT-only role. */
  | "verified";

export interface DiagnosticsDatabaseReadiness {
  state: DiagnosticsDatabaseState;
  /** Set only when the server reported it (state `verified`). */
  roleName: string | null;
}

/**
 * VERIFY the diagnostics credential for the readiness surface, rather than trust
 * that the environment variable is set (issue #2374's acceptance criterion is
 * explicit about the difference).
 *
 * It deliberately goes through `getDiagnosticsDatabase`, so readiness and tool
 * invocation share ONE implementation of the check and ONE cached probe — a
 * second, readiness-shaped copy of the privilege query is exactly how a readiness
 * surface ends up reporting green while the executor refuses. Never throws:
 * "we could not tell" is `unverified`, which is a blocker, not a pass.
 */
export async function checkDiagnosticsDatabaseReadiness(): Promise<DiagnosticsDatabaseReadiness> {
  try {
    const handle = await getDiagnosticsDatabase();
    if (handle.ok) return { state: "verified", roleName: handle.roleName };
    if (handle.reason === "database_not_configured") {
      return {
        state: handle.problem === "not_set" ? "not_configured" : "misconfigured",
        roleName: null,
      };
    }
    // `database_role_unsafe` covers both "the server said no" (a report is
    // present) and "we could not ask" (it is not). They are different operator
    // actions — repair the role vs. fix connectivity — so they stay distinct.
    return {
      state: handle.report ? "over_privileged" : "unverified",
      roleName: null,
    };
  } catch (err) {
    reportAiError({
      tag: "diagnostics-select-only-readiness",
      message: "Failed to resolve diagnostics SELECT-only database readiness",
      err,
    });
    return { state: "unverified", roleName: null };
  }
}

/** Test/shutdown seam: drop the cached pool so the next call re-resolves and re-probes. */
export async function closeDiagnosticsDatabase(): Promise<void> {
  const stale = cached;
  cached = null;
  if (stale) await stale.pool.end().catch(() => {});
}

export interface DiagnosticsReadOnlyQueryInput {
  /** Server-owned SQL from the registry. NEVER caller-supplied. One statement. */
  sql: string;
  /** Positional parameters, already validated by the tool's Zod schema. */
  params: readonly unknown[];
  /**
   * The tool's row ceiling. The executor asks for `rowLimit + 1` rows so it can
   * report truncation honestly, and the cap is applied IN SQL — a tool whose own
   * SQL forgot a LIMIT is still bounded by the database.
   */
  rowLimit: number;
}

export type DiagnosticsReadOnlyQueryResult =
  | { ok: true; rows: Record<string, unknown>[]; durationMs: number }
  | { ok: false; durationMs: number; timedOut: boolean };

/** PostgreSQL `query_canceled` — what `statement_timeout` raises. */
const QUERY_CANCELED = "57014";

/**
 * Run one registry query as the SELECT-only role, inside a READ ONLY transaction
 * with its own timeouts and a SQL-level row cap.
 *
 * The wrapper subquery is the structural guarantee: whatever a registry entry's
 * SQL says, the executor's own `LIMIT` is the outermost clause, so no tool can
 * ship an unbounded scan by omission. `registry.ts`'s contract test refuses SQL
 * containing a semicolon, which is what makes wrapping safe.
 */
export async function runDiagnosticsReadOnlyQuery(
  input: DiagnosticsReadOnlyQueryInput,
  pool: Pool,
): Promise<DiagnosticsReadOnlyQueryResult> {
  // A non-finite limit must not survive the clamp: `Math.min`/`Math.max` both
  // propagate NaN, so `LIMIT (NaN)` would reach PostgreSQL and the read would fail
  // as `query_failed` — a bound turning into an error rather than a bound. Anything
  // unusable falls back to the substrate ceiling, which is still a real cap.
  const requested = Math.trunc(input.rowLimit);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), DIAGNOSTICS_TOOL_BOUNDS.maxRows)
    : DIAGNOSTICS_TOOL_BOUNDS.maxRows;
  const values = [...input.params, limit + 1];
  const wrapped = `SELECT * FROM (${input.sql}) AS diagnostics_tool_result LIMIT ($${values.length})::bigint`;

  const startedAt = Date.now();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    // READ ONLY at the transaction level is the database's own refusal of every
    // write, DDL and TEMP-table statement (SQLSTATE 25006) — independent of the
    // role's grants, so both layers have to fail before a write is possible.
    await client.query("BEGIN READ ONLY");
    // Integer literals from a frozen constant object, never from a caller.
    await client.query(
      `SET LOCAL statement_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs}`,
    );
    await client.query(
      `SET LOCAL lock_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.lockTimeoutMs}`,
    );
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.idleInTransactionTimeoutMs}`,
    );
    // Pinned per transaction so a role-level or database-level `search_path`
    // cannot redirect an unqualified relation name in a registry query.
    await client.query("SET LOCAL search_path TO public");

    const result: QueryResult = await client.query(wrapped, values);
    await client.query("COMMIT");
    return {
      ok: true,
      rows: result.rows as Record<string, unknown>[],
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: unknown }).code ?? "")
        : "";
    if (client) await client.query("ROLLBACK").catch(() => {});
    reportAiError({
      tag: "diagnostics-tool-query",
      message: "Diagnostics SELECT-only query failed",
      err,
      // The SQLSTATE only. The driver's message can quote the statement and its
      // parameter values, so it is never put in an audit row or a caller reply —
      // `reportAiError` keeps the error object itself for the server log.
      context: { sqlState: code },
    });
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      timedOut: code === QUERY_CANCELED,
    };
  } finally {
    client?.release();
  }
}
