/**
 * The RUNTIME half of `database.ts` (#2374, ADR-007), against a fake `pg` pool.
 *
 * `database.test.ts` covers the two pure functions — connection-string vetting and
 * the privilege verdict. Everything else in that module used to be exercised only
 * by the opt-in real-PostgreSQL proof, which `describe.skip`s itself without
 * `RUN_CONCURRENCY_RACE_TESTS=1`. That left the pool cache, the readiness mapping,
 * and the exact SQL the executor sends with no coverage in ordinary `npm test`.
 *
 * Two things here are deliberately asserted as EXACT STRINGS rather than
 * behaviourally, because they are the substrate's structural guarantees and a fake
 * database cannot demonstrate their effect:
 *
 *  - the `LIMIT` wrapper and its parameter numbering, which is the reason a tool
 *    cannot ship an unbounded scan by omission. Every shipped entry binds zero
 *    parameters today, so the non-empty-parameter path first runs in production when
 *    a tool pack (AID-6A/B/C) lands — hard-coding `$1` or prepending the limit
 *    instead of appending it would pass every other test in the tree.
 *  - the four `SET LOCAL` statements and `BEGIN READ ONLY`, in order.
 *
 * The real PostgreSQL suite then proves the database AGREES with all of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability-bridge", () => ({ reportAiError: vi.fn() }));

/**
 * The fake `pg` module, built inside `vi.hoisted` because `vi.mock` factories are
 * lifted above every top-level binding in the file.
 */
const pg = vi.hoisted(() => {
  interface Recorded {
    sql: string;
    values?: unknown[];
  }

  /** A least-privilege report, as the probe query would return it. */
  const SAFE_PRIVILEGE_ROW = {
    role_name: "ai_diagnostics_ro",
    is_superuser: false,
    can_create_db: false,
    can_create_role: false,
    can_replicate: false,
    bypasses_rls: false,
    can_create_temp_tables: false,
    can_create_in_database: false,
    can_create_in_public_schema: false,
    can_read_server_files: false,
    forbidden_role_memberships: 0,
  };

  /** Mutable fixture the fake pool reads. Reset in `beforeEach`. */
  const fixture: {
    privilegeRow: Record<string, unknown> | undefined;
    probeError: Error | null;
    /** Resolves after this many ticks, so concurrent callers really do overlap. */
    probeDelayTicks: number;
    clientError: (Error & { code?: string }) | null;
    readRows: Record<string, unknown>[];
  } = {
    privilegeRow: { ...SAFE_PRIVILEGE_ROW },
    probeError: null,
    probeDelayTicks: 0,
    clientError: null,
    readRows: [],
  };

  class FakeClient {
    queries: Recorded[] = [];
    released = 0;

    async query(sql: string, values?: unknown[]) {
      this.queries.push({ sql, values });
      // Only the tool statement can fail; the transaction scaffolding does not.
      if (fixture.clientError && sql.includes("diagnostics_tool_result")) {
        throw fixture.clientError;
      }
      return { rows: fixture.readRows };
    }

    release() {
      this.released += 1;
    }
  }

  const pools: FakePool[] = [];

  class FakePool {
    options: Record<string, unknown>;
    clients: FakeClient[] = [];
    poolQueries: Recorded[] = [];
    errorHandlers: ((err: unknown) => void)[] = [];
    ended = 0;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      pools.push(this);
    }

    on(event: string, handler: (err: unknown) => void) {
      if (event === "error") this.errorHandlers.push(handler);
      return this;
    }

    async query(sql: string, values?: unknown[]) {
      this.poolQueries.push({ sql, values });
      for (let tick = 0; tick < fixture.probeDelayTicks; tick += 1) {
        await Promise.resolve();
      }
      if (fixture.probeError) throw fixture.probeError;
      return { rows: fixture.privilegeRow ? [fixture.privilegeRow] : [] };
    }

    async connect() {
      const client = new FakeClient();
      this.clients.push(client);
      return client;
    }

    async end() {
      this.ended += 1;
    }
  }

  return { SAFE_PRIVILEGE_ROW, fixture, pools, FakePool };
});

const { SAFE_PRIVILEGE_ROW, fixture, pools } = pg;

vi.mock("pg", () => ({ Pool: pg.FakePool, Client: pg.FakePool }));

