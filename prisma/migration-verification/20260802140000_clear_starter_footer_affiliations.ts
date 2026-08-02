import { readFileSync } from "node:fs";
import path from "node:path";
import type { DataMigrationVerification } from "./types";

/**
 * #2490 — the starter footer affiliations that the historical migration chain
 * stamps onto every install.
 *
 * `20260702124500_add_site_content` backfilled the public footer's affiliations
 * column with markup naming Federated Mountain Clubs and the Ruapehu Mountain
 * Clubs Association — real bodies belonging to the club this codebase used to
 * *be*, published on every page of every install built from this repository.
 *
 * As with the lodge address (#2484), the safety argument is that the cleanup is
 * VALUE-scoped: it matches the planted markup byte for byte, so a club that
 * wrote its own affiliations — or merely deleted the offending line — keeps
 * exactly what it saved. `site-content-affiliations-cleanup.test.ts` proves the
 * two SQL files quote the same bytes; only executing them proves PostgreSQL
 * agrees, and this markup is dollar-quoted HTML full of characters that a
 * hand-rolled comparison can get wrong.
 *
 * The planted value is READ OUT OF THE BACKFILL MIGRATION rather than restated
 * here, for the same reason: a fixture that carried its own copy would keep
 * passing after the two drifted apart.
 */
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");
const BACKFILL_MIGRATION = "20260702124500_add_site_content";

const backfillSql = readFileSync(
  path.join(MIGRATIONS_DIR, BACKFILL_MIGRATION, "migration.sql"),
  "utf8",
);

