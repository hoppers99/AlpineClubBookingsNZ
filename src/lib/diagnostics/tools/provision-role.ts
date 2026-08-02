/**
 * AI Diagnostics — provisioning SQL for the dedicated SELECT-only database role
 * (AID-5, #2374; contract in ADR-007).
 *
 * PURE ON PURPOSE. This module builds the ordered statement list and nothing
 * else: no database handle, no environment read, no `server-only` import (the
 * operator CLI `scripts/diagnostics/provision-ai-diagnostics-role.ts` runs it
 * under `tsx`). That keeps three consumers on ONE definition of the role —
 * the operator's `npm run diagnostics:provision-role`, CI's privilege-proof
 * step, and `ai-diagnostics-select-only-role.realdb.test.ts`, which proves the
 * shipped statements really do produce a role that cannot write. A test fixture
 * that re-declared its own grants would prove nothing about what operators run.
 *
 * DECLARATIVE, NOT ADDITIVE. Re-running the statements is safe and is the
 * intended way to rotate the password — but it also REVOKES every table,
 * sequence and routine privilege from the role before granting the (currently
 * empty) allowlist back. That is the point: the grant allowlist lives here, in
 * public code, so "which tables can Diagnostics read" is answerable by reading
 * one file. A tool pack (AID-6A/B/C, #2375-#2377) that needs a new table adds
 * its grant to `SELECT_GRANTS` in the same pull request as the tool — and an
 * operator re-provisions as part of that upgrade. ADR-007's "deliberate
 * friction" is exactly this.
 *
 * WHAT IT DOES *NOT* DO, deliberately:
 *  - It does not revoke `CREATE ON SCHEMA public FROM PUBLIC`. PostgreSQL 15+
 *    already denies it, so on a supported server the statement would be a no-op;
 *    on an older or hand-tuned fork it could break a non-superuser app role
 *    mid-migration. Instead the runtime self-check (`database.ts`) REFUSES to run
 *    any tool if the diagnostics role turns out to hold schema CREATE, so the
 *    anomaly is loud rather than silently patched under an operator's feet.
 *  - It does not create the database, the app role, or any view.
 *  - It never prints or logs the password.
 */

/**
 * The one collateral change this provisioning makes to shared database state,
 * called out because a reviewer must see it: `TEMPORARY` on the database is
 * granted to `PUBLIC` by default, and PUBLIC grants cannot be revoked for a
 * single role. Denying the diagnostics role TEMP therefore requires revoking it
 * from PUBLIC and granting it back to the roles that should keep it. The stock
 * Compose stack is unaffected — its app role is a SUPERUSER and bypasses
 * privilege checks entirely — but a fork whose app role is NOT a superuser must
 * be listed in `preserveTempForRoles`.
 */
export const PUBLIC_TEMP_REVOKE_NOTE =
  "REVOKE TEMPORARY ... FROM PUBLIC is database-wide; roles in preserveTempForRoles get it back.";

/**
 * Predefined roles that would defeat the table allowlist or the read-only
 * contract outright. Membership is revoked explicitly on every provision so a
 * hand-granted escalation cannot survive a re-run. PostgreSQL warns (and
 * succeeds) when the role is not a member, which is the harmless normal case.
 */
export const FORBIDDEN_PREDEFINED_ROLES = [
  "pg_read_all_data",
  "pg_write_all_data",
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_execute_server_program",
  "pg_signal_backend",
  "pg_monitor",
  "pg_maintain",
] as const;

/**
 * The SELECT allowlist — EMPTY in AID-5. This substrate ships no domain tool
 * (epic #2369 fixes that boundary: AID-6A/B/C add the tools), so it needs no
 * table privilege at all: the readiness probe reads no relation. An empty
 * allowlist is the strongest possible starting point, and it makes the privilege
 * proof unambiguous — every table in the schema, including `IntegrationCredential`,
 * is unreadable by this role today.
 *
 * A tool pack appends `{ schema: "public", relation: "SomeTable" }` here, in the
 * same pull request as the tool that needs it, and NEVER a blanket
 * `ALL TABLES IN SCHEMA` grant. Secret-bearing relations (credentials, tokens,
 * password/2FA, sessions) and raw provider-payload stores are permanently out of
 * scope (ADR-007 §1).
 */
