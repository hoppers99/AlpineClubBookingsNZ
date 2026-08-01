import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  archiveColumnCast,
  archiveColumnDdl,
  archiveEligibleAuditLogs,
  archiveIdentifier,
  runAuditLogRetentionJob,
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

// --------------------------------------------------------------------------
// Nullability and list-ness come from `prisma/schema.prisma`, not the DMMF.
//
// The generated runtime DMMF is trimmed to `{ name, kind, type }` — it carries
// no `isRequired` and no `isList` (verified against the generated client), so
// the schema file is the only runtime source for "is this column nullable?".
// The migration-drift CI gate keeps the schema and the database in step, so it
// is authoritative. `parsedSchemaColumnNames` below is cross-checked against
// `Prisma.AuditLogScalarFieldEnum`, so a parser that silently skipped or
// mangled a line fails the suite instead of failing open.
// --------------------------------------------------------------------------

const SCHEMA_TEXT = readFileSync(
  join(process.cwd(), "prisma", "schema.prisma"),
  "utf8"
);

type ModelField = {
  name: string;
  type: string;
  isRequired: boolean;
  isList: boolean;
};

function parseAuditLogModelFields(schemaText: string): ModelField[] {
  const block = schemaText.match(/\nmodel AuditLog \{\n([\s\S]*?)\n\}/);
  if (!block) {
    return [];
  }

  const fields: ModelField[] = [];
  for (const line of block[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) {
      continue;
    }
    const match = trimmed.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
    if (!match) {
      continue;
    }
    fields.push({
      name: match[1],
      type: match[2],
      isList: Boolean(match[3]),
      isRequired: !match[4],
    });
  }
  return fields;
}

const AUDIT_LOG_MODEL_FIELDS = parseAuditLogModelFields(SCHEMA_TEXT);

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

// --------------------------------------------------------------------------
// Archive SQL types allowed for each declared Prisma type. Deliberately wider
// than the columns that exist today: a future Decimal or BigInt column must
// land on a numeric archive type rather than silently stringifying into TEXT.
// --------------------------------------------------------------------------
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

/**
 * Columns whose archive DDL deliberately disagrees with the model's
 * nullability, each with the reason. Everything else must match exactly.
 */
const ARCHIVE_NOT_NULL_OVERRIDES: Record<string, string> = {
  archivedAt:
    "The archive copy always records when it was written, so the archive column is NOT NULL even though AuditLog.archivedAt is nullable.",
};

/** What the guard needs to know about one column, from both schema views. */
type ArchiveColumnFacts = {
  name: string;
  /** Prisma declared type, or `__enum` for an enum-typed column. */
  typeKey: string;
  isRequired: boolean;
  isList: boolean;
};

function declaredTypeKey(field: DmmfField): string {
  return field.kind === "enum" ? "__enum" : field.type;
}

/** A PRIMARY KEY column is NOT NULL in PostgreSQL without saying so. */
function ddlDeclaresNotNull(ddl: string): boolean {
  return /\bNOT NULL\b/.test(ddl) || /\bPRIMARY KEY\b/.test(ddl);
}

/**
 * Pure type/nullability diff, so the fixture proofs below can drive it with
 * columns that do not exist yet without touching the real manifest.
 */
