/**
 * These tests cover the two decisions `database.ts` makes WITHOUT a database: is
 * this connection string acceptable, and is this privilege report acceptable.
 * Both are the fail-closed gates that stop a deployment pointing diagnostics at
 * its superuser, so they are tested exhaustively here and then proven against a
 * real PostgreSQL in
 * `src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AI_DIAGNOSTICS_DATABASE_URL_ENV,
  isDiagnosticsRolePrivilegeSafe,
  resolveDiagnosticsDatabaseConfig,
  type DiagnosticsRolePrivilegeReport,
} from "../database";

const APP_URL = "postgresql://tac:apppw@postgres:5432/tacbookings";
const DIAG_URL =
  "postgresql://ai_diagnostics_ro:diagpw@postgres:5432/tacbookings?connection_limit=3";

let originalApp: string | undefined;
let originalDiag: string | undefined;

beforeEach(() => {
  originalApp = process.env.DATABASE_URL;
  originalDiag = process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV];
  process.env.DATABASE_URL = APP_URL;
});

afterEach(() => {
  if (originalApp === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalApp;
  if (originalDiag === undefined) {
    delete process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV];
  } else {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = originalDiag;
  }
});

describe("resolveDiagnosticsDatabaseConfig (#2374, ADR-007)", () => {
  it("accepts a dedicated role on the same server as the application", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = DIAG_URL;
    const result = resolveDiagnosticsDatabaseConfig();
    expect(result).toEqual({
      ok: true,
      url: DIAG_URL,
      roleName: "ai_diagnostics_ro",
    });
  });

  it("fails closed when the variable is absent — there is NO fallback to DATABASE_URL", () => {
    delete process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV];
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "not_set",
    });
  });

  it.each(["", "   "])("treats a blank value (%j) as not set", (value) => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = value;
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "not_set",
    });
  });

  it.each([
    "not-a-url",
    "mysql://user:pw@host:3306/db",
    "http://postgres:5432/tacbookings",
    "file:///tmp/db",
  ])("refuses a non-PostgreSQL or malformed URL: %s", (value) => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = value;
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "malformed_url",
    });
  });

  it("refuses a URL with no role, because the role is the whole control", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://postgres:5432/tacbookings";
    // No `@`, so the "host" parses as the username-less form.
    const result = resolveDiagnosticsDatabaseConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toBe("missing_role");
  });

  it("refuses a byte-identical copy of DATABASE_URL", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = APP_URL;
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "reuses_application_role",
    });
  });

  it("refuses the application ROLE even with a different password, host or database", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://tac:otherpw@replica:5432/other";
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "reuses_application_role",
    });
  });

  it("refuses the application role regardless of capitalisation", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://TAC:apppw@postgres:5432/tacbookings";
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "reuses_application_role",
    });
  });

  it("still accepts a dedicated role when DATABASE_URL itself is unparseable", () => {
    process.env.DATABASE_URL = "totally-not-a-url";
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = DIAG_URL;
    const result = resolveDiagnosticsDatabaseConfig();
    expect(result.ok).toBe(true);
  });

  it("compares percent-encoded roles after decoding", () => {
    process.env.DATABASE_URL = "postgresql://my%20app:pw@postgres:5432/db";
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://my%20app:other@postgres:5432/db";
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "reuses_application_role",
    });
  });
});

const SAFE: DiagnosticsRolePrivilegeReport = {
  roleName: "ai_diagnostics_ro",
  isSuperuser: false,
  canCreateDb: false,
  canCreateRole: false,
  canReplicate: false,
  bypassesRls: false,
  canCreateTempTables: false,
  canCreateInDatabase: false,
  canCreateInPublicSchema: false,
  canReadServerFiles: false,
  forbiddenRoleMemberships: 0,
};

describe("isDiagnosticsRolePrivilegeSafe (#2374, ADR-007)", () => {
  it("accepts a fully restricted role", () => {
    expect(isDiagnosticsRolePrivilegeSafe(SAFE)).toBe(true);
  });

  it.each([
    "isSuperuser",
    "canCreateDb",
    "canCreateRole",
    "canReplicate",
    "bypassesRls",
    "canCreateTempTables",
    "canCreateInDatabase",
    "canCreateInPublicSchema",
    "canReadServerFiles",
  ] as const)("refuses a role holding %s", (field) => {
    expect(isDiagnosticsRolePrivilegeSafe({ ...SAFE, [field]: true })).toBe(false);
  });

  it("refuses a role that is a member of any escalating predefined role", () => {
    expect(
      isDiagnosticsRolePrivilegeSafe({ ...SAFE, forbiddenRoleMemberships: 1 }),
    ).toBe(false);
  });
});