export const SELECT_GRANTS: readonly { schema: string; relation: string }[] = [];

export interface AiDiagnosticsRoleProvisionInput {
  /** The dedicated role to create/repair. Lowercase identifier. */
  roleName: string;
  /** The role's password. Quoted as a SQL literal; never logged. */
  password: string;
  /** The database the role may CONNECT to. */
  databaseName: string;
  /**
   * Roles that must keep `TEMPORARY` on the database after it is revoked from
   * PUBLIC — the app/owner role and whoever runs migrations. A SUPERUSER does
   * not need listing (it bypasses checks) but listing it is harmless.
   */
  preserveTempForRoles: readonly string[];
  /** Statement timeout baked into the role itself, as a second line of defence. */
  statementTimeoutMs: number;
  /** `CONNECTION LIMIT` for the role, bounding the blast radius of a leak. */
  connectionLimit: number;
  /**
   * TEST SEAM ONLY — defaults to the shipped `SELECT_GRANTS`, which is what the
   * operator CLI and CI both use.
   *
   * It exists because the shipped allowlist is EMPTY in AID-5, and the property
   * that matters most about this builder — that a re-provision revokes everything
   * BEFORE it grants the allowlist back — is untestable against an empty list. Left
   * untestable, the first tool pack to add a grant would be the first thing to
   * discover a reversed order, by silently stripping the grant it just added. This
   * is a pure string builder with no runtime authority: the privileges a role
   * actually holds are re-verified against the server on every tool call, so an
   * override here cannot widen anything.
   */
  selectGrants?: readonly { schema: string; relation: string }[];
}

/**
 * A PostgreSQL identifier we are willing to interpolate. Mixed case is allowed
 * because this schema's relations are PascalCase (`"IntegrationCredential"`) and
 * every identifier here is emitted double-quoted, so case is preserved exactly.
 *
 * `$` is deliberately EXCLUDED even though PostgreSQL permits it in an identifier.
 * Role and relation names also travel through `quoteLiteral` into the body of a
 * dollar-quoted `DO $$ ... $$` block below, so a name containing `$$` would
 * terminate that body early and the whole provisioning run would fail on a syntax
 * error. Nothing in this schema needs `$`, and refusing it here is cheaper than
 * carrying a tagged-quote scheme for a character no deployment wants.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Quote a validated identifier. The strict pattern above is the real control —
 * quoting is the belt. Anything outside the pattern throws rather than being
 * escaped, because a diagnostics role called `"; DROP …` is a configuration
 * mistake to refuse, not a string to sanitise.
 */
export function quoteIdentifier(value: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `Refusing to build provisioning SQL for identifier ${JSON.stringify(value)}: use letters, digits and underscores only (no '$', which would break a dollar-quoted block).`,
    );
  }
  return `"${value}"`;
}

/**
 * Quote a SQL string literal by doubling single quotes. Safe under
 * `standard_conforming_strings = on` (PostgreSQL's default since 9.1), which is
 * why backslashes need no special handling. Control characters and NULs are
 * REFUSED rather than escaped: a password containing one is almost certainly a
 * copy-paste accident, and refusing is the safer failure.
 */
export function quoteLiteral(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        "Refusing to build provisioning SQL for a value containing control characters.",
      );
    }
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The ordered, idempotent statement list that provisions the role. Every
 * statement is safe to re-run, and the ORDER is load-bearing: create/repair the
 * role, strip everything, then grant back only the (currently empty) allowlist.
 * Running the list is what makes the role's shape a database fact rather than an
 * operator's good intentions.
 */
