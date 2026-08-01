import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// #2290 — the audit archive column contract.
//
// Archived audit rows are DELETED from the main table, so a column the archive
// forgets is gone permanently. `src/lib/audit-retention.ts` derives the select,
// the CREATE TABLE and the INSERT from one manifest whose key type comes from
// Prisma's generated AuditLogScalarFieldEnum, which makes a forgotten column a
// compile error. These tests are the runtime half of that guarantee: they check
// the same coverage against the schema's own model definition (the DMMF), and
// they check that the SQL the writer actually emits carries every column.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  findMany: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
      findMany: mocks.findMany,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: mocks.loggerInfo,
    error: mocks.loggerError,
  },
}));

import {
  AUDIT_ARCHIVE_COLUMNS,
  AUDIT_ARCHIVE_EXCLUDED_COLUMNS,
  archiveEligibleAuditLogs,
} from "@/lib/audit-retention";

// --------------------------------------------------------------------------
// The universe of AuditLog columns, taken from the schema itself.
//
// `Prisma.AuditLogScalarFieldEnum` is the authoritative column list: it holds
// every stored field including enum-typed ones, which the DMMF reports with
// `kind: "enum"` rather than `"scalar"`. Filtering the DMMF on `kind ===
// "scalar"` would therefore fail OPEN on an enum column, so the enum is the
// universe and the DMMF supplies only each column's declared type.
// --------------------------------------------------------------------------

const SCHEMA_COLUMNS = Object.keys(Prisma.AuditLogScalarFieldEnum);

type DmmfField = { name: string; kind: string; type: string };

const AUDIT_LOG_DMMF_FIELDS = (
  Prisma.dmmf.datamodel.models as unknown as {
    name: string;
    fields: DmmfField[];
  }[]
).find((model) => model.name === "AuditLog")?.fields;

const ARCHIVED_COLUMNS = Object.keys(AUDIT_ARCHIVE_COLUMNS);
const EXCLUDED_COLUMNS: Record<string, string> = AUDIT_ARCHIVE_EXCLUDED_COLUMNS;

/**
 * Pure coverage diff, so the fixture proofs below can drive it with a schema
 * that does not exist yet (a column added tomorrow) without touching the real
 * manifest.
 */
function diffArchiveColumnCoverage(
  schemaColumns: readonly string[],
  archivedColumns: readonly string[],
  excludedColumns: Readonly<Record<string, string>>
) {
  const archived = new Set(archivedColumns);
  const excludedNames = Object.keys(excludedColumns);
  const excluded = new Set(excludedNames);
  const schema = new Set(schemaColumns);

  return {
    /** In the model, but neither archived nor deliberately excluded. */
    missing: schemaColumns.filter(
      (column) => !archived.has(column) && !excluded.has(column)
    ),
    /** Archived, but no longer a column of the model. */
    extra: archivedColumns.filter((column) => !schema.has(column)),
    /** Excluded, but no longer a column of the model. */
    staleExclusions: excludedNames.filter((column) => !schema.has(column)),
    /** Claimed by both lists — the contract would be ambiguous. */
    contradictory: excludedNames.filter((column) => archived.has(column)),
  };
}

/** Exclusions must name a real column and carry a real explanation. */
function invalidExclusions(
  excludedColumns: Readonly<Record<string, string>>
): string[] {
  return Object.entries(excludedColumns)
    .filter(([, reason]) => typeof reason !== "string" || reason.trim().length < 20)
    .map(([column]) => column);
}

