import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { starterSiteContent } from "../../../prisma/starter-site-content";

/**
 * #2490: 20260702124500_add_site_content backfilled the public footer's
 * affiliations column with markup naming Federated Mountain Clubs and the
 * Ruapehu Mountain Clubs Association — real bodies belonging to the club this
 * codebase used to *be*, published on every page of every install built from
 * this repository. An applied migration cannot be edited, so
 * 20260802140000_clear_starter_footer_affiliations clears that value from any
 * database still holding it.
 *
 * These tests police the property that makes the cleanup safe: it is scoped to
 * the exact planted VALUE, so a club that has written its own affiliations —
 * or merely deleted the offending line — is never touched. They read both SQL
 * files rather than restating the markup, so the two can never drift apart
 * silently.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT (#2418). Everything below is a
 * STRING comparison of two migration files. It proves the cleanup quotes the
 * planted markup byte for byte and that the statement is shaped the way the
 * safety argument claims. It cannot prove PostgreSQL executes it that way, and
 * a neutered statement can keep every assertion here green. That half is
 * `prisma/migration-verification/20260802140000_clear_starter_footer_affiliations.ts`,
 * which runs this migration for real against a database holding a club's rows
 * and then re-runs it against deliberately broken copies of itself.
 */
const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");
const BACKFILL_MIGRATION = "20260702124500_add_site_content";
const CLEANUP_MIGRATION = "20260802140000_clear_starter_footer_affiliations";

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

/** SQL with every "--" comment line removed, so assertions read statements. */
function statementsOnly(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const backfillSql = migrationSql(BACKFILL_MIGRATION);
const cleanupSql = migrationSql(CLEANUP_MIGRATION);
const cleanupStatements = statementsOnly(cleanupSql);

// The exact value the backfill planted, read out of its $cms$-quoted tuple.
const plantedAffiliationsHtml =
  backfillSql.match(
    /\('site-content-footer-affiliations',\s*'FOOTER_AFFILIATIONS',\s*\$cms\$([\s\S]*?)\$cms\$/,
  )?.[1] ?? "";

describe("starter footer affiliations cleanup migration (#2490)", () => {
  it("reads the planted value the cleanup has to match", () => {
    expect(plantedAffiliationsHtml).toContain(
      "Ruapehu Mountain Clubs Association (RMCA)",
    );
    expect(plantedAffiliationsHtml).toContain("Federated Mountain Clubs (FMC)");
  });

  it("matches the planted markup byte for byte", () => {
    expect(cleanupStatements).toContain(plantedAffiliationsHtml);
    // Anchored inside the WHERE, not merely mentioned somewhere in the file.
    expect(cleanupStatements).toContain(
      `AND "contentHtml" = $cms$${plantedAffiliationsHtml}$cms$;`,
    );
  });

  it("is value-scoped, so a customised affiliations column is untouched", () => {
    // The predicate that does the work: without the contentHtml equality this
    // would blank every install's affiliations, edited or not.
    expect(cleanupStatements).toMatch(/WHERE\s+"key" = 'FOOTER_AFFILIATIONS'/);
    expect(cleanupStatements).toMatch(/AND\s+"contentHtml" = \$cms\$/);

    // A club that only deleted the RMCA line no longer byte-matches, so it is
    // outside the WHERE — demonstrated on the values themselves.
    const withoutRmcaLine = plantedAffiliationsHtml.replace(
      /<li><a href="https:\/\/rmca\.org\.nz\/"[\s\S]*?<\/li>/,
      "",
    );
    expect(withoutRmcaLine).not.toBe(plantedAffiliationsHtml);
    expect(withoutRmcaLine).not.toContain("RMCA");
    expect(cleanupStatements).not.toContain(
      `AND "contentHtml" = $cms$${withoutRmcaLine}$cms$`,
    );
  });

  it("clears the column instead of deleting the row, and touches nothing else", () => {
    expect(cleanupStatements).toMatch(/UPDATE "SiteContent"/);
    expect(cleanupStatements).toMatch(/SET "contentHtml" = ''/);
    expect(cleanupStatements).not.toMatch(/\bDELETE\b/i);
    // Exactly one statement.
    expect(cleanupStatements.match(/;/g) ?? []).toHaveLength(1);
    // Pure DML: no schema change for an old app colour's queries to miss.
    expect(cleanupStatements).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE)\b/i);
  });

  it("is idempotent: the value it writes is not the value it matches", () => {
    expect(plantedAffiliationsHtml).not.toBe("");
    expect(cleanupStatements).toMatch(/SET "contentHtml" = ''/);
  });

  it("writes no session clock into the payload (#1627/#1656)", () => {
    expect(cleanupStatements).not.toMatch(/CURRENT_TIMESTAMP/i);
    expect(cleanupStatements).not.toMatch(/\bnow\s*\(/i);
    // "updatedAt" is deliberately left alone: a system repair, not an edit.
    expect(cleanupStatements).not.toContain('"updatedAt"');
  });

  it("sorts after the backfill it corrects, so migrate deploy applies it second", () => {
    expect(CLEANUP_MIGRATION > BACKFILL_MIGRATION).toBe(true);
  });

  it("leaves the seed with nothing to re-plant", () => {
    const affiliations = starterSiteContent.find(
      (section) => section.key === "FOOTER_AFFILIATIONS",
    );
    expect(affiliations).toBeDefined();
    // A fresh install seeds an empty column; the cleanup handles the databases
    // the backfill already stamped. If the starter ever gains content again,
    // the two surfaces must be reconciled deliberately rather than by drift.
    expect(affiliations!.contentHtml).toBe("");
  });
});