import {
  AI_DIAGNOSTICS_DATABASE_URL_ENV,
  checkDiagnosticsDatabaseReadiness,
  closeDiagnosticsDatabase,
  DIAGNOSTICS_APPLICATION_NAME,
  getDiagnosticsDatabase,
  runDiagnosticsReadOnlyQuery,
} from "../database";
import { DIAGNOSTICS_TOOL_BOUNDS } from "../types";

const DIAG_URL = "postgresql://ai_diagnostics_ro:secret@db:5432/tacbookings";
const APP_URL = "postgresql://tac:apppass@db:5432/tacbookings";

beforeEach(async () => {
  await closeDiagnosticsDatabase();
  pools.length = 0;
  fixture.privilegeRow = SAFE_PRIVILEGE_ROW;
  fixture.probeError = null;
  fixture.probeDelayTicks = 0;
  fixture.clientError = null;
  fixture.readRows = [];
  process.env.DATABASE_URL = APP_URL;
  process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = DIAG_URL;
});

describe("getDiagnosticsDatabase — the verified pool (#2374, ADR-007)", () => {
  it("opens ONE pool, bounded and named, and probes privileges once per pool", async () => {
    const first = await getDiagnosticsDatabase();
    const second = await getDiagnosticsDatabase();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) expect(first.roleName).toBe("ai_diagnostics_ro");

    expect(pools).toHaveLength(1);
    expect(pools[0].options).toMatchObject({
      connectionString: DIAG_URL,
      max: DIAGNOSTICS_TOOL_BOUNDS.maxPoolConnections,
      application_name: DIAGNOSTICS_APPLICATION_NAME,
      statement_timeout: DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
    });
    // The verdict is cached per pool: eight tool calls pay for one probe.
    expect(pools[0].poolQueries).toHaveLength(1);
    // A pool-level error listener is mandatory — an unhandled one kills the process.
    expect(pools[0].errorHandlers.length).toBeGreaterThan(0);
  });

  it("refuses without connecting when the credential is not configured", async () => {
    delete process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV];
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) {
      expect(handle.reason).toBe("database_not_configured");
      expect(handle.problem).toBe("not_set");
    }
    expect(pools).toHaveLength(0);
  });

  it("refuses without connecting when the credential reuses the application role", async () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = APP_URL;
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) expect(handle.problem).toBe("reuses_application_role");
    expect(pools).toHaveLength(0);
  });

  it("re-probes and ends the old pool when the connection string changes", async () => {
    await getDiagnosticsDatabase();
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://ai_diagnostics_ro:rotated@db:5432/tacbookings";
    const handle = await getDiagnosticsDatabase();

    expect(handle.ok).toBe(true);
    expect(pools).toHaveLength(2);
    expect(pools[0].ended).toBe(1);
    expect(pools[1].poolQueries).toHaveLength(1);
  });

  it.each([
    ["is a superuser", { is_superuser: true }],
    ["can create databases", { can_create_db: true }],
    ["can create roles", { can_create_role: true }],
    ["can replicate", { can_replicate: true }],
    ["bypasses RLS", { bypasses_rls: true }],
    ["can create TEMP tables", { can_create_temp_tables: true }],
    ["can CREATE in the database", { can_create_in_database: true }],
    ["can CREATE in schema public", { can_create_in_public_schema: true }],
    ["can read server files", { can_read_server_files: true }],
    ["belongs to an escalating role", { forbidden_role_memberships: 1 }],
    ], )("refuses the role when the server says it %s", async (_label, drift) => {
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, ...drift };
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) {
      expect(handle.reason).toBe("database_role_unsafe");
      // The report travels so readiness can say "repair the role", not "check
      // connectivity" — two different operator actions.
      expect(handle.report).toBeDefined();
    }
  });

  it("does NOT cache an unsafe verdict — a repaired role is accepted next call", async () => {
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, is_superuser: true };
    const refused = await getDiagnosticsDatabase();
    expect(refused.ok).toBe(false);

    // The operator re-runs `npm run diagnostics:provision-role`.
    fixture.privilegeRow = SAFE_PRIVILEGE_ROW;
    const repaired = await getDiagnosticsDatabase();
    expect(repaired.ok).toBe(true);
    // A cached refusal would have required a container restart to clear.
    expect(pools).toHaveLength(2);
    expect(pools[0].ended).toBe(1);
  });

  it("refuses when the privilege probe cannot be run at all", async () => {
    fixture.probeError = new Error("connection refused");
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) {
      expect(handle.reason).toBe("database_role_unsafe");
      // No report: we could not ask, as opposed to being told no.
      expect(handle.report).toBeUndefined();
    }
  });

  it("refuses when the probe returns no row for the current role", async () => {
    fixture.privilegeRow = undefined;
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) expect(handle.reason).toBe("database_role_unsafe");
  });

  it("survives two CONCURRENT callers awaiting the same failing probe", async () => {
    // Both await the one cached probe promise. Each then discards the cache — so
    // the second must not dereference a cache the first already nulled, and must
    // not end a pool a later caller created. Before the entry was captured before
    // the await, this raised a TypeError that surfaced as `internal_error` and lost
    // the real reason from the audit row.
    fixture.probeError = new Error("connection refused");
    fixture.probeDelayTicks = 3;

    const [a, b] = await Promise.all([
      getDiagnosticsDatabase(),
      getDiagnosticsDatabase(),
    ]);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("database_role_unsafe");
    if (!b.ok) expect(b.reason).toBe("database_role_unsafe");
    // One pool, shared, and it is ended at most once per caller — never a pool a
    // third caller is still using.
    expect(pools).toHaveLength(1);
  });

  it("survives two CONCURRENT callers awaiting the same UNSAFE verdict", async () => {
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, can_create_temp_tables: true };
    fixture.probeDelayTicks = 3;

    const [a, b] = await Promise.all([
      getDiagnosticsDatabase(),
      getDiagnosticsDatabase(),
    ]);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(pools).toHaveLength(1);
  });
});

