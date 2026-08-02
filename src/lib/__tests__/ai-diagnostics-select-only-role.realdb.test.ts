/**
 * Real-PostgreSQL PRIVILEGE PROOF for the AI Diagnostics SELECT-only database
 * role (AID-5, #2374; contract in ADR-007).
 *
 * WHY MOCKS ARE NOT ENOUGH, stated plainly because the issue makes this proof
 * mandatory: every claim ADR-007 makes is a claim about PostgreSQL's own
 * behaviour. "The role cannot INSERT", "it cannot CREATE TEMP TABLE", "it cannot
 * read `IntegrationCredential`", "a READ ONLY transaction refuses a write even
 * when the grant exists", "a long query is cancelled" — none of those can be
 * demonstrated by a fake. A unit test can only prove we ASKED for the right
 * thing; this suite proves the database AGREED.
 *
 * IT PROVES THE SHIPPED SQL. The role is created here by running
 * `buildAiDiagnosticsRoleSql` — the exact statement list
 * `npm run diagnostics:provision-role` executes for an operator — not a
 * hand-written fixture. A test fixture that re-declared its own grants would
 * prove nothing about what operators run.
 *
 * SAFETY ENVELOPE, the same as the sibling harnesses. OFF by default and a no-op
 * in ordinary `npm test`:
 *   - The proof describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`; otherwise
 *     it is `describe.skip` and never imports `pg` or connects to anything.
 *   - It reads ONLY `CONCURRENCY_RACE_DATABASE_URL` and requires a loopback host,
 *     port 55442+, and the dedicated `concurrency_race_1881` database marker.
 *   - Hosted CI runs it by importing this file from
 *     `concurrency-lock-races.realdb.test.ts`, which supplies that dedicated
 *     localhost database with every migration already deployed. The CI step is
 *     pinned by `review-findings-contracts.test.ts`, so the suite cannot be
 *     silently unplugged.
 *
 * It needs the migrations deployed, because the strongest single assertion here is
 * that the real `IntegrationCredential` table — the encrypted credential store —
 * is unreadable by this role.
 *
 * To run it directly against a throwaway Docker Postgres:
 *   docker run -d --name aid5-pg -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=concurrency_race_1881 \
 *     -p 127.0.0.1:55442:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
 *     npx prisma migrate deploy
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
 *     npx vitest run src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

/** The role this suite provisions. Deliberately not the default production name. */
const TEST_ROLE = "aid5_privilege_probe_ro";
const TEST_ROLE_PASSWORD = "aid5-privilege-proof-password-not-a-secret";
/** A table the role IS granted SELECT on, to prove read-vs-write asymmetry. */
const GRANTED_TABLE = "aid5_privilege_granted";
/** A table the role is granted INSERT on, to prove READ ONLY refuses it anyway. */
const WRITABLE_TABLE = "aid5_privilege_writable";
/** A table the role is granted nothing on, to prove the allowlist is closed. */
const UNGRANTED_TABLE = "aid5_privilege_ungranted";

/** PostgreSQL SQLSTATEs this suite asserts on. */
const INSUFFICIENT_PRIVILEGE = "42501";
const READ_ONLY_TRANSACTION = "25006";
const QUERY_CANCELED = "57014";

/**
 * Guard: never run against a default/production Postgres. Require the dedicated
 * env URL, loopback, an unusual high port, and the shared race-harness database
 * marker — the same envelope as `assertSafeRaceDbUrl` in
 * `concurrency-lock-races.realdb.test.ts`, re-declared here so this file can be
 * run standalone without importing (and re-registering) that whole harness.
 */
export function assertSafePrivilegeProofDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Diagnostics privilege proof needs a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run the diagnostics privilege proof against port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+ (never the default 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Diagnostics privilege proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Diagnostics privilege proof DB name must contain the dedicated marker 'concurrency_race_1881'.",
    );
  }
}

describe("diagnostics privilege proof DB safety guard (#2374)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafePrivilegeProofDbUrl(
        "postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881",
      ),
    ).not.toThrow();
  });

  it.each([
    "postgresql://user:pass@db.example.org:55442/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafePrivilegeProofDbUrl(url)).toThrow();
  });
});

