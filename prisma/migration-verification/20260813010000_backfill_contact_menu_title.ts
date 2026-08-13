import type { DataMigrationVerification } from "./types";

/**
 * #2818 decision 5 — the Contact link the nav clean-up would otherwise have
 * deleted from every deployment.
 *
 * The public header used to append a hard-coded `/contact` entry after the
 * CMS-driven links. #2813 removed it so the navigation is entirely the club's to
 * arrange, and the contact PageContent row has always seeded `menuTitle = ''` —
 * so without this migration the link vanishes everywhere on upgrade.
 *
 * The safety property is the same value-scoping the sibling starter-copy repairs
 * use: the WHERE matches only rows still holding the seeded empty string, so a
 * club that typed its own label keeps it. A test that string-matches the SQL
 * proves the author's intent; only running the statement against real rows
 * proves PostgreSQL agrees.
 *
 * No seed for the first case: the pre-state is whatever the migration chain
 * itself produces — an empty `menuTitle` on the seeded contact row — which is
 * precisely the state this migration exists to repair.
 */
const verification: DataMigrationVerification = {
  migration: "20260813010000_backfill_contact_menu_title",
  intent:
    "Give the seeded contact row the menu title 'Contact', so a fully CMS-driven navigation still shows the Contact link — and leave a label the club typed itself untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a deployment that never edited the contact page's menu title",
      seed: "",
      expectations: [
        {
          claim:
            "the contact row now carries the menu title 'Contact', so the CMS-driven nav still shows the link",
          sql: `SELECT "menuTitle" FROM "PageContent" WHERE "slug" = 'contact'`,
          rows: [{ menuTitle: "Contact" }],
        },
        {
          claim:
            "nothing else about the contact page moved — the repair writes one field",
          sql: `SELECT "title", "caption", "path" FROM "PageContent" WHERE "slug" = 'contact'`,
          rows: [
            { title: "Contact Us", caption: "Get in touch", path: "/contact" },
          ],
        },
      ],
    },
    {
      name: "a club that typed its own label for the contact page",
      seed: `
        UPDATE "PageContent"
        SET "menuTitle" = 'Kōrero mai'
        WHERE "slug" = 'contact';
      `,
      expectations: [
        {
          claim:
            "the club's own label survives — the statement is scoped to the seeded empty VALUE, not to the contact row",
          sql: `SELECT "menuTitle" FROM "PageContent" WHERE "slug" = 'contact'`,
          rows: [{ menuTitle: "Kōrero mai" }],
        },
      ],
    },
    {
      name: "another page whose menu title is also still the seeded empty string",
      seed: "",
      expectations: [
        {
          claim:
            "only the contact row is touched — the privacy, terms, faq and join/apply rows keep their empty menu titles and stay out of the nav",
          sql: `SELECT "slug", "menuTitle" FROM "PageContent" WHERE "menuTitle" = '' ORDER BY "slug"`,
          rows: [
            { slug: "404", menuTitle: "" },
            { slug: "booking-requests", menuTitle: "" },
            { slug: "faq", menuTitle: "" },
            { slug: "home", menuTitle: "" },
            { slug: "join/apply", menuTitle: "" },
            { slug: "privacy", menuTitle: "" },
            { slug: "school-bookings", menuTitle: "" },
            { slug: "terms", menuTitle: "" },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "drop the value guard, keeping only the slug",
      harm:
        "Overwrites the contact menu label of every install including clubs that typed their own — silent loss of a club's own navigation wording, and of a deliberate blank that hid the page.",
      find: `WHERE "slug" = 'contact'\n  AND "menuTitle" = '';`,
      replace: `WHERE "slug" = 'contact';`,
    },
    {
      name: "drop the slug guard, keeping only the empty-value guard",
      harm:
        "Labels EVERY unlabelled page 'Contact' — the privacy, terms, FAQ, 404 and both booking-request pages would all appear in the public navigation, each linking somewhere it does not describe. The booking-request pages are the worst of it: advertising those forms is opt-in per club (#2818 decision 1), and this would opt every club in without asking.",
      find: `WHERE "slug" = 'contact'\n  AND "menuTitle" = '';`,
      replace: `WHERE "menuTitle" = '';`,
    },
    {
      name: "invert the value guard (= becomes <>)",
      harm:
        "Rewrites the label of every club that DID type one, and leaves the seeded blank alone — the exact inverse of the intent, so the link stays missing and a club's own wording is destroyed.",
      find: `AND "menuTitle" = '';`,
      replace: `AND "menuTitle" <> '';`,
    },
  ],
};

export default verification;