describe("checkDiagnosticsDatabaseReadiness — VERIFY, never trust (#2374)", () => {
  it("reports not_configured without contacting anything", async () => {
    delete process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV];
    expect(await checkDiagnosticsDatabaseReadiness()).toEqual({
      state: "not_configured",
      roleName: null,
    });
    expect(pools).toHaveLength(0);
  });

  it.each([
    ["not-a-url", "misconfigured"],
    ["mysql://user:pass@db/tacbookings", "misconfigured"],
    ["postgresql://:pass@db:5432/tacbookings", "misconfigured"],
    [APP_URL, "misconfigured"],
  ])("reports %s as %s", async (url, state) => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = url;
    const readiness = await checkDiagnosticsDatabaseReadiness();
    expect(readiness.state).toBe(state);
    expect(readiness.roleName).toBeNull();
  });

  it("reports over_privileged when the server says the role is not SELECT-only", async () => {
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, is_superuser: true };
    expect(await checkDiagnosticsDatabaseReadiness()).toEqual({
      state: "over_privileged",
      roleName: null,
    });
  });

  it("reports unverified when the server could not be asked", async () => {
    fixture.probeError = new Error("connection refused");
    expect(await checkDiagnosticsDatabaseReadiness()).toEqual({
      state: "unverified",
      roleName: null,
    });
  });

  it("reports verified with the role name only when the server confirmed it", async () => {
    expect(await checkDiagnosticsDatabaseReadiness()).toEqual({
      state: "verified",
      roleName: "ai_diagnostics_ro",
    });
  });

  it("shares the cached probe with tool invocation rather than re-querying", async () => {
    // One implementation of the check, one probe. A readiness-shaped second copy is
    // how a readiness surface ends up green while the executor refuses.
    await getDiagnosticsDatabase();
    await checkDiagnosticsDatabaseReadiness();
    expect(pools).toHaveLength(1);
    expect(pools[0].poolQueries).toHaveLength(1);
  });
});

