import type { DataMigrationVerification } from "./types";

/**
 * #2431 — the starter home hero that advertised guest booking.
 *
 * `20260613090000_update_starter_home_page_content` seeds the `home` PageContent
 * row's `headerText` to "Our club lodge welcomes members and guests year-round.
 * Book a stay, join the club, …". After #2422 the public site must not read as
 * open to non-member guests, so this migration REPLACES (not clears — the `/`
 * hero is above the fold and feeds the front-page meta description) that exact
 * planted sentence with the members-only wording, wherever a club has not
 * rewritten the hero itself.
 *
 * The safety property is the same as the sibling cleanups: it is VALUE-scoped,
 * matching the exact planted sentence, so a club that reworded its hero keeps it
 * byte for byte. A string-matching test cannot prove PostgreSQL agrees; these
 * cases run the real statement against the real schema and read the row back.
 *
 * No seed for the first case — the pre-state is whatever the migration chain
 * itself produces (the planted guest-booking hero), which is the thing #2431
 * exists to fix.
 */
const PLANTED_HERO =
  "Our club lodge welcomes members and guests year-round. Book a stay, join the club, and explore New Zealand's mountains.";
const REPLACEMENT_HERO =
  "Our club lodge welcomes members year-round. Log in to book a stay, or apply to join and explore New Zealand's mountains.";

const verification: DataMigrationVerification = {
  migration: "20260802150000_update_starter_home_guest_copy",
  intent:
    "Replace the planted guest-booking home hero with the members-only wording, byte for byte, and leave a hero a club reworded itself untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a fresh install, carrying the guest-booking hero the migration chain planted",
      seed: "",
      expectations: [
        {
          claim: "the home hero no longer advertises guest booking; it carries the members-only wording",
          sql: `SELECT "headerText" FROM "PageContent" WHERE "slug" = 'home'`,
          rows: [{ headerText: REPLACEMENT_HERO }],
        },
        {
          claim: "the home row itself survives — the repair rewrites a field, it never deletes the page",
          sql: `SELECT count(*)::int AS "rows" FROM "PageContent" WHERE "slug" = 'home'`,
          rows: [{ rows: 1 }],
        },
      ],
    },
    {
      name: "a club that reworded its own hero",
      seed: `
        UPDATE "PageContent"
        SET "headerText" = 'Welcome to the Ohakune Alpine Club — members and their families all season.'
        WHERE "slug" = 'home';
      `,
      expectations: [
        {
          claim: "the club's own hero is untouched — the statement is scoped to the planted VALUE, not to the home row",
          sql: `SELECT "headerText" FROM "PageContent" WHERE "slug" = 'home'`,
          rows: [
            {
              headerText:
                "Welcome to the Ohakune Alpine Club — members and their families all season.",
            },
          ],
        },
      ],
    },
    {
      name: "a hero that merely CONTAINS the planted sentence",
      seed: `
        UPDATE "PageContent"
        SET "headerText" = '${PLANTED_HERO.replace(/'/g, "''")} Open to affiliated clubs on request.'
        WHERE "slug" = 'home';
      `,
      expectations: [
        {
          claim: "an appended hero keeps its whole field — equality, not prefix/substring, so the club's addition is not clobbered",
          sql: `SELECT "headerText" FROM "PageContent" WHERE "slug" = 'home'`,
          rows: [
            {
              headerText: `${PLANTED_HERO} Open to affiliated clubs on request.`,
            },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "invert the WHERE (= becomes <>)",
      harm:
        "Rewrites every hero EXCEPT the planted one — a club's own wording is overwritten with the members-only default and the guest-booking sentence is the only one left standing.",
      find: `AND "headerText" = 'Our club lodge welcomes members and guests`,
      replace: `AND "headerText" <> 'Our club lodge welcomes members and guests`,
    },
    {
      name: "drop the value guard, keeping only the slug",
      harm:
        "Overwrites the home hero of every install including clubs that reworded it — silent loss of a club's own front-page copy.",
      find: `WHERE "slug" = 'home'\n  AND "headerText" = 'Our club lodge welcomes members and guests year-round. Book a stay, join the club, and explore New Zealand''s mountains.'`,
      replace: `WHERE "slug" = 'home'`,
    },
    {
      name: "match on prefix instead of equality",
      harm:
        "A club that appended its own note to the planted hero loses the whole field — the substring-versus-equality distinction this migration turns on.",
      find: `AND "headerText" = 'Our club lodge welcomes members and guests year-round. Book a stay, join the club, and explore New Zealand''s mountains.'`,
      replace: `AND "headerText" LIKE 'Our club lodge welcomes members and guests year-round. Book a stay, join the club, and explore New Zealand''s mountains.%'`,
    },
  ],
};

export default verification;
