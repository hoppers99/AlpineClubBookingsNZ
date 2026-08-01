import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { starterSiteContent } from "../../../prisma/starter-site-content";

// Production deploys run Prisma migrations but not the seed, so the starter
// SiteContent rows (public footer columns) are backfilled by the migration
// below. These tests keep that SQL in sync with starterSiteContent: if a
// starter section is added or edited without a matching backfill migration,
// deploy-only environments would render a stale or missing footer column.
const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");
const BACKFILL_MIGRATION = "20260702124500_add_site_content";
const MIGRATION_PATH = join(MIGRATIONS_DIR, BACKFILL_MIGRATION, "migration.sql");

/**
 * The exact contentHtml the backfill INSERT plants for one starter row id,
 * read out of its $cms$-quoted VALUES tuple. Read rather than retyped so the
 * assertions below compare against the real bytes in the applied migration.
 */
function plantedValueFor(sql: string, id: string): string {
  const match = sql.match(
    new RegExp(`\\('${id}',\\s*'FOOTER_[A-Z_]+',\\s*\\$cms\\$([\\s\\S]*?)\\$cms\\$`),
  );
  return match ? match[1] : "";
}

describe("starter site content backfill migration", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("inserts exactly the starter section ids", () => {
    const insertedIds = [...sql.matchAll(/'(site-content-[a-z0-9-]+)'/g)].map(
      (match) => match[1],
    );
    const expectedIds = starterSiteContent.map((section) => section.id);
    expect(insertedIds.sort()).toEqual([...expectedIds].sort());
  });

  it("inserts exactly the starter section keys", () => {
    const insertedKeys = [...sql.matchAll(/'(FOOTER_[A-Z_]+)'/g)].map(
      (match) => match[1],
    );
    const expectedKeys = starterSiteContent.map((section) => section.key);
    // Each key appears once in the enum definition and once in the insert.
    expect([...new Set(insertedKeys)].sort()).toEqual(
      [...expectedKeys].sort(),
    );
  });

  it("matches every current non-empty starter contentHtml value so edited starters force a new backfill", () => {
    const nonEmpty = starterSiteContent.filter(
      (section) => section.contentHtml !== "",
    );
    // Guard the guard: if every starter section were emptied this loop would
    // pass vacuously, and the empty ones are covered by the test below instead.
    expect(nonEmpty.length).toBeGreaterThan(0);

    for (const section of nonEmpty) {
      expect(
        sql.includes(section.contentHtml),
        `expected backfill SQL to contain the ${section.key} contentHtml`,
      ).toBe(true);
    }
  });

  // #2490: a starter section that is deliberately EMPTY cannot be checked with
  // sql.includes(""), which is true of every string. The backfill still planted
  // a real value on every database that ran it, so the invariant for an emptied
  // starter is the opposite one: some LATER migration must clear exactly that
  // planted value, or deploy-only environments would keep rendering content the
  // seed no longer ships.
  it("routes every emptied starter section through a later clearing migration", () => {
    const emptied = starterSiteContent.filter(
      (section) => section.contentHtml === "",
    );
    if (emptied.length === 0) {
      return;
    }

    const laterSql = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name > BACKFILL_MIGRATION)
      .map((name) =>
        readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"),
      )
      .join("\n");

    for (const section of emptied) {
      const planted = plantedValueFor(sql, section.id);
      expect(
        planted.length,
        `expected the backfill SQL to plant a value for ${section.key}`,
      ).toBeGreaterThan(0);
      expect(
        laterSql.includes(planted),
        `starter ${section.key} is empty, so a migration after ${BACKFILL_MIGRATION} must clear the value the backfill planted`,
      ).toBe(true);
    }
  });

  it("creates the enum and table used by the schema", () => {
    expect(sql).toContain(
      `CREATE TYPE "SiteContentKey" AS ENUM ('FOOTER_BLURB', 'FOOTER_QUICK_LINKS', 'FOOTER_AFFILIATIONS')`,
    );
    expect(sql).toContain(`CREATE TABLE "SiteContent"`);
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "SiteContent_key_key" ON "SiteContent"("key")`,
    );
    expect(sql).toContain(
      `CREATE INDEX "SiteContent_updatedByMemberId_idx" ON "SiteContent"("updatedByMemberId")`,
    );
  });

  it("never overwrites existing rows", () => {
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).not.toMatch(/DO UPDATE/i);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE)\b/);
  });
});