/** The exact markup the backfill planted, lifted from its $cms$-quoted tuple. */
const plantedAffiliationsHtml =
  backfillSql.match(
    /\('site-content-footer-affiliations',\s*'FOOTER_AFFILIATIONS',\s*\$cms\$([\s\S]*?)\$cms\$/,
  )?.[1] ?? "";

if (!plantedAffiliationsHtml.includes("Ruapehu Mountain Clubs Association")) {
  // A silent "" here would make every assertion below vacuous, so fail loudly
  // at import time instead of testing nothing.
  throw new Error(
    `${BACKFILL_MIGRATION}: could not read the planted FOOTER_AFFILIATIONS markup — the cleanup fixture cannot verify anything without it.`,
  );
}

/** A club's own affiliations: same shape, none of this project's geography. */
const clubAuthoredHtml =
  "<h3>Affiliations</h3><ul><li><a href=\"https://example.org/\">Example Alpine Federation</a></li></ul>";

const verification: DataMigrationVerification = {
  migration: "20260802140000_clear_starter_footer_affiliations",
  intent:
    "Empty the FOOTER_AFFILIATIONS row on any install still holding the markup this project planted, keeping the row itself, and leave affiliations a club edited exactly as saved.",
  idempotentReRun: true,
  cases: [
    {
      name: "a fresh install, carrying the affiliations the migration chain planted",
      seed: "",
      expectations: [
        {
          claim:
            "the planted markup is gone and the row is CLEARED, not deleted — a missing row would make the admin editor fall back to a starter default",
          sql: `SELECT "id", "contentHtml" FROM "SiteContent"
                 WHERE "key" = 'FOOTER_AFFILIATIONS'`,
          rows: [{ id: "site-content-footer-affiliations", contentHtml: "" }],
        },
        {
          claim: "the other two footer columns are untouched",
          sql: `SELECT count(*)::int AS "nonEmpty" FROM "SiteContent"
                 WHERE "key" <> 'FOOTER_AFFILIATIONS' AND "contentHtml" <> ''`,
          rows: [{ nonEmpty: 2 }],
        },
      ],
    },
    {
      name: "a club that wrote its own affiliations",
      seed: `
        UPDATE "SiteContent"
        SET "contentHtml" = ${dollarQuoted(clubAuthoredHtml)}
        WHERE "key" = 'FOOTER_AFFILIATIONS';
      `,
      expectations: [
        {
          claim: "a club's own affiliations survive byte for byte",
          sql: `SELECT "contentHtml" FROM "SiteContent"
                 WHERE "key" = 'FOOTER_AFFILIATIONS'`,
          rows: [{ contentHtml: clubAuthoredHtml }],
        },
      ],
    },
    {
      name: "a club that deleted only the offending RMCA line",
      seed: `
        UPDATE "SiteContent"
        SET "contentHtml" = ${dollarQuoted(withoutRmcaLine(plantedAffiliationsHtml))}
        WHERE "key" = 'FOOTER_AFFILIATIONS';
      `,
      expectations: [
        {
          claim:
            "an edited copy is NOT cleared — equality on the whole value, not a substring match, is what keeps a club's edit safe",
          sql: `SELECT "contentHtml" FROM "SiteContent"
                 WHERE "key" = 'FOOTER_AFFILIATIONS'`,
          rows: [{ contentHtml: withoutRmcaLine(plantedAffiliationsHtml) }],
        },
      ],
    },
    {
      name: "the rest of the row, on the install being cleaned",
      seed: `
        UPDATE "SiteContent"
        SET "updatedByMemberId" = 'admin-3',
            "updatedAt" = TIMESTAMP '2026-02-02 00:00:00'
        WHERE "key" = 'FOOTER_AFFILIATIONS';
      `,
      expectations: [
        {
          claim:
            "updatedAt and updatedByMemberId are deliberately untouched — this is a system repair, not an admin edit, which is also what keeps the session clock out of the payload",
          sql: `SELECT "updatedByMemberId",
                       to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
                  FROM "SiteContent" WHERE "key" = 'FOOTER_AFFILIATIONS'`,
          rows: [
            { updatedByMemberId: "admin-3", updatedAt: "2026-02-02 00:00:00" },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "drop the value match, keeping only the key match",
      harm:
        "Empties the affiliations column of every install, wiping the affiliations a club wrote itself. This is the single most likely way to write this migration wrong, because it looks simpler and passes on a fresh install.",
      find: `AND "contentHtml" = ${dollarQuotedCms(plantedAffiliationsHtml)}`,
      replace: "",
    },
    {
      name: "match a substring instead of the whole value",
      harm:
        "A club that deleted the RMCA line but kept the rest loses its whole affiliations column — the edited-copy case this migration exists to protect.",
      find: `AND "contentHtml" = ${dollarQuotedCms(plantedAffiliationsHtml)}`,
      replace: `AND "contentHtml" LIKE '%Federated Mountain Clubs%'`,
    },
    {
      name: "delete the row instead of clearing it",
      harm:
        "A missing row makes the admin editor fall back to the starter default instead of showing the section deliberately empty, so the section is not really gone.",
      find: `UPDATE "SiteContent"\nSET "contentHtml" = ''\nWHERE`,
      replace: `DELETE FROM "SiteContent"\nWHERE`,
    },
  ],
};

/**
 * Wrap a value in a `$fixture$` dollar-quoted literal. The markup carries single
 * quotes, double quotes and `%` characters, so anything that escaped by hand
 * would be one edit away from a fixture that seeds different bytes than it
 * asserts. The tag cannot occur inside HTML.
 */
function dollarQuoted(value: string): string {
  if (value.includes("$fixture$")) {
    throw new Error("fixture value contains the dollar-quote tag $fixture$");
  }
  return `$fixture$${value}$fixture$`;
}

/**
 * The `$cms$`-quoted spelling the migrations themselves use, rebuilt so the
 * mutants below can name the whole value predicate without restating the
 * markup.
 */
function dollarQuotedCms(value: string): string {
  return `$cms$${value}$cms$`;
}

/** The planted markup with the RMCA list item removed, as a club might edit it. */
function withoutRmcaLine(html: string): string {
  const edited = html.replace(/<li><a href="https:\/\/rmca\.org\.nz\/"[\s\S]*?<\/li>/, "");
  if (edited === html) {
    throw new Error(
      "planted FOOTER_AFFILIATIONS markup no longer contains the RMCA list item — the edited-copy case would test nothing.",
    );
  }
  return edited;
}

export default verification;