describe("audit archive column coverage (#2290)", () => {
  it("archives every AuditLog column the schema declares", () => {
    const { missing, extra, staleExclusions, contradictory } =
      diffArchiveColumnCoverage(
        SCHEMA_COLUMNS,
        ARCHIVED_COLUMNS,
        EXCLUDED_COLUMNS
      );

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(staleExclusions).toEqual([]);
    expect(contradictory).toEqual([]);
  });

  it("cross-checks the column universe against the runtime DMMF", () => {
    expect(AUDIT_LOG_DMMF_FIELDS).toBeDefined();
    const storedFields = (AUDIT_LOG_DMMF_FIELDS ?? [])
      .filter((field) => field.kind !== "object")
      .map((field) => field.name);

    // Both views of the schema must agree, or the enum-based universe above is
    // no longer trustworthy.
    expect([...storedFields].sort()).toEqual([...SCHEMA_COLUMNS].sort());
    expect(SCHEMA_COLUMNS.length).toBeGreaterThan(0);
  });

  it("FAILS when the model grows a column nobody archived (fixture proof)", () => {
    const tomorrow = [...SCHEMA_COLUMNS, "hypotheticalColumn__2290"];
    const { missing } = diffArchiveColumnCoverage(
      tomorrow,
      ARCHIVED_COLUMNS,
      EXCLUDED_COLUMNS
    );

    expect(missing).toEqual(["hypotheticalColumn__2290"]);
  });

  it("FAILS when a column is dropped from the archive manifest (fixture proof)", () => {
    const withoutMetadata = ARCHIVED_COLUMNS.filter(
      (column) => column !== "metadata"
    );
    const { missing } = diffArchiveColumnCoverage(
      SCHEMA_COLUMNS,
      withoutMetadata,
      EXCLUDED_COLUMNS
    );

    expect(missing).toEqual(["metadata"]);
  });

  it("FAILS when the manifest keeps a column the model no longer has (fixture proof)", () => {
    const { extra } = diffArchiveColumnCoverage(
      SCHEMA_COLUMNS,
      [...ARCHIVED_COLUMNS, "legacyNotes"],
      EXCLUDED_COLUMNS
    );

    expect(extra).toEqual(["legacyNotes"]);
  });

  it("accepts a deliberate exclusion but still refuses an unexplained one", () => {
    const reasoned = {
      hypotheticalColumn__2290:
        "Re-derived from requestId on read; never needed in the archive.",
    };
    const tomorrow = [...SCHEMA_COLUMNS, "hypotheticalColumn__2290"];

    expect(
      diffArchiveColumnCoverage(tomorrow, ARCHIVED_COLUMNS, reasoned).missing
    ).toEqual([]);
    expect(invalidExclusions(reasoned)).toEqual([]);
    expect(invalidExclusions({ hypotheticalColumn__2290: "unused" })).toEqual([
      "hypotheticalColumn__2290",
    ]);
  });

  it("requires every real exclusion to carry a reason", () => {
    // Vacuous today by design — nothing is excluded, all 22 columns are
    // archived. The fixture proof above is what keeps this rule honest.
    expect(invalidExclusions(EXCLUDED_COLUMNS)).toEqual([]);
  });
});