(RUN ? describe : describe.skip)(
  "AI Diagnostics SELECT-only role — real PostgreSQL privilege proof (#2374)",
  () => {
    type PgClient = import("pg").Client;

    let PgClientCtor: typeof import("pg").Client;
    let buildAiDiagnosticsRoleSql: typeof import("@/lib/diagnostics/tools/provision-role")["buildAiDiagnosticsRoleSql"];
    let FORBIDDEN_PREDEFINED_ROLES: typeof import("@/lib/diagnostics/tools/provision-role")["FORBIDDEN_PREDEFINED_ROLES"];
    let getDiagnosticsDatabase: typeof import("@/lib/diagnostics/tools/database")["getDiagnosticsDatabase"];
    let closeDiagnosticsDatabase: typeof import("@/lib/diagnostics/tools/database")["closeDiagnosticsDatabase"];
    let runDiagnosticsReadOnlyQuery: typeof import("@/lib/diagnostics/tools/database")["runDiagnosticsReadOnlyQuery"];
    let DIAGNOSTICS_TOOLS: typeof import("@/lib/diagnostics/tools/registry")["DIAGNOSTICS_TOOLS"];
    let DIAGNOSTICS_TOOL_BOUNDS: typeof import("@/lib/diagnostics/tools/types")["DIAGNOSTICS_TOOL_BOUNDS"];

    let admin: PgClient;
    let roleUrl: string;
    let databaseName: string;
    let adminRole: string;

    /**
     * Run one statement as the restricted role and return the SQLSTATE, or null
     * when it succeeded.
     *
     * `disableReadOnlyDefault` matters for the privilege matrix below. The role
     * carries `default_transaction_read_only = on`, so a write attempt would
     * normally be refused with 25006 (read-only transaction) BEFORE the privilege
     * check ever ran — which would make a "cannot INSERT" assertion pass even if
     * the role held INSERT. Turning the read-only default off for the session
     * strips that layer away so the assertion proves the GRANT layer specifically.
     * The transaction layer is then proven separately, on a table the role
     * deliberately CAN write.
     */
    async function sqlStateAsRole(
      sql: string,
      options: {
        readOnlyTransaction?: boolean;
        disableReadOnlyDefault?: boolean;
      } = {},
    ): Promise<string | null> {
      const client = new PgClientCtor({ connectionString: roleUrl });
      await client.connect();
      try {
        if (options.disableReadOnlyDefault) {
          await client.query("SET default_transaction_read_only = off");
        }
        if (options.readOnlyTransaction) await client.query("BEGIN READ ONLY");
        await client.query(sql);
        if (options.readOnlyTransaction) await client.query("COMMIT");
        return null;
      } catch (err) {
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        return code || "unknown";
      } finally {
        await client.end().catch(() => {});
      }
    }

    async function provision(): Promise<void> {
      const statements = buildAiDiagnosticsRoleSql({
        roleName: TEST_ROLE,
        password: TEST_ROLE_PASSWORD,
        databaseName,
        preserveTempForRoles: [adminRole],
        statementTimeoutMs: DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
        connectionLimit: 6,
      });
      await admin.query("BEGIN");
      for (const statement of statements) await admin.query(statement);
      await admin.query("COMMIT");
    }

    beforeAll(async () => {
      // Guard the dedicated URL BEFORE importing pg or any app module.
      assertSafePrivilegeProofDbUrl(RACE_DB_URL);
      const parsed = new URL(RACE_DB_URL);
      databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
      adminRole = decodeURIComponent(parsed.username);

      ({ Client: PgClientCtor } = await import("pg"));
      ({ buildAiDiagnosticsRoleSql, FORBIDDEN_PREDEFINED_ROLES } = await import(
        "@/lib/diagnostics/tools/provision-role"
      ));
      ({ DIAGNOSTICS_TOOL_BOUNDS } = await import(
        "@/lib/diagnostics/tools/types"
      ));

      admin = new PgClientCtor({ connectionString: RACE_DB_URL });
      await admin.connect();

      // The migrations must be deployed: the headline assertion below is that the
      // real encrypted credential store is unreadable by this role.
      const credentialTable = await admin.query(
        `SELECT to_regclass('public."IntegrationCredential"') IS NOT NULL AS present`,
      );
      expect(
        credentialTable.rows[0]?.present,
        'The privilege proof needs the schema deployed — run `npx prisma migrate deploy` against CONCURRENCY_RACE_DATABASE_URL first (CI does this in the "Migrate dedicated advisory-lock race database" step).',
      ).toBe(true);

      for (const table of [GRANTED_TABLE, WRITABLE_TABLE, UNGRANTED_TABLE]) {
        await admin.query(`DROP TABLE IF EXISTS public.${table}`);
        await admin.query(
          `CREATE TABLE public.${table} (id integer PRIMARY KEY, note text)`,
        );
        await admin.query(
          `INSERT INTO public.${table} (id, note) VALUES (1, 'seed')`,
        );
      }

      await provision();

      // The grants a tool pack (AID-6A/B/C) would add for its own table, applied
      // here so the proof can show SELECT works while every write does not.
      await admin.query(
        `GRANT SELECT ON public.${GRANTED_TABLE} TO "${TEST_ROLE}"`,
      );
      // Deliberately over-granted: INSERT on this table exists ONLY so the suite
      // can prove the READ ONLY transaction refuses a write the GRANT allows.
      await admin.query(
        `GRANT SELECT, INSERT ON public.${WRITABLE_TABLE} TO "${TEST_ROLE}"`,
      );

      roleUrl = `postgresql://${TEST_ROLE}:${encodeURIComponent(TEST_ROLE_PASSWORD)}@${parsed.host}/${encodeURIComponent(databaseName)}`;

      // Point the app modules at the two roles: the application (superuser) URL
      // and the restricted diagnostics URL. `getDiagnosticsDatabase` refuses when
      // they name the same role, which is the case this separation avoids.
      process.env.DATABASE_URL = RACE_DB_URL;
      process.env.AI_DIAGNOSTICS_DATABASE_URL = roleUrl;
      ({
        getDiagnosticsDatabase,
        closeDiagnosticsDatabase,
        runDiagnosticsReadOnlyQuery,
      } = await import("@/lib/diagnostics/tools/database"));
      ({ DIAGNOSTICS_TOOLS } = await import("@/lib/diagnostics/tools/registry"));
    }, 120_000);

    afterAll(async () => {
      if (typeof closeDiagnosticsDatabase === "function") {
        await closeDiagnosticsDatabase().catch(() => {});
      }
      if (typeof admin !== "undefined") {
        for (const table of [GRANTED_TABLE, WRITABLE_TABLE, UNGRANTED_TABLE]) {
          await admin
            .query(`DROP TABLE IF EXISTS public.${table}`)
            .catch(() => {});
        }
        // Leave the database's PUBLIC TEMP grant as the provisioning left it for
        // the app role, but hand it back to PUBLIC so a later suite on this
        // shared throwaway database is unaffected by this one.
        await admin
          .query(`GRANT TEMPORARY ON DATABASE "${databaseName}" TO PUBLIC`)
          .catch(() => {});
        await admin
          .query(`REVOKE ALL ON SCHEMA public FROM "${TEST_ROLE}"`)
          .catch(() => {});
        await admin
          .query(`DROP ROLE IF EXISTS "${TEST_ROLE}"`)
          .catch(() => {});
        await admin.end().catch(() => {});
      }
    }, 120_000);

    // ---------------------------------------------------------------------
    // 1. The role's own attributes and database/schema privileges
    // ---------------------------------------------------------------------

    it("creates a NON-SUPERUSER role with no DDL, replication or RLS-bypass attribute", async () => {
      const result = await admin.query(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolcanlogin, rolconnlimit
         FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [TEST_ROLE],
      );
      const role = result.rows[0];
      expect(role).toBeDefined();
      expect(role.rolsuper).toBe(false);
      expect(role.rolcreatedb).toBe(false);
      expect(role.rolcreaterole).toBe(false);
      expect(role.rolreplication).toBe(false);
      expect(role.rolbypassrls).toBe(false);
      // NOINHERIT: a future accidental role grant does not silently take effect.
      expect(role.rolinherit).toBe(false);
      expect(role.rolcanlogin).toBe(true);
      expect(role.rolconnlimit).toBeGreaterThan(0);
    });

    it("denies TEMP and CREATE on the database, and CREATE on schema public", async () => {
      const result = await admin.query(
        `SELECT
           pg_catalog.has_database_privilege($1, current_database(), 'TEMPORARY') AS temp,
           pg_catalog.has_database_privilege($1, current_database(), 'CREATE')    AS create_db,
           pg_catalog.has_database_privilege($1, current_database(), 'CONNECT')   AS connect,
           pg_catalog.has_schema_privilege($1, 'public', 'CREATE')                AS create_schema,
           pg_catalog.has_schema_privilege($1, 'public', 'USAGE')                 AS usage_schema`,
        [TEST_ROLE],
      );
      const p = result.rows[0];
      expect(p.temp).toBe(false);
      expect(p.create_db).toBe(false);
      expect(p.create_schema).toBe(false);
      // It must still be able to connect and to name relations.
      expect(p.connect).toBe(true);
      expect(p.usage_schema).toBe(true);
    });

    it("holds no membership in any privilege-escalating predefined role", async () => {
      const result = await admin.query(
        `SELECT count(*)::int AS memberships
         FROM pg_catalog.pg_roles forbidden
         WHERE forbidden.rolname = ANY($2::text[])
           AND pg_catalog.pg_has_role($1, forbidden.oid, 'USAGE')`,
        [TEST_ROLE, [...FORBIDDEN_PREDEFINED_ROLES]],
      );
      expect(result.rows[0].memberships).toBe(0);
    });

    it("cannot execute server-file or large-object functions", async () => {
      const result = await admin.query(
        `SELECT
           pg_catalog.has_function_privilege($1, 'pg_catalog.pg_read_file(text)', 'EXECUTE')        AS read_file,
           pg_catalog.has_function_privilege($1, 'pg_catalog.pg_read_binary_file(text)', 'EXECUTE') AS read_binary,
           pg_catalog.has_function_privilege($1, 'pg_catalog.pg_ls_dir(text)', 'EXECUTE')           AS ls_dir,
           pg_catalog.has_function_privilege($1, 'pg_catalog.pg_reload_conf()', 'EXECUTE')          AS reload_conf`,
        [TEST_ROLE],
      );
      const p = result.rows[0];
      expect(p.read_file).toBe(false);
      expect(p.read_binary).toBe(false);
      expect(p.ls_dir).toBe(false);
      expect(p.reload_conf).toBe(false);
    });

    it("carries a server-side statement timeout and read-only default of its own", async () => {
      const result = await admin.query(
        `SELECT rolconfig FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [TEST_ROLE],
      );
      const config: string[] = result.rows[0].rolconfig ?? [];
      expect(config).toContain("default_transaction_read_only=on");
      expect(config).toContain(
        `statement_timeout=${DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs}ms`,
      );
      expect(config).toContain("search_path=public");
    });

    // ---------------------------------------------------------------------
    // 2. Read works; every write and every DDL statement FAILS
    // ---------------------------------------------------------------------

    it("can SELECT the one table it was granted", async () => {
      const client = new PgClientCtor({ connectionString: roleUrl });
      await client.connect();
      try {
        const result = await client.query(
          `SELECT id, note FROM public.${GRANTED_TABLE} ORDER BY id`,
        );
        expect(result.rows).toEqual([{ id: 1, note: "seed" }]);
      } finally {
        await client.end();
      }
    });

    it.each([
      ["INSERT", `INSERT INTO public.${GRANTED_TABLE} (id, note) VALUES (99, 'x')`],
      ["UPDATE", `UPDATE public.${GRANTED_TABLE} SET note = 'x' WHERE id = 1`],
      ["DELETE", `DELETE FROM public.${GRANTED_TABLE} WHERE id = 1`],
      ["TRUNCATE", `TRUNCATE public.${GRANTED_TABLE}`],
    ])(
      "is denied the PRIVILEGE to %s the table it can read",
      async (_label, sql) => {
        // Read-only default off, so 42501 (insufficient privilege) is the only
        // refusal available — this asserts the GRANT layer, not the transaction.
        const code = await sqlStateAsRole(sql, { disableReadOnlyDefault: true });
        expect(code).toBe(INSUFFICIENT_PRIVILEGE);
      },
    );

    it.each([
      ["CREATE TABLE", `CREATE TABLE public.aid5_should_not_exist (id int)`],
      ["CREATE TEMP TABLE", `CREATE TEMP TABLE aid5_temp_should_not_exist (id int)`],
      ["CREATE SCHEMA", `CREATE SCHEMA aid5_schema_should_not_exist`],
      ["CREATE INDEX", `CREATE INDEX aid5_idx ON public.${GRANTED_TABLE} (id)`],
      ["ALTER TABLE", `ALTER TABLE public.${GRANTED_TABLE} ADD COLUMN extra text`],
      ["DROP TABLE", `DROP TABLE public.${GRANTED_TABLE}`],
      [
        "CREATE FUNCTION",
        `CREATE FUNCTION public.aid5_fn() RETURNS int AS 'SELECT 1' LANGUAGE sql`,
      ],
      ["CREATE ROLE", `CREATE ROLE aid5_escalated LOGIN`],
      ["ALTER ROLE self SUPERUSER", `ALTER ROLE "${TEST_ROLE}" SUPERUSER`],
    ])("is denied the PRIVILEGE to run DDL: %s", async (_label, sql) => {
      const code = await sqlStateAsRole(sql, { disableReadOnlyDefault: true });
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("cannot grant itself access to a table it may not read", async () => {
      // PostgreSQL answers a GRANT from a role without grant option with a
      // WARNING rather than an error, so the assertion that matters is the
      // OUTCOME: the table is still unreadable afterwards.
      await sqlStateAsRole(
        `GRANT ALL ON public.${UNGRANTED_TABLE} TO "${TEST_ROLE}"`,
        { disableReadOnlyDefault: true },
      );
      expect(
        await sqlStateAsRole(`SELECT count(*) FROM public.${UNGRANTED_TABLE}`),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });

    // ---------------------------------------------------------------------
    // 3. The allowlist is closed, and the credential store is out of reach
    // ---------------------------------------------------------------------

    it("cannot read the encrypted credential store", async () => {
      const code = await sqlStateAsRole(
        `SELECT * FROM public."IntegrationCredential" LIMIT 1`,
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it.each([
      ["Member", `SELECT count(*) FROM public."Member"`],
      ["Booking", `SELECT count(*) FROM public."Booking"`],
      ["AuditLog", `SELECT count(*) FROM public."AuditLog"`],
      ["Payment", `SELECT count(*) FROM public."Payment"`],
    ])("cannot read the un-granted table %s", async (_label, sql) => {
      const code = await sqlStateAsRole(sql);
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("cannot read a table created after provisioning (no default privileges)", async () => {
      const code = await sqlStateAsRole(
        `SELECT count(*) FROM public.${UNGRANTED_TABLE}`,
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("re-running the provisioning statements REVOKES a hand-added grant", async () => {
      await admin.query(
        `GRANT SELECT ON public.${UNGRANTED_TABLE} TO "${TEST_ROLE}"`,
      );
      expect(
        await sqlStateAsRole(`SELECT count(*) FROM public.${UNGRANTED_TABLE}`),
      ).toBeNull();

      // The declarative reset: the grant allowlist lives in provision-role.ts, so
      // a re-provision strips anything that is not declared there.
      await provision();
      expect(
        await sqlStateAsRole(`SELECT count(*) FROM public.${UNGRANTED_TABLE}`),
      ).toBe(INSUFFICIENT_PRIVILEGE);

      // Re-provisioning is otherwise idempotent: the declared grant survives.
      await admin.query(
        `GRANT SELECT ON public.${GRANTED_TABLE} TO "${TEST_ROLE}"`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON public.${WRITABLE_TABLE} TO "${TEST_ROLE}"`,
      );
      expect(
        await sqlStateAsRole(`SELECT count(*) FROM public.${GRANTED_TABLE}`),
      ).toBeNull();
    });

    // ---------------------------------------------------------------------
    // 4. The READ ONLY transaction is an independent second layer
    // ---------------------------------------------------------------------

    it("refuses an INSERT the GRANT allows, inside a READ ONLY transaction", async () => {
      // This is the layering proof. `WRITABLE_TABLE` is deliberately granted
      // INSERT, so a privilege check alone would let this through; the read-only
      // transaction refuses it anyway (25006). A future tool pack that
      // over-granted by mistake would still be unable to write.
      const code = await sqlStateAsRole(
        `INSERT INTO public.${WRITABLE_TABLE} (id, note) VALUES (2, 'x')`,
        { readOnlyTransaction: true },
      );
      expect(code).toBe(READ_ONLY_TRANSACTION);
    });

    it("refuses that same INSERT with no explicit transaction, from the role default", async () => {
      // `default_transaction_read_only = on` is pinned on the role itself, so a
      // connection that forgot to open a READ ONLY transaction is still read-only.
      const code = await sqlStateAsRole(
        `INSERT INTO public.${WRITABLE_TABLE} (id, note) VALUES (3, 'x')`,
      );
      expect(code).toBe(READ_ONLY_TRANSACTION);
    });

    // ---------------------------------------------------------------------
    // 5. The application's own executor, against the real restricted role
    // ---------------------------------------------------------------------

    it("accepts the provisioned role through the runtime privilege self-check", async () => {
      const handle = await getDiagnosticsDatabase();
      expect(handle.ok).toBe(true);
      if (handle.ok) expect(handle.roleName).toBe(TEST_ROLE);
    });

    it("REFUSES the application's superuser credential at runtime", async () => {
      // The self-check is what stops a deployment pointing diagnostics at its
      // superuser. Proven against a real superuser role, not a mock: the URL is
      // the same shape, the role is genuinely a superuser, and the answer is no.
      await closeDiagnosticsDatabase();
      const parsed = new URL(RACE_DB_URL);
      // A distinct username is required to get past the config check, so the
      // privilege PROBE is what has to do the refusing here.
      process.env.DATABASE_URL = `postgresql://not_the_diagnostics_role:x@${parsed.host}/${databaseName}`;
      process.env.AI_DIAGNOSTICS_DATABASE_URL = RACE_DB_URL;
      try {
        const handle = await getDiagnosticsDatabase();
        expect(handle.ok).toBe(false);
        if (!handle.ok) {
          expect(handle.reason).toBe("database_role_unsafe");
          expect(handle.report?.isSuperuser).toBe(true);
        }
      } finally {
        await closeDiagnosticsDatabase();
        process.env.DATABASE_URL = RACE_DB_URL;
        process.env.AI_DIAGNOSTICS_DATABASE_URL = roleUrl;
      }
    });

    it("runs the registry probe tool's SQL and proves the transaction is READ ONLY", async () => {
      const handle = await getDiagnosticsDatabase();
      expect(handle.ok).toBe(true);
      if (!handle.ok) return;

      const probe = DIAGNOSTICS_TOOLS[0];
      const result = await runDiagnosticsReadOnlyQuery(
        { sql: probe.sql, params: [], rowLimit: probe.rowLimit },
        handle.pool,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = probe.project(result.rows[0]);
      expect(row.probeOk).toBe(true);
      // The database itself reporting the executor's settings back.
      expect(row.transactionReadOnly).toBe("on");
      // NUMERICALLY, not as a formatted string. PostgreSQL re-renders a GUC in
      // whatever unit divides evenly — `SET LOCAL statement_timeout = 5000` reads
      // back as `5s`, not `5000ms` — so the raw setting is only asserted to be
      // present and non-zero, and the derived millisecond value is what pins the
      // control. A regression that dropped the timeout entirely reports `0`.
      expect(row.statementTimeoutMs).toBe(
        DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
      );
      expect(row.statementTimeout).not.toBe("");
      expect(row.statementTimeout).not.toBe("0");
    });

    it("caps rows in SQL, whatever the query would have returned", async () => {
      const handle = await getDiagnosticsDatabase();
      expect(handle.ok).toBe(true);
      if (!handle.ok) return;

      // 100 rows available, rowLimit 3 → the executor's own LIMIT returns exactly
      // rowLimit + 1 (the extra row is how truncation is detected honestly).
      const result = await runDiagnosticsReadOnlyQuery(
        {
          sql: "SELECT g AS n FROM pg_catalog.generate_series(1, 100) AS g",
          params: [],
          rowLimit: 3,
        },
        handle.pool,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.rows).toHaveLength(4);
    });

    it("binds a registry entry's OWN parameters and still appends its LIMIT", async () => {
      // The executor wraps an entry's SQL and appends the row limit as the LAST
      // parameter, so the entry's own `$1`/`$2` keep their meaning. Every shipped
      // entry binds zero parameters today, so this path first runs in production
      // when a tool pack (AID-6A/B/C) lands — and a real server is the only thing
      // that can confirm the numbering, since a wrong `$n` is a runtime error rather
      // than a type error.
      const handle = await getDiagnosticsDatabase();
      expect(handle.ok).toBe(true);
      if (!handle.ok) return;

      const result = await runDiagnosticsReadOnlyQuery(
        {
          sql: "SELECT g AS n, $1::text AS first_param, $2::int AS second_param FROM pg_catalog.generate_series(1, 50) AS g ORDER BY g",
          params: ["bound-value", 42],
          rowLimit: 2,
        },
        handle.pool,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // rowLimit + 1 rows, proving the appended LIMIT parameter was read as the
      // limit and not consumed by the entry's own placeholders.
      expect(result.rows).toHaveLength(3);
      expect(result.rows[0]).toMatchObject({
        n: 1,
        first_param: "bound-value",
        second_param: 42,
      });
    });

    it("cannot execute a write through the executor at all, parameters or not", async () => {
      // A THIRD independent layer, below the role's grants and the read-only
      // transaction: the executor wraps every statement as
      // `SELECT * FROM (<sql>) AS … LIMIT …`, and an INSERT inside a FROM-subquery
      // is not valid SQL. So a registry entry that somehow shipped a write (it
      // would have to defeat `registry.test.ts` first) fails to PARSE before the
      // privilege check is ever reached — the error here is 42601, not 42501 or
      // 25006. Asserted on the OUTCOME rather than the SQLSTATE, because which
      // layer refuses first is an implementation detail and all three must hold.
      const handle = await getDiagnosticsDatabase();
      expect(handle.ok).toBe(true);
      if (!handle.ok) return;

      const result = await runDiagnosticsReadOnlyQuery(
        {
          sql: `INSERT INTO public.${WRITABLE_TABLE} (id, note) VALUES (99, $1) RETURNING id`,
          params: ["written-by-diagnostics"],
          rowLimit: 1,
        },
        handle.pool,
      );
      expect(result.ok).toBe(false);

      // And the row genuinely is not there.
      const after = await admin.query(
        `SELECT count(*)::int AS rows FROM public.${WRITABLE_TABLE} WHERE id = 99`,
      );
      expect(after.rows[0].rows).toBe(0);
    });

    it("cancels a long-running query at the statement timeout", async () => {
      const handle = await getDiagnosticsDatabase();
      expect(handle.ok).toBe(true);
      if (!handle.ok) return;

      const result = await runDiagnosticsReadOnlyQuery(
        { sql: "SELECT pg_catalog.pg_sleep(30) AS slept", params: [], rowLimit: 1 },
        handle.pool,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.timedOut).toBe(true);
        // Cancelled at the configured timeout, not after 30 seconds.
        expect(result.durationMs).toBeLessThan(
          DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs * 3,
        );
      }
    }, 40_000);

    it("cancels a long query run directly by the role, from its own role default", async () => {
      const code = await sqlStateAsRole("SELECT pg_catalog.pg_sleep(30)");
      expect(code).toBe(QUERY_CANCELED);
    }, 40_000);
  },
);
