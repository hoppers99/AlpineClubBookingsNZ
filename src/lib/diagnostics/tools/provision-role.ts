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
 * intended way to rotate the password — but it also REVOKES every role
 * membership, and every table, sequence and routine privilege, from the role before
 * granting the (currently empty) allowlist back. That is the point: the grant
 * allowlist lives here, in public code, so "which tables can Diagnostics read" is
 * answerable by reading one file. A tool pack (AID-6A/B/C, #2375-#2377) that needs
 * a new table adds its grant to `SELECT_GRANTS` in the same pull request as the
 * tool — and an operator re-provisions as part of that upgrade. ADR-007's
 * "deliberate friction" is exactly this.
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
 * hand-granted escalation cannot survive a re-run.
 *
 * The revoke is written per RECORDED GRANT rather than as a bare
 * `REVOKE pg_monitor FROM <role>`, because a bare REVOKE only removes the grant the
 * CURRENT role made. PostgreSQL reports "not a member by role X" as a WARNING and
 * still returns success, so the bare form looked like the harmless normal case and
 * was in fact the silent-failure case whenever anybody else had done the granting
 * (measured on postgres:16.14 for `pg_monitor` and for an ordinary role alike).
 *
 * This list is NOT the membership control — step 5 below strips membership in
 * EVERY role, and the runtime self-check gates on the total. It is kept because
 * naming the eight escalation roles in public code documents what the control is
 * for, and because a refusal that can say "a predefined escalation role" is a
 * better sentence for an operator than a bare count.
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
 * The plain-English description of what that pattern accepts, so the operator CLI
 * and the deployment guide say the same thing this file enforces.
 */
export const SUPPORTED_IDENTIFIER_DESCRIPTION =
  "letters, digits and underscores only, starting with a letter or underscore, at most 63 characters (no '-', '.', '@' or '$')";

/**
 * True when this builder will accept `value` as a role or relation name.
 *
 * Exported so the operator CLI can refuse a bad name with its own actionable
 * message, naming the environment variable that carried it, instead of letting a
 * thrown `Error` reach the operator as a ten-frame Node stack trace. The
 * restriction is real and documented: a managed-provider role name like `tac-app`
 * or `user@server` is legal in PostgreSQL when quoted, and this builder refuses it
 * rather than carrying a tagged-quote scheme for the dollar-quoted `DO $$ … $$`
 * blocks below.
 */
export function isSupportedProvisionIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

/**
 * Quote a validated identifier. The strict pattern above is the real control —
 * quoting is the belt. Anything outside the pattern throws rather than being
 * escaped, because a diagnostics role called `"; DROP …` is a configuration
 * mistake to refuse, not a string to sanitise.
 */
export function quoteIdentifier(value: string): string {
  if (!isSupportedProvisionIdentifier(value)) {
    throw new Error(
      `Refusing to build provisioning SQL for identifier ${JSON.stringify(value)}: use ${SUPPORTED_IDENTIFIER_DESCRIPTION}.`,
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
  //    allowlist or the read-only contract.
  //
  //    REVOKE IS SCOPED TO THE GRANTOR, which is the whole reason this is written as
  //    a loop over `pg_auth_members` rather than as a bare
  //    `REVOKE pg_monitor FROM <role>`. A membership is recorded per grantor, and
  //    `REVOKE ... FROM ...` without `GRANTED BY` revokes only the CURRENT role's own
  //    grant — even for a superuser. Measured on postgres:16.14: a membership granted
  //    by a separate deployer role survived a superuser's bare REVOKE, which reported
  //    `REVOKE ROLE` and emitted nothing but
  //    `WARNING: role "…" has not been granted membership in role "…" by role
  //    "postgres"`, while `pg_has_role(…, 'MEMBER')` stayed true. Adding
  //    `GRANTED BY <grantor>` revoked it (measured: the row went, and the predicate
  //    went false).
  //
  //    Looping over the rows also removes the need for the old existence guard: the
  //    set of predefined roles grows with the server version (`pg_maintain` is
  //    PostgreSQL 17+), and a role that does not exist on this server simply
  //    contributes no rows.
  //
  //    And it stops the noise that would have buried the signal. The bare form warned
  //    once per predefined role on EVERY provision, whether or not anything was
  //    granted — measured, seven WARNINGs on a clean run against postgres:16 — so the
  //    one warning that mattered arrived in a crowd. Driven by recorded rows, a clean
  //    run is silent, which is what makes the operator CLI's notice output worth
  //    reading.
  for (const predefined of FORBIDDEN_PREDEFINED_ROLES) {
    statements.push(`DO $$
DECLARE
  grantor_name text;
BEGIN
  FOR grantor_name IN
    SELECT grantor.rolname
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = m.grantor
    WHERE granted.rolname = ${quoteLiteral(predefined)}
      AND member.rolname = ${roleLiteral}
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', ${quoteLiteral(predefined)}, ${roleLiteral}, grantor_name);
  END LOOP;
END
$$;`);
  }

  // 5. Strip membership in EVERY role, not only the eight named above. This is
  //    the membership control; step 4 is documentation with a revoke attached.
  //
  //    A diagnostics role that is a member of anything is one `SET ROLE` away from
  //    that role's privileges, and because this role is NOINHERIT the membership is
  //    invisible to every ordinary privilege check — measured on postgres:16.14,
  //    `GRANT "tac_app" TO "ai_diagnostics_ro"` left `rolsuper`,
  //    `has_table_privilege`, `has_function_privilege` and
  //    `pg_has_role(…, 'USAGE')` all reporting nothing, while `SET ROLE "tac_app"`
  //    read `IntegrationCredential` and inserted a `Booking`. So provisioning
  //    revokes the lot rather than enumerating the ways an operator might have
  //    granted one.
  //
  //    Revoking the DIRECT grants is sufficient and complete: `SET ROLE`
  //    reachability is transitive, but every chain starts at a direct edge from this
  //    role, so removing all of those removes the closure.
  //
  //    ONE ROW PER GRANTOR, AND `GRANTED BY` ON EVERY REVOKE. `pg_auth_members` holds
  //    a row per (granted role, member, grantor), and a REVOKE without `GRANTED BY`
  //    touches only the current role's own grant — so the earlier `SELECT DISTINCT`
  //    over role names alone was the bug, not an optimisation: it discarded exactly
  //    the column the REVOKE needs. It is not idempotent-and-therefore-harmless
  //    either. Measured on postgres:16.14, a membership granted by a deployer role
  //    survived a superuser's bare REVOKE with only a WARNING, the DO block committed,
  //    and the role stayed one `SET ROLE` from the app role's privileges while
  //    readiness reported `over_privileged` forever and this repair path claimed
  //    success.
  //
  //    THEN RE-CHECK AND RAISE. A warning is not a failure in PostgreSQL, and this
  //    statement list runs in one transaction whose only reason to exist is that a
  //    partial run must not commit. So the block re-reads `pg_auth_members` after the
  //    loop and raises if anything survived, which turns silent survival into the
  //    rollback the operator guide already promises. It also covers the credential
  //    case: a provisioner that may not revoke another role's grant fails loudly
  //    instead (measured: `permission denied to revoke privileges granted by role
  //    "…"`, `DETAIL: Only roles with privileges of role "…" may revoke privileges
  //    granted by this role`).
  //
  //    The re-check reads `pg_auth_members` and NOT `pg_has_role`, deliberately.
  //    `pg_database_owner` confers an implicit membership on whoever owns the current
  //    database, with no row in `pg_auth_members` and nothing to revoke — so a
  //    `pg_has_role` re-check would make provisioning impossible for a deployment
  //    whose diagnostics role owns its database, rather than merely refused at
  //    runtime. That case is documented in `deployment.md` as the one refusal
  //    re-provisioning cannot repair; the remedy is not to make the diagnostics role a
  //    database owner.
  statements.push(`DO $$
DECLARE
  membership record;
  surviving text;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role, grantor.rolname AS grantor
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = m.grantor
    WHERE member.rolname = ${roleLiteral}
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', membership.granted_role, ${roleLiteral}, membership.grantor);
  END LOOP;

  SELECT string_agg(DISTINCT granted.rolname, ', ')
    INTO surviving
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    WHERE member.rolname = ${roleLiteral};

  IF surviving IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to provision %: it is still a member of % after revoking every recorded membership. Revoke it with the grantor that granted it, then re-run.', ${roleLiteral}, surviving;
  END IF;
END
$$;`);

  // 6. Database-level privileges: CONNECT only. TEMP has to be revoked from
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

  // 7. Schema-level: USAGE (needed to name a relation at all), never CREATE.
  statements.push(
    `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role};`,
    `GRANT USAGE ON SCHEMA public TO ${role};`,
  );

  // 8. Object-level: revoke EVERYTHING, then grant back the allowlist. The
  //    revokes run on every provision so a hand-added grant cannot outlive the
  //    file that is supposed to declare it, and the default-privilege revoke
  //    stops a future table inheriting a grant automatically.
  //
  //    The ROUTINES revoke is not the control it looks like, and the docs say so:
  //    PostgreSQL grants EXECUTE on every new function to PUBLIC by default, and a
  //    PUBLIC grant cannot be revoked for one role. Revoking role-specific
  //    privileges (of which there are normally none) therefore leaves the role with
  //    EXECUTE on every function in schema `public` — measured on the migrated
  //    schema: 233 routines, all executable by the freshly provisioned role, before
  //    and after this statement. It is kept because it does strip a hand-added
  //    role-specific grant; what actually contains the residue is the READ ONLY
  //    transaction plus the runtime self-check, which counts the
  //    `SECURITY DEFINER` routines the role may execute and refuses on any (a
  //    `SECURITY DEFINER` function runs as its owner, so it is the one shape that
  //    could write). Revoking EXECUTE from PUBLIC is deliberately NOT done: it is
  //    database-wide collateral that would break the application's own functions,
  //    the same reasoning as `CREATE ON SCHEMA public` above.
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