describe("audit archive column types (#2290)", () => {
  /**
   * Archive SQL types allowed for each declared Prisma type. Deliberately wider
   * than the columns that exist today: a future Decimal or BigInt column must
   * land on a numeric archive type rather than silently stringifying into TEXT.
   */
  const ALLOWED_ARCHIVE_TYPES: Record<string, readonly string[]> = {
    String: ["TEXT"],
    Boolean: ["BOOLEAN"],
    DateTime: ["TIMESTAMP(3)", "TIMESTAMPTZ(3)"],
    Json: ["JSONB", "JSON"],
    Int: ["INTEGER", "BIGINT"],
    BigInt: ["BIGINT"],
    Float: ["DOUBLE PRECISION"],
    Decimal: ["DECIMAL(65,30)", "NUMERIC(65,30)"],
    Bytes: ["BYTEA"],
    // Enum columns are stored as their string value; the archive is a plain
    // table with no Postgres enum types of its own.
    __enum: ["TEXT"],
  };

  function declaredTypeKey(field: DmmfField): string {
    return field.kind === "enum" ? "__enum" : field.type;
  }

  it("gives every archived column an archive type that matches the schema", () => {
    const fields = AUDIT_LOG_DMMF_FIELDS ?? [];
    const mismatches: string[] = [];

    for (const column of ARCHIVED_COLUMNS) {
      const field = fields.find((candidate) => candidate.name === column);
      if (!field) {
        mismatches.push(`${column}: not present in the DMMF`);
        continue;
      }
      const key = declaredTypeKey(field);
      const allowed = ALLOWED_ARCHIVE_TYPES[key];
      if (!allowed) {
        // Fail closed: an unmapped Prisma type is a reason to update this map,
        // never a reason to pass.
        mismatches.push(`${column}: no archive type mapped for ${key}`);
        continue;
      }
      const ddl =
        AUDIT_ARCHIVE_COLUMNS[column as keyof typeof AUDIT_ARCHIVE_COLUMNS].ddl;
      const matches = allowed.some(
        (type) => ddl === type || ddl.startsWith(`${type} `)
      );
      if (!matches) {
        mismatches.push(`${column}: ${ddl} is not one of ${allowed.join(", ")}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("only casts a bound parameter with a simple type cast", () => {
    for (const [column, spec] of Object.entries(AUDIT_ARCHIVE_COLUMNS)) {
      if (spec.cast === undefined) continue;
      expect(spec.cast, `${column} cast`).toMatch(/^::[a-z][a-z0-9_]*$/);
    }
    // The one cast that exists today: JSON is bound as text and cast on the way in.
    expect(AUDIT_ARCHIVE_COLUMNS.metadata.cast).toBe("::jsonb");
  });
});

describe("audit archive writer serialises every column (#2290)", () => {
  function mockDb() {
    return {
      auditLog: {
        updateMany: mocks.updateMany,
        deleteMany: mocks.deleteMany,
        findMany: mocks.findMany,
      },
    };
  }

  function mockArchiveDb() {
    return {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    };
  }

  const NOW = new Date("2026-05-10T00:00:00.000Z");

  function archiveRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "audit-1",
      action: "admin.member.view",
      memberId: "admin-1",
      targetId: "member-1",
      details: "Viewed member",
      ipAddress: "203.0.113.10",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      actorMemberId: "admin-1",
      subjectMemberId: "member-1",
      entityType: "Member",
      entityId: "member-1",
      category: "admin",
      severity: "info",
      outcome: "success",
      summary: "Viewed member profile",
      metadata: { changedFields: ["email"], attempt: 2, ok: true },
      requestId: "req-1",
      userAgent: "Vitest",
      retentionClass: "sensitive_access",
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
      archivedAt: null,
      incidentPreserved: false,
      ...overrides,
    };
  }

  async function runArchive(rows: Record<string, unknown>[]) {
    const archiveDb = mockArchiveDb();
    mocks.findMany.mockResolvedValue(rows);
    mocks.deleteMany.mockResolvedValue({ count: rows.length });
    await archiveEligibleAuditLogs(mockDb() as never, archiveDb, NOW, 10);
    return archiveDb;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.deleteMany.mockResolvedValue({ count: 0 });
    mocks.findMany.mockResolvedValue([]);
  });

  it("selects every archived column and nothing else", async () => {
    await runArchive([archiveRow()]);

    const select = mocks.findMany.mock.calls[0][0].select as Record<
      string,
      true
    >;
    expect(Object.keys(select)).toEqual(ARCHIVED_COLUMNS);
    expect(Object.values(select).every((value) => value === true)).toBe(true);
  });

  it("creates the archive table with one definition per archived column", async () => {
    const archiveDb = await runArchive([archiveRow()]);

    const createTable = archiveDb.$executeRawUnsafe.mock.calls[0][0] as string;
    expect(createTable).toContain('CREATE TABLE IF NOT EXISTS "AuditLogArchive"');

    const declared = [...createTable.matchAll(/"([A-Za-z0-9_]+)"\s+[A-Z]/g)]
      .map((match) => match[1])
      .filter((name) => name !== "AuditLogArchive");
    expect(declared).toEqual(ARCHIVED_COLUMNS);

    // Spot-check that the generated definitions still carry their constraints.
    expect(createTable).toContain('"id" TEXT PRIMARY KEY');
    expect(createTable).toContain('"createdAt" TIMESTAMP(3) NOT NULL');
    expect(createTable).toContain('"metadata" JSONB');
    expect(createTable).toContain(
      '"incidentPreserved" BOOLEAN NOT NULL DEFAULT false'
    );
  });

  it("inserts every archived column, in manifest order, with one bound value each", async () => {
    const archiveDb = await runArchive([archiveRow()]);

    const insert = archiveDb.$executeRaw.mock.calls[0][0] as {
      strings: string[];
      values: unknown[];
    };
    const sql = insert.strings.join("?");

    expect(sql).toContain('INSERT INTO "AuditLogArchive"');
    expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');

    const inserted = [...sql.matchAll(/"([A-Za-z0-9_]+)"/g)]
      .map((match) => match[1])
      .filter((name) => name !== "AuditLogArchive" && name !== "id")
      .filter((name, index, all) => all.indexOf(name) === index);
    // "id" is stripped above because it also appears in the ON CONFLICT clause.
    expect(["id", ...inserted]).toEqual(ARCHIVED_COLUMNS);

    // One bound parameter per archived column: nothing silently inlined,
    // nothing silently dropped.
    expect(insert.values).toHaveLength(ARCHIVED_COLUMNS.length);
  });

  it("keeps type fidelity for dates, booleans, JSON and nulls", async () => {
    const archiveDb = await runArchive([
      archiveRow({ targetId: null, expiresAt: null }),
    ]);

    const insert = archiveDb.$executeRaw.mock.calls[0][0] as {
      strings: string[];
      values: unknown[];
    };
    const valueOf = (column: string) =>
      insert.values[ARCHIVED_COLUMNS.indexOf(column)];

    // DateTime stays a Date instance — the driver, not a string conversion here,
    // decides the wire format.
    expect(valueOf("createdAt")).toBeInstanceOf(Date);
    expect(valueOf("createdAt")).toEqual(new Date("2024-01-01T00:00:00.000Z"));
    // archivedAt is stamped with the job clock, not copied from the source row.
    expect(valueOf("archivedAt")).toEqual(NOW);
    // Boolean stays boolean.
    expect(valueOf("incidentPreserved")).toBe(false);
    // Null stays null for both a nullable string and a nullable timestamp.
    expect(valueOf("targetId")).toBeNull();
    expect(valueOf("expiresAt")).toBeNull();
    // Json is bound as a JSON string and cast with ::jsonb, so nested types
    // survive the round trip.
    const metadata = valueOf("metadata");
    expect(typeof metadata).toBe("string");
    expect(JSON.parse(metadata as string)).toEqual({
      changedFields: ["email"],
      attempt: 2,
      ok: true,
    });
    expect(insert.strings.join("?")).toContain("::jsonb");
  });

  it("still drops raw request data unless the row is incident-preserved", async () => {
    const archiveDb = await runArchive([
      archiveRow({ id: "audit-1" }),
      archiveRow({
        id: "audit-2",
        incidentPreserved: true,
        ipAddress: "198.51.100.5",
        userAgent: "Incident UA",
      }),
    ]);

    const valueOf = (call: number, column: string) =>
      (archiveDb.$executeRaw.mock.calls[call][0] as { values: unknown[] })
        .values[ARCHIVED_COLUMNS.indexOf(column)];

    expect(valueOf(0, "ipAddress")).toBeNull();
    expect(valueOf(0, "userAgent")).toBeNull();
    expect(valueOf(1, "ipAddress")).toBe("198.51.100.5");
    expect(valueOf(1, "userAgent")).toBe("Incident UA");
  });
});