describe("runDiagnosticsReadOnlyQuery — the bounded read-only read (#2374)", () => {
  async function run(
    input: Parameters<typeof runDiagnosticsReadOnlyQuery>[0],
  ) {
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(true);
    if (!handle.ok) throw new Error("expected a verified pool");
    const result = await runDiagnosticsReadOnlyQuery(input, handle.pool);
    const client = pools[0].clients.at(-1);
    if (!client) throw new Error("no client was checked out");
    return { result, client };
  }

  it("opens BEGIN READ ONLY, sets all four bounds, then commits and releases", async () => {
    fixture.readRows = [{ one: 1 }];
    const { result, client } = await run({
      sql: "SELECT 1 AS one",
      params: [],
      rowLimit: 5,
    });

    expect(result.ok).toBe(true);
    expect(client.queries.map((query) => query.sql)).toEqual([
      "BEGIN READ ONLY",
      `SET LOCAL statement_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs}`,
      `SET LOCAL lock_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.lockTimeoutMs}`,
      `SET LOCAL idle_in_transaction_session_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.idleInTransactionTimeoutMs}`,
      // `search_path` pinned so a role- or database-level setting cannot redirect
      // an unqualified relation name in a registry query.
      "SET LOCAL search_path TO public",
      "SELECT * FROM (SELECT 1 AS one) AS diagnostics_tool_result LIMIT ($1)::bigint",
      "COMMIT",
    ]);
    expect(client.released).toBe(1);
  });

  it("wraps the entry's SQL and appends the limit AFTER the entry's own parameters", async () => {
    // The numbering is the whole reason this is asserted as an exact string. A
    // registry entry's own `$1`/`$2` must still line up, so the limit has to be the
    // LAST parameter — `$3` here. Every shipped entry binds zero parameters today,
    // so a hard-coded `$1` would pass every other test in the tree and break the
    // first tool pack that takes an argument.
    fixture.readRows = [];
    const { client } = await run({
      sql: 'SELECT id FROM public."Booking" WHERE id = $1 AND status = $2',
      params: ["booking-1", "CONFIRMED"],
      rowLimit: 10,
    });

    const read = client.queries.at(-2);
    expect(read?.sql).toBe(
      'SELECT * FROM (SELECT id FROM public."Booking" WHERE id = $1 AND status = $2) AS diagnostics_tool_result LIMIT ($3)::bigint',
    );
    // rowLimit + 1, so truncation is knowable rather than guessed at.
    expect(read?.values).toEqual(["booking-1", "CONFIRMED", 11]);
  });

  it("asks for rowLimit + 1 rows, clamped to the substrate ceiling", async () => {
    const { client } = await run({
      sql: "SELECT 1",
      params: [],
      rowLimit: DIAGNOSTICS_TOOL_BOUNDS.maxRows * 100,
    });
    expect(client.queries.at(-2)?.values).toEqual([
      DIAGNOSTICS_TOOL_BOUNDS.maxRows + 1,
    ]);
  });

  it.each([0, -5, 0.4])(
    "floors a nonsensical row limit of %s at one row rather than zero",
    async (rowLimit) => {
      // A limit of 0 would return nothing and read as "no rows matched", which is a
      // different and misleading answer.
      const { client } = await run({ sql: "SELECT 1", params: [], rowLimit });
      expect(client.queries.at(-2)?.values).toEqual([2]);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back to the substrate ceiling for a non-finite row limit of %s",
    async (rowLimit) => {
      // `Math.min`/`Math.max` both PROPAGATE NaN, so the clamp used to emit
      // `LIMIT (NaN)` — PostgreSQL rejects it and the read fails as `query_failed`.
      // A bound that turns into an error is not a bound, so a non-finite value
      // resolves to the substrate ceiling instead.
      const { client, result } = await run({
        sql: "SELECT 1",
        params: [],
        rowLimit,
      });
      expect(result.ok).toBe(true);
      expect(client.queries.at(-2)?.values).toEqual([
        DIAGNOSTICS_TOOL_BOUNDS.maxRows + 1,
      ]);
    },
  );

  it("ROLLS BACK and releases when the read fails, and never leaks the driver text", async () => {
    const failure = new Error(
      'syntax error near "SELECT id FROM Member WHERE email = \'member@example.org\'"',
    ) as Error & { code?: string };
    failure.code = "42601";
    fixture.clientError = failure;

    const { result, client } = await run({
      sql: "SELECT 1",
      params: [],
      rowLimit: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(false);
      expect(JSON.stringify(result)).not.toContain("member@example.org");
    }
    expect(client.queries.map((query) => query.sql)).toContain("ROLLBACK");
    expect(client.queries.map((query) => query.sql)).not.toContain("COMMIT");
    expect(client.released).toBe(1);
  });

  it("reports a statement-timeout cancellation as timedOut", async () => {
    const cancelled = new Error(
      "canceling statement due to statement timeout",
    ) as Error & { code?: string };
    cancelled.code = "57014";
    fixture.clientError = cancelled;

    const { result } = await run({ sql: "SELECT 1", params: [], rowLimit: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.timedOut).toBe(true);
  });

  it("returns the driver's rows unchanged — bounding is the executor's job", async () => {
    fixture.readRows = [{ a: 1 }, { a: 2 }];
    const { result } = await run({ sql: "SELECT 1", params: [], rowLimit: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