function diffArchiveColumnTypes(
  archivedColumns: readonly string[],
  manifest: Readonly<Record<string, { ddl: string }>>,
  columnFacts: readonly ArchiveColumnFacts[],
  notNullOverrides: Readonly<Record<string, string>>
): string[] {
  const mismatches: string[] = [];

  for (const column of archivedColumns) {
    const facts = columnFacts.find((candidate) => candidate.name === column);
    if (!facts) {
      mismatches.push(`${column}: not present in the schema`);
      continue;
    }

    const ddl = manifest[column].ddl;

    if (facts.isList) {
      // A `Type[]` column would archive as the PostgreSQL array literal `{a,b}`
      // in a scalar archive column. Never fall through to the type family.
      mismatches.push(
        `${column}: ${facts.typeKey}[] is a list column with no archive mapping`
      );
      continue;
    }

    const allowed = ALLOWED_ARCHIVE_TYPES[facts.typeKey];
    if (!allowed) {
      // Fail closed: an unmapped Prisma type is a reason to update this map,
      // never a reason to pass.
      mismatches.push(`${column}: no archive type mapped for ${facts.typeKey}`);
      continue;
    }
    if (!allowed.some((type) => ddl === type || ddl.startsWith(`${type} `))) {
      mismatches.push(`${column}: ${ddl} is not one of ${allowed.join(", ")}`);
      continue;
    }

    // Nullability, the half that a copied DDL line gets wrong. A NOT NULL
    // archive column over a nullable model column does not fail CI on its own
    // — it fails in production, on the first row that holds a NULL, and then
    // every night after that, because the batch is ordered `createdAt asc` and
    // re-selects the same poison row for ever.
    const override = notNullOverrides[column];
    const notNull = ddlDeclaresNotNull(ddl);
    if (override !== undefined) {
      if (facts.isRequired) {
        mismatches.push(
          `${column}: listed as a deliberate NOT NULL override, but the model column is already required`
        );
      } else if (!notNull) {
        mismatches.push(
          `${column}: listed as a deliberate NOT NULL override, but the archive DDL is nullable`
        );
      } else if (override.trim().length < 20) {
        mismatches.push(
          `${column}: NOT NULL override needs a written reason, not "${override}"`
        );
      }
      continue;
    }
    if (notNull !== facts.isRequired) {
      mismatches.push(
        facts.isRequired
          ? `${column}: ${ddl} is nullable but the model column is required`
          : `${column}: ${ddl} is NOT NULL but the model column is nullable`
      );
    }
  }

  return mismatches;
}

const ARCHIVE_COLUMN_FACTS: ArchiveColumnFacts[] = AUDIT_LOG_MODEL_FIELDS.map(
  (field) => {
    const dmmfField = (AUDIT_LOG_DMMF_FIELDS ?? []).find(
      (candidate) => candidate.name === field.name
    );
    return {
      name: field.name,
      typeKey: dmmfField ? declaredTypeKey(dmmfField) : field.type,
      isRequired: field.isRequired,
      isList: field.isList,
    };
  }
);