export function buildAiDiagnosticsRoleSql(
  input: AiDiagnosticsRoleProvisionInput,
): string[] {
  const role = quoteIdentifier(input.roleName);
  const database = quoteIdentifier(input.databaseName);
  const roleLiteral = quoteLiteral(input.roleName);
  const passwordLiteral = quoteLiteral(input.password);

  if (!Number.isInteger(input.statementTimeoutMs) || input.statementTimeoutMs <= 0) {
    throw new Error("statementTimeoutMs must be a positive integer.");
  }
  if (!Number.isInteger(input.connectionLimit) || input.connectionLimit <= 0) {
    throw new Error("connectionLimit must be a positive integer.");
  }

  const statements: string[] = [
    // 1. Create the role if it is absent. `DO` rather than `CREATE ROLE IF NOT
    //    EXISTS` because PostgreSQL has no such form, and a plain CREATE would
    //    make re-provisioning (the password-rotation path) fail.
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${roleLiteral}) THEN
    EXECUTE format('CREATE ROLE %I LOGIN', ${roleLiteral});
  END IF;
END
$$;`,

    // 2. Pin every role ATTRIBUTE, whether the role was just created or already
    //    existed with drifted attributes. This is the line that makes
    //    "non-superuser" a fact: NOSUPERUSER, no DDL-adjacent attribute, no
    //    replication, and NOBYPASSRLS so row-level security still applies.
    //    NOINHERIT means a future accidental role grant does not silently take
    //    effect. The password is (re)set here, which is the rotation path.
    `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${input.connectionLimit} PASSWORD ${passwordLiteral};`,

    // 3. Server-side defaults, so the restrictions hold even for a connection
    //    that forgets to open a READ ONLY transaction (a psql session an
    //    operator opens with this credential, for instance). The application
    //    ALSO sets all of these per transaction — see `database.ts`.
    `ALTER ROLE ${role} SET default_transaction_read_only = on;`,
    `ALTER ROLE ${role} SET statement_timeout = ${quoteLiteral(`${input.statementTimeoutMs}ms`)};`,
    `ALTER ROLE ${role} SET lock_timeout = ${quoteLiteral(`${input.statementTimeoutMs}ms`)};`,
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = ${quoteLiteral(`${input.statementTimeoutMs * 2}ms`)};`,
    `ALTER ROLE ${role} SET search_path = 'public';`,
  ];

  // 4. Strip any membership in a predefined role that would bypass the
  //    allowlist or the read-only contract. Guarded by an existence check
  //    because the set of predefined roles grows with the server version
  //    (`pg_maintain` is PostgreSQL 17+): a bare REVOKE of an absent role errors
  //    and would abort the whole provisioning run on an older server.
  for (const predefined of FORBIDDEN_PREDEFINED_ROLES) {
    statements.push(`DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${quoteLiteral(predefined)}) THEN
    EXECUTE format('REVOKE %I FROM %I', ${quoteLiteral(predefined)}, ${roleLiteral});
  END IF;
END
$$;`);
  }

  // 5. Database-level privileges: CONNECT only. TEMP has to be revoked from
  //    PUBLIC to be denied to this role at all (see PUBLIC_TEMP_REVOKE_NOTE),
  //    and is granted straight back to the roles that legitimately need it.
  statements.push(
    `REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM ${role};`,
    `REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC;`,
  );
  for (const preserved of input.preserveTempForRoles) {
    statements.push(
      `GRANT TEMPORARY ON DATABASE ${database} TO ${quoteIdentifier(preserved)};`,
    );
  }
  statements.push(`GRANT CONNECT ON DATABASE ${database} TO ${role};`);

  // 6. Schema-level: USAGE (needed to name a relation at all), never CREATE.
  statements.push(
    `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role};`,
    `GRANT USAGE ON SCHEMA public TO ${role};`,
  );

  // 7. Object-level: revoke EVERYTHING, then grant back the allowlist. The
  //    revokes run on every provision so a hand-added grant cannot outlive the
  //    file that is supposed to declare it, and the default-privilege revoke
  //    stops a future table inheriting a grant automatically.
  statements.push(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role};`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role};`,
    `REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM ${role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM ${role};`,
  );
  for (const grant of input.selectGrants ?? SELECT_GRANTS) {
    statements.push(
      `GRANT SELECT ON ${quoteIdentifier(grant.schema)}.${quoteIdentifier(grant.relation)} TO ${role};`,
    );
  }

  return statements;
}

/** Default role name. Deployments may override; the shape is what matters. */
export const DEFAULT_AI_DIAGNOSTICS_ROLE_NAME = "ai_diagnostics_ro";
