import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { starterSiteContent } from "../../../prisma/starter-site-content";

// Production deploys run Prisma migrations but not the seed, so the starter
// SiteContent rows (public footer columns) are backfilled by the migration
// below. These tests keep that SQL in sync with starterSiteContent: if a
// starter section is added or edited without a matching backfill migration,
// deploy-only environments would render a stale or missing footer column.
const MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260702124500_add_site_content",
  "migration.sql",
);

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

  it("matches every current starter contentHtml value so edited starters force a new backfill", () => {
    for (const section of starterSiteContent) {
      expect(
        sql.includes(section.contentHtml),
        `expected backfill SQL to contain the ${section.key} contentHtml`,
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