describe("audit archive column types (#2290)", () => {
  it("parses the AuditLog model out of the schema without dropping a column", () => {
    // Keeps the nullability source honest: if this parser ever skips a line,
    // the guard below would silently stop checking that column.
    expect(AUDIT_LOG_MODEL_FIELDS.map((field) => field.name).sort()).toEqual(
      [...SCHEMA_COLUMNS].sort()
    );
    expect(AUDIT_LOG_MODEL_FIELDS.every((field) => field.type.length > 0)).toBe(
      true
    );
    // Sanity-check both polarities against the schema as written.
    const byName = new Map(
      AUDIT_LOG_MODEL_FIELDS.map((field) => [field.name, field])
    );
    expect(byName.get("action")?.isRequired).toBe(true);
    expect(byName.get("incidentPreserved")?.isRequired).toBe(true);
    expect(byName.get("memberId")?.isRequired).toBe(false);
    expect(byName.get("archivedAt")?.isRequired).toBe(false);
    expect(AUDIT_LOG_MODEL_FIELDS.some((field) => field.isList)).toBe(false);
  });

  it("gives every archived column an archive type and nullability that match the schema", () => {
    expect(
      diffArchiveColumnTypes(
        ARCHIVED_COLUMNS,
        AUDIT_ARCHIVE_COLUMNS,
        ARCHIVE_COLUMN_FACTS,
        ARCHIVE_NOT_NULL_OVERRIDES
      )
    ).toEqual([]);
  });

  it("FAILS on a NOT NULL archive column over a nullable model column (fixture proof)", () => {
    const facts: ArchiveColumnFacts[] = [
      { name: "noteRef", typeKey: "String", isRequired: false, isList: false },
    ];

    expect(
      diffArchiveColumnTypes(
        ["noteRef"],
        { noteRef: { ddl: "TEXT NOT NULL" } },
        facts,
        {}
      )
    ).toEqual(["noteRef: TEXT NOT NULL is NOT NULL but the model column is nullable"]);
    // The same column declared correctly passes.
    expect(
      diffArchiveColumnTypes(["noteRef"], { noteRef: { ddl: "TEXT" } }, facts, {})
    ).toEqual([]);
  });

  it("FAILS on a nullable archive column over a required model column (fixture proof)", () => {
    const facts: ArchiveColumnFacts[] = [
      { name: "lodgeId", typeKey: "String", isRequired: true, isList: false },
    ];

    expect(
      diffArchiveColumnTypes(["lodgeId"], { lodgeId: { ddl: "TEXT" } }, facts, {})
    ).toEqual(["lodgeId: TEXT is nullable but the model column is required"]);
    expect(
      diffArchiveColumnTypes(
        ["lodgeId"],
        { lodgeId: { ddl: "TEXT NOT NULL" } },
        facts,
        {}
      )
    ).toEqual([]);
    // PRIMARY KEY carries NOT NULL implicitly — that is how `id` passes.
    expect(
      diffArchiveColumnTypes(
        ["lodgeId"],
        { lodgeId: { ddl: "TEXT PRIMARY KEY" } },
        facts,
        {}
      )
    ).toEqual([]);
  });

  it("refuses a list column until someone maps it deliberately (fixture proof)", () => {
    const facts: ArchiveColumnFacts[] = [
      { name: "tags", typeKey: "String", isRequired: true, isList: true },
    ];

    expect(
      diffArchiveColumnTypes(["tags"], { tags: { ddl: "TEXT" } }, facts, {})
    ).toEqual(["tags: String[] is a list column with no archive mapping"]);
  });

  it("keeps the NOT NULL override list honest (fixture proof)", () => {
    const nullableField: ArchiveColumnFacts[] = [
      { name: "archivedAt", typeKey: "DateTime", isRequired: false, isList: false },
    ];
    const reason = ARCHIVE_NOT_NULL_OVERRIDES.archivedAt;

    // An override with no reason is not an override.
    expect(
      diffArchiveColumnTypes(
        ["archivedAt"],
        { archivedAt: { ddl: "TIMESTAMP(3) NOT NULL" } },
        nullableField,
        { archivedAt: "because" }
      )
    ).toEqual([
      'archivedAt: NOT NULL override needs a written reason, not "because"',
    ]);
    // An override that no longer overrides anything is reported, so the list
    // cannot rot into a blanket exemption.
    expect(
      diffArchiveColumnTypes(
        ["archivedAt"],
        { archivedAt: { ddl: "TIMESTAMP(3) NOT NULL" } },
        [{ ...nullableField[0], isRequired: true }],
        { archivedAt: reason }
      )
    ).toEqual([
      "archivedAt: listed as a deliberate NOT NULL override, but the model column is already required",
    ]);
    // And an override that forgot to actually declare NOT NULL is reported.
    expect(
      diffArchiveColumnTypes(
        ["archivedAt"],
        { archivedAt: { ddl: "TIMESTAMP(3)" } },
        nullableField,
        { archivedAt: reason }
      )
    ).toEqual([
      "archivedAt: listed as a deliberate NOT NULL override, but the archive DDL is nullable",
    ]);
  });

  it("only casts a bound parameter with a simple type cast", () => {
    // Validated with the production guard itself, not a re-typed copy of its
    // regex — a widened guard must fail here rather than pass a stale clone.
    for (const [column, spec] of Object.entries(AUDIT_ARCHIVE_COLUMNS)) {
      if (spec.cast === undefined) continue;
      expect(archiveColumnCast(column, spec.cast), `${column} cast`).toBe(
        spec.cast
      );
    }
    // The one cast that exists today: JSON is bound as text and cast on the way in.
    expect(AUDIT_ARCHIVE_COLUMNS.metadata.cast).toBe("::jsonb");
  });
});

