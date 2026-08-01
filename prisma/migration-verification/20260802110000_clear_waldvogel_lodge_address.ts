import type { DataMigrationVerification } from "./types";

/**
 * #2484 — the Tokoroa lodge address that the historical migration chain stamps
 * onto every install.
 *
 * `20260717160100_add_lodge_address` backfilled the default lodge's `address`
 * with 'Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand'. That was
 * right when this codebase WAS the live Tokoroa Alpine Club site; now that it is
 * a reusable product, the same chain runs on every fresh install, so an
 * unrelated club's public Contact page advertises another club's real lodge.
 *
 * The whole safety argument for the cleanup is that it is VALUE-scoped, not
 * ROW-scoped: it matches the exact literal this project planted, so a club that
 * typed its own address keeps it byte for byte, and so does every additional
 * lodge a multi-lodge club created. Nothing in a string-matching test can prove
 * PostgreSQL agrees. These cases run the real statement against the real schema
 * and read the rows back.
 *
 * Note there is NO seed for the first case. The pre-state is whatever the
 * migration chain itself produces, which is the thing being complained about.
 */
const verification: DataMigrationVerification = {
  migration: "20260802110000_clear_waldvogel_lodge_address",
  intent:
    "Remove the planted Waldvogel/Iwikau address from any lodge still holding it, byte for byte, and leave every address a club typed itself untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a fresh install, carrying the address the migration chain planted",
      seed: "",
      expectations: [
        {
          claim: "the default lodge's planted address is gone",
          sql: 'SELECT "address" FROM "Lodge" WHERE "isDefault" ORDER BY "id"',
          rows: [{ address: null }],
        },
        {
          claim:
            "the lodge row itself survives — the repair clears a field, it never deletes a club's lodge",
          sql: 'SELECT count(*)::int AS "lodges" FROM "Lodge" WHERE "slug" = \'lodge\'',
          rows: [{ lodges: 1 }],
        },
      ],
    },
    {
      name: "a club that typed its own address, and a second lodge that did too",
      seed: `
        UPDATE "Lodge"
        SET "address" = '12 Kea Street, Ohakune, New Zealand'
        WHERE "isDefault";

        INSERT INTO "Lodge" ("id", "name", "slug", "active", "isDefault", "address", "updatedAt")
        VALUES ('lodge-second', 'Second Lodge', 'second-lodge', true, false,
                'Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand',
                TIMESTAMP '2026-01-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "the club's own address is untouched, and the SECOND lodge is cleared too — the statement is scoped to the planted VALUE, not to the default row",
          sql: `SELECT "slug", "address" FROM "Lodge"
                 WHERE "slug" IN ('lodge', 'second-lodge') ORDER BY "slug"`,
          rows: [
            { slug: "lodge", address: "12 Kea Street, Ohakune, New Zealand" },
            { slug: "second-lodge", address: null },
          ],
        },
      ],
    },
    {
      name: "a club whose address merely CONTAINS the planted string",
      seed: `
        UPDATE "Lodge"
        SET "address" = 'Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand (winter access only)'
        WHERE "isDefault";
      `,
      expectations: [
        {
          claim:
            "an address a club extended is NOT cleared — equality, never LIKE or a prefix match, is what keeps club-authored text safe",
          sql: 'SELECT "address" FROM "Lodge" WHERE "isDefault"',
          rows: [
            {
              address:
                "Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand (winter access only)",
            },
          ],
        },
      ],
    },
    {
      name: "the rest of the lodge row, on the install being cleaned",
      seed: `
        UPDATE "Lodge"
        SET "name" = 'Alpine Hut',
            "doorCode" = '4821',
            "travelNote" = 'Chains required past the gate.',
            "updatedAt" = TIMESTAMP '2026-02-02 00:00:00'
        WHERE "isDefault";
      `,
      expectations: [
        {
          claim:
            "nothing else on the row moves — including updatedAt, because this is a system repair and not an admin edit (so no session clock is written)",
          sql: `SELECT "name", "doorCode", "travelNote",
                       to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
                  FROM "Lodge" WHERE "isDefault"`,
          rows: [
            {
              name: "Alpine Hut",
              doorCode: "4821",
              travelNote: "Chains required past the gate.",
              updatedAt: "2026-02-02 00:00:00",
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
        "Clears every address EXCEPT the planted one: the club's own address is destroyed and the string being removed is the only one that survives.",
      find: `WHERE "address" = 'Waldvogel Lodge`,
      replace: `WHERE "address" <> 'Waldvogel Lodge`,
    },
    {
      name: "drop the WHERE clause",
      harm:
        "Clears the address of every lodge, including ones a club typed itself — a silent data loss with no way back.",
      find: `WHERE "address" = 'Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand'`,
      replace: "",
    },
    {
      name: "re-scope from the VALUE to the default ROW",
      harm:
        "Reintroduces the exact defect the value-scoping was written to avoid: it would clear whatever the default lodge holds (destroying a club's own address) while leaving the planted string on every additional lodge.",
      find: `WHERE "address" = 'Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand'`,
      replace: `WHERE "id" = default_lodge_id()`,
    },
    {
      name: "match on prefix instead of equality",
      harm:
        "A club that appended its own directions to the planted address loses the whole field — the LIKE-versus-equality distinction this migration turns on.",
      find: `WHERE "address" = 'Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand'`,
      replace: `WHERE "address" LIKE 'Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand%'`,
    },
  ],
};

export default verification;
