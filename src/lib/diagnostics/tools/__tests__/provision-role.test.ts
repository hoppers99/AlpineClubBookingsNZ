/**
 * The provisioning SQL is public code that decides what a database credential can
 * do, so these tests read like a specification of the role rather than a smoke
 * test of a string builder. Every assertion below corresponds to a clause of
 * ADR-007 §1; the real-PostgreSQL proof
 * (`src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts`) then shows
 * the server agrees.
 */
import { describe, expect, it } from "vitest";

import {
  buildAiDiagnosticsRoleSql,
  DEFAULT_AI_DIAGNOSTICS_ROLE_NAME,
  FORBIDDEN_PREDEFINED_ROLES,
  quoteIdentifier,
  quoteLiteral,
  SELECT_GRANTS,
} from "../provision-role";

const base = {
  roleName: "ai_diagnostics_ro",
  password: "a-long-random-provisioning-password",
  databaseName: "tacbookings",
  preserveTempForRoles: ["tac"],
  statementTimeoutMs: 5_000,
  connectionLimit: 6,
};

function sql(overrides: Partial<typeof base> = {}): string {
  return buildAiDiagnosticsRoleSql({ ...base, ...overrides }).join("\n");
}

describe("AI Diagnostics SELECT-only role provisioning SQL (#2374, ADR-007)", () => {
  it("creates the role idempotently rather than failing on a re-run", () => {
    const statements = buildAiDiagnosticsRoleSql(base);
    expect(statements[0]).toContain("IF NOT EXISTS");
    expect(statements[0]).toContain("pg_catalog.pg_roles");
    expect(statements[0]).toContain("CREATE ROLE %I LOGIN");
  });

  it("pins every attribute that would make the role dangerous", () => {
    const text = sql();
    expect(text).toContain("NOSUPERUSER");
    expect(text).toContain("NOCREATEDB");
    expect(text).toContain("NOCREATEROLE");
    expect(text).toContain("NOREPLICATION");
    expect(text).toContain("NOBYPASSRLS");
    // NOINHERIT so an accidental future role grant does not take effect silently.
    expect(text).toContain("NOINHERIT");
    expect(text).toContain("CONNECTION LIMIT 6");
  });

  it("sets the role's own read-only default and timeouts", () => {
    const text = sql();
    expect(text).toContain("SET default_transaction_read_only = on");
    expect(text).toContain("SET statement_timeout = '5000ms'");
    expect(text).toContain("SET lock_timeout = '5000ms'");
    expect(text).toContain("SET idle_in_transaction_session_timeout = '10000ms'");
    expect(text).toContain("SET search_path = 'public'");
  });

  it("revokes TEMPORARY from PUBLIC and hands it back only to the named roles", () => {
    const text = sql({ preserveTempForRoles: ["tac", "migrator"] });
    // The only way to deny TEMP to one role, because it is a PUBLIC grant.
    expect(text).toContain(
      'REVOKE TEMPORARY ON DATABASE "tacbookings" FROM PUBLIC;',
    );
    expect(text).toContain('GRANT TEMPORARY ON DATABASE "tacbookings" TO "tac";');
    expect(text).toContain(
      'GRANT TEMPORARY ON DATABASE "tacbookings" TO "migrator";',
    );
    // The diagnostics role itself never gets it back.
    expect(text).not.toContain(
      'GRANT TEMPORARY ON DATABASE "tacbookings" TO "ai_diagnostics_ro";',
    );
  });

  it("grants the diagnostics role CONNECT and schema USAGE, and nothing else", () => {
    const text = sql();
    expect(text).toContain(
      'REVOKE ALL PRIVILEGES ON DATABASE "tacbookings" FROM "ai_diagnostics_ro";',
    );
    expect(text).toContain(
      'GRANT CONNECT ON DATABASE "tacbookings" TO "ai_diagnostics_ro";',
    );
    expect(text).toContain(
      'REVOKE ALL PRIVILEGES ON SCHEMA public FROM "ai_diagnostics_ro";',
    );
    expect(text).toContain('GRANT USAGE ON SCHEMA public TO "ai_diagnostics_ro";');
    // Never CREATE anywhere.
    expect(text).not.toMatch(/GRANT[^;]*CREATE[^;]*TO "ai_diagnostics_ro"/i);
  });

  it("strips every object privilege and default privilege before granting the allowlist", () => {
    const text = sql();
    expect(text).toContain(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "ai_diagnostics_ro";',
    );
    expect(text).toContain(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "ai_diagnostics_ro";',
    );
    expect(text).toContain(
      'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM "ai_diagnostics_ro";',
    );
    expect(text).toContain(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "ai_diagnostics_ro";',
    );
  });

  it("revokes escalating predefined roles, guarded for server versions that lack them", () => {
    const statements = buildAiDiagnosticsRoleSql(base);
    for (const predefined of FORBIDDEN_PREDEFINED_ROLES) {
      const statement = statements.find((candidate) =>
        candidate.includes(`'${predefined}'`),
      );
      expect(statement, `no revoke statement for ${predefined}`).toBeDefined();
      // Guarded: a bare REVOKE of a role that does not exist on this server
      // (pg_maintain is PostgreSQL 17+) would abort the whole provisioning run.
      expect(statement).toContain("IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles");
      expect(statement).toContain("REVOKE %I FROM %I");
    }
  });

  it("ships an EMPTY SELECT allowlist — AID-5 carries no domain tool", () => {
    expect(SELECT_GRANTS).toHaveLength(0);
    expect(sql()).not.toMatch(/GRANT SELECT ON "/);
    // And never a blanket grant, whatever the allowlist grows to.
    expect(sql()).not.toMatch(/GRANT SELECT ON ALL TABLES/i);
  });

  // ------------------------------------------------------------------
  // ORDER. Every assertion above is `toContain` against a joined string, which
  // cannot tell a correct order from a reversed one. These pin the three ordered
  // pairs by INDEX, because each reversal is silently destructive: revoking after
  // granting strips the grant, and granting TEMP back before revoking it from
  // PUBLIC leaves the diagnostics role holding TEMP.
  // ------------------------------------------------------------------
  describe("statement ORDER is load-bearing", () => {
    function indexOfStatement(
      statements: string[],
      fragment: string,
    ): number {
      const index = statements.findIndex((statement) =>
        statement.includes(fragment),
      );
      expect(index, `no statement contains ${fragment}`).toBeGreaterThanOrEqual(0);
      return index;
    }

    it("creates or repairs the role BEFORE altering it", () => {
      const statements = buildAiDiagnosticsRoleSql(base);
      expect(indexOfStatement(statements, "CREATE ROLE %I LOGIN")).toBeLessThan(
        indexOfStatement(statements, "NOSUPERUSER"),
      );
    });

    it("revokes TEMPORARY from PUBLIC BEFORE granting it back", () => {
      const statements = buildAiDiagnosticsRoleSql({
        ...base,
        preserveTempForRoles: ["tac"],
      });
      expect(
        indexOfStatement(statements, "REVOKE TEMPORARY ON DATABASE"),
      ).toBeLessThan(indexOfStatement(statements, "GRANT TEMPORARY ON DATABASE"));
    });

    it("revokes all database privileges BEFORE granting CONNECT", () => {
      const statements = buildAiDiagnosticsRoleSql(base);
      expect(
        indexOfStatement(statements, "REVOKE ALL PRIVILEGES ON DATABASE"),
      ).toBeLessThan(indexOfStatement(statements, "GRANT CONNECT ON DATABASE"));
    });

    it("revokes all schema privileges BEFORE granting USAGE", () => {
      const statements = buildAiDiagnosticsRoleSql(base);
      expect(
        indexOfStatement(statements, "REVOKE ALL PRIVILEGES ON SCHEMA public"),
      ).toBeLessThan(indexOfStatement(statements, "GRANT USAGE ON SCHEMA public"));
    });

    it("revokes every object and default privilege BEFORE granting the allowlist", () => {
      // The shipped allowlist is empty, so this is the one property the empty list
      // makes untestable without the seam — and it is the one whose reversal would
      // silently strip the grant a future tool pack just added.
      const statements = buildAiDiagnosticsRoleSql({
        ...base,
        selectGrants: [{ schema: "public", relation: "Booking" }],
      });
      const grantIndex = indexOfStatement(
        statements,
        'GRANT SELECT ON "public"."Booking"',
      );
      for (const revoke of [
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public",
        "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public",
        "REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES",
      ]) {
        expect(
          indexOfStatement(statements, revoke),
          `${revoke} must run before the allowlist grant`,
        ).toBeLessThan(grantIndex);
      }
      // A grant is per-relation, never blanket, however the allowlist grows.
      expect(statements[grantIndex]).not.toMatch(/ALL TABLES/i);
    });
  });

  it("never mentions a secret-bearing relation", () => {
    const text = sql().toLowerCase();
    for (const relation of [
      "integrationcredential",
      "verificationtoken",
      "passwordreset",
      "twofactor",
      "usersession",
    ]) {
      expect(text).not.toContain(relation);
    }
  });

  it("does not touch PUBLIC's CREATE privilege on schema public", () => {
    // Deliberate: PostgreSQL 15+ already denies it, and revoking it could break a
    // fork whose app role is not a superuser. `database.ts` refuses at runtime if
    // the diagnostics role turns out to hold it.
    expect(sql()).not.toMatch(/REVOKE CREATE ON SCHEMA public FROM PUBLIC/i);
  });

  it("defaults to a role name that is not the application role", () => {
    expect(DEFAULT_AI_DIAGNOSTICS_ROLE_NAME).toBe("ai_diagnostics_ro");
    expect(DEFAULT_AI_DIAGNOSTICS_ROLE_NAME).not.toBe("tac");
  });
});

describe("provisioning SQL quoting refuses hostile input rather than escaping it", () => {
  it.each([
    'evil"; DROP DATABASE tacbookings; --',
    "role name with spaces",
    "1_leading_digit",
    "",
    "a".repeat(64),
    // `$` is legal in a PostgreSQL identifier but is refused here: the same name is
    // also emitted as a SQL LITERAL inside a dollar-quoted `DO $$ … $$` body, and a
    // name containing `$$` would terminate that body early. Quoting cannot save it,
    // so it is refused rather than escaped.
    "role$$name",
    "trailing$",
  ])("refuses identifier %s", (value) => {
    expect(() => quoteIdentifier(value)).toThrow();
  });

  it("keeps the DO-block bodies intact for every accepted role name", () => {
    // The structural reason `$` is barred: each guarded `DO $$ … $$` block must
    // contain exactly one opening and one closing dollar quote.
    for (const statement of buildAiDiagnosticsRoleSql(base)) {
      if (!statement.startsWith("DO $$")) continue;
      expect(statement.match(/\$\$/g)).toHaveLength(2);
      expect(statement.trimEnd().endsWith("$$;")).toBe(true);
    }
  });

  it("refuses a literal containing a DEL character", () => {
    expect(() => quoteLiteral(`del${String.fromCharCode(0x7f)}byte`)).toThrow();
  });

  it("accepts the PascalCase relation names this schema uses", () => {
    expect(quoteIdentifier("IntegrationCredential")).toBe(
      '"IntegrationCredential"',
    );
  });

  it("doubles single quotes in a literal", () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
    // Safe under standard_conforming_strings, which is PostgreSQL's default.
    expect(quoteLiteral("back\\slash")).toBe("'back\\slash'");
  });

  it("refuses a literal containing control characters", () => {
    expect(() => quoteLiteral("line\nbreak")).toThrow();
    expect(() => quoteLiteral("nul\u0000byte")).toThrow();
  });

  it.each([
    { roleName: 'x"; ALTER ROLE postgres SUPERUSER; --' },
    { databaseName: "db; DROP SCHEMA public" },
    { preserveTempForRoles: ["ok", "not ok"] },
    { statementTimeoutMs: 0 },
    { statementTimeoutMs: 1.5 },
    { connectionLimit: -1 },
  ])("refuses to build SQL for invalid input %o", (overrides) => {
    expect(() =>
      buildAiDiagnosticsRoleSql({ ...base, ...overrides }),
    ).toThrow();
  });

  it("keeps a quote-bearing password inside its literal", () => {
    const text = sql({ password: "pa'ss" });
    expect(text).toContain("PASSWORD 'pa''ss'");
  });
});