// --------------------------------------------------------------------------
// The SQL guards are the only compensating control for generating the archive
// DDL and INSERT instead of writing them literally, so they get their own
// rejection coverage. Without it, a readability refactor that deletes a guard
// leaves the whole suite green.
// --------------------------------------------------------------------------
describe("audit archive SQL guards (#2290)", () => {
  it("accepts every entry the real manifest declares", () => {
    for (const [column, spec] of Object.entries(AUDIT_ARCHIVE_COLUMNS)) {
      expect(archiveIdentifier(column)).toBe(`"${column}"`);
      expect(archiveColumnDdl(column, spec.ddl)).toBe(spec.ddl);
    }
  });

  it("rejects a column identifier that could break out of its quotes", () => {
    for (const hostile of [
      'id"; DROP TABLE "AuditLogArchive',
      'x" ,"y',
      "id, 1",
      "id;",
      "1stColumn",
      "_id",
      "",
      "id\n",
      "id ",
    ]) {
      expect(() => archiveIdentifier(hostile), hostile).toThrow(
        /unsafe column identifier/
      );
    }
  });

  it("rejects a column definition that could smuggle in a second column or statement", () => {
    for (const hostile of [
      "TEXT, y TEXT",
      "TEXT; DROP TABLE x",
      "TEXT DEFAULT 'x'",
      "TEXT --",
      "TEXT/*",
      "TEXT\nCHECK (1=1)",
      "TEXT REFERENCES x(y) ON DELETE CASCADE, z TEXT",
    ]) {
      expect(() => archiveColumnDdl("newColumn", hostile), hostile).toThrow(
        /unsafe column definition for "newColumn"/
      );
    }
    expect(archiveColumnDdl("createdAt", "TIMESTAMP(3) NOT NULL")).toBe(
      "TIMESTAMP(3) NOT NULL"
    );
  });

  it("rejects a cast that could close the VALUES tuple", () => {
    for (const hostile of [
      "::text) ,(1",
      "::jsonb, 1",
      "::text;",
      "::TEXT",
      "::timestamptz(3)",
      "text",
      "::",
      "",
    ]) {
      expect(() => archiveColumnCast("metadata", hostile), hostile).toThrow(
        /unsafe column cast for "metadata"/
      );
    }
    expect(archiveColumnCast("metadata", "::jsonb")).toBe("::jsonb");
  });

  it("anchors every guard at both ends", () => {
    // A guard that only tests for a *containing* match would let each of these
    // through, and each one reaches raw SQL.
    expect(() => archiveIdentifier('memberId" , "injected')).toThrow();
    expect(() => archiveIdentifier("\nmemberId")).toThrow();
    expect(() => archiveColumnDdl("x", "TEXT, injected TEXT")).toThrow();
    expect(() => archiveColumnDdl("x", "\nTEXT")).toThrow();
    expect(() => archiveColumnCast("x", "::jsonb) , (2")).toThrow();
    expect(() => archiveColumnCast("x", "\n::jsonb")).toThrow();
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

  // ------------------------------------------------------------------------
  // A drifted archive schema stops the WHOLE retention job, pruning included.
  // That is deliberate — `pruneExpiredAuditLogs` deletes on `expiresAt` without
  // checking `archivedAt`, so pruning while archiving is stalled would delete
  // rows the archive never received. The cost is over-retention, which the
  // operator has to be told about, so the error names both halves.
  // ------------------------------------------------------------------------
  it("stops the whole retention job when archiving fails, and says both halves", async () => {
    const archiveDb = mockArchiveDb();
    const columnMissing = new Error(
      'column "noteRef" of relation "AuditLogArchive" does not exist'
    );
    archiveDb.$executeRaw.mockRejectedValue(columnMissing);
    mocks.findMany.mockResolvedValue([archiveRow()]);

    let rejection: unknown;
    try {
      await runAuditLogRetentionJob({
        db: mockDb() as never,
        archiveDb,
        now: NOW,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const failure = rejection as Error;
    expect(failure.message).toContain("nothing was archived");
    expect(failure.message).toContain("no expired audit rows were pruned");
    expect(failure.message).toContain("docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md");
    // The original PostgreSQL error is preserved for diagnosis.
    expect(failure.message).toContain('column "noteRef"');
    expect(failure.cause).toBe(columnMissing);

    // Nothing was deleted: not the archived rows, and not the expired ones.
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    // The archive prune never issued its DELETE either — the failed INSERT is
    // the only statement the archive database saw.
    expect(archiveDb.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
