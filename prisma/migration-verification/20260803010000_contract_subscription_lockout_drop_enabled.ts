import type { DataMigrationVerification } from "./types";

/**
 * #2543 / #2561 — the backfill that carries every club's booking-lockout policy
 * across the drop of the legacy `enabled` boolean.
 *
 * WHY THIS FIXTURE EARNS ITS KEEP. The migration is the only place the
 * `enabled -> mode` mapping is ever applied to live rows. Before it, a NULL `mode`
 * meant "read the boolean" and the read path did the mapping on every request;
 * after it, the boolean is gone and the stored `mode` is the whole truth. So a
 * wrong backfill is not a cosmetic defect — it silently changes which members a
 * club refuses at the booking gate, and there is nothing left to correct it from.
 *
 * The case that matters most is the club that had deliberately switched the
 * lockout OFF. `enabled` defaults to `true`, and the obvious-looking backfill
 * (`SET "mode" = 'HARD_BLOCK' WHERE "mode" IS NULL`, or dropping the column before
 * reading it) hard-blocks every one of those clubs' unfinancial members from their
 * next deploy onwards. CI's `Migration drift check` cannot see that: it applies
 * migrations to an EMPTY database, where this UPDATE matches no rows and is proven
 * only to parse. These cases run the real statements against real rows.
 *
 * Every case seeds its own row: `20260626120000_add_membership_lockout_settings`
 * creates `MembershipLockoutSettings` empty, and nothing in the chain or the seeds
 * plants the singleton — it appears when an admin first saves the panel or a
 * config bundle is imported.
 *
 * Expectations deliberately never select `"enabled"`: it does not exist once the
 * migration has run, so the drop is asserted through `information_schema` instead.
 */
const verification: DataMigrationVerification = {
  migration: "20260803010000_contract_subscription_lockout_drop_enabled",
  intent:
    "Carry every club's stored lockout policy onto the mandatory three-way `mode` column before the legacy `enabled` boolean is dropped: an un-chosen row takes the boolean's meaning (true -> HARD_BLOCK, false -> NO_BLOCK), and a club that has already chosen a mode keeps it.",
  // The migration drops a column and adds a NOT NULL constraint; a second run
  // raises rather than being a no-op, so it cannot claim replay safety.
  idempotentReRun: false,
  cases: [
    {
      name: "a club that never opened the panel, with the lockout left ON (the default)",
      seed: `
        INSERT INTO "MembershipLockoutSettings"
          ("id", "enabled", "mode", "textFallbackEnabled", "updatedAt")
        VALUES ('default', true, NULL, true, TIMESTAMP '2026-01-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "the un-chosen row takes the boolean's meaning: enabled = true becomes HARD_BLOCK, which is the policy the read path already resolved for it",
          sql: 'SELECT "id", "mode"::text AS "mode" FROM "MembershipLockoutSettings" ORDER BY "id"',
          rows: [{ id: "default", mode: "HARD_BLOCK" }],
        },
      ],
    },
    {
      name: "a club that had DELIBERATELY switched the lockout off",
      seed: `
        INSERT INTO "MembershipLockoutSettings"
          ("id", "enabled", "mode", "textFallbackEnabled", "updatedAt")
        VALUES ('default', false, NULL, true, TIMESTAMP '2026-01-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "enabled = false becomes NO_BLOCK, NOT the HARD_BLOCK default — this club chose to stop gating on subscriptions, and a backfill that ignored the boolean would start refusing their unfinancial members with no admin action and no way back",
          sql: 'SELECT "mode"::text AS "mode" FROM "MembershipLockoutSettings" WHERE "id" = \'default\'',
          rows: [{ mode: "NO_BLOCK" }],
        },
      ],
    },
    {
      name: "a club that has already chosen NON_MEMBER_PRICING",
      seed: `
        INSERT INTO "MembershipLockoutSettings"
          ("id", "enabled", "mode", "textFallbackEnabled", "updatedAt")
        VALUES ('default', true, 'NON_MEMBER_PRICING', true, TIMESTAMP '2026-01-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "a chosen mode survives: the backfill is scoped WHERE \"mode\" IS NULL, so this club is not reset to HARD_BLOCK by its legacy boolean — which is deliberately `true` for NON_MEMBER_PRICING and would otherwise read as the hard block",
          sql: 'SELECT "mode"::text AS "mode" FROM "MembershipLockoutSettings" WHERE "id" = \'default\'',
          rows: [{ mode: "NON_MEMBER_PRICING" }],
        },
      ],
    },
    {
      name: "a club whose chosen mode DISAGREES with its stale legacy boolean",
      seed: `
        INSERT INTO "MembershipLockoutSettings"
          ("id", "enabled", "mode", "textFallbackEnabled", "updatedAt")
        VALUES ('default', true, 'NO_BLOCK', true, TIMESTAMP '2026-01-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "the chosen mode wins over the boolean, exactly as the pre-drop read path resolved it — the boolean is never allowed to overwrite an explicit choice",
          sql: 'SELECT "mode"::text AS "mode" FROM "MembershipLockoutSettings" WHERE "id" = \'default\'',
          rows: [{ mode: "NO_BLOCK" }],
        },
      ],
    },
    {
      name: "the resulting schema shape, on a club that never opened the panel",
      seed: `
        INSERT INTO "MembershipLockoutSettings"
          ("id", "enabled", "mode", "textFallbackEnabled", "updatedAt")
        VALUES ('default', false, NULL, true, TIMESTAMP '2026-01-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "the legacy column is gone — asserted through the catalog because selecting it would raise",
          sql: `SELECT count(*)::int AS "legacyColumns"
                  FROM information_schema.columns
                 WHERE table_name = 'MembershipLockoutSettings'
                   AND column_name = 'enabled'`,
          rows: [{ legacyColumns: 0 }],
        },
        {
          claim:
            "`mode` is now mandatory and defaults to HARD_BLOCK, so a fresh install starts where every existing club already was",
          sql: `SELECT "is_nullable" AS "isNullable", "column_default" AS "columnDefault"
                  FROM information_schema.columns
                 WHERE table_name = 'MembershipLockoutSettings'
                   AND column_name = 'mode'`,
          rows: [
            {
              isNullable: "NO",
              columnDefault: "'HARD_BLOCK'::\"SubscriptionLockoutMode\"",
            },
          ],
        },
        {
          claim:
            "the row itself survives and keeps its other settings — this migration moves one column's meaning, it does not rewrite the club's configuration",
          sql: `SELECT "textFallbackEnabled",
                       to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
                  FROM "MembershipLockoutSettings" WHERE "id" = 'default'`,
          rows: [
            { textFallbackEnabled: true, updatedAt: "2026-01-01 00:00:00" },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "invert the CASE (enabled -> NO_BLOCK, unset -> HARD_BLOCK)",
      harm:
        "Every club that had the lockout ON stops gating on subscriptions, and every club that had switched it OFF starts refusing its unfinancial members. Both directions are money-affecting and neither is recoverable once the boolean is dropped.",
      find: `WHEN "enabled" THEN 'HARD_BLOCK'::"SubscriptionLockoutMode"
    ELSE 'NO_BLOCK'::"SubscriptionLockoutMode"`,
      replace: `WHEN "enabled" THEN 'NO_BLOCK'::"SubscriptionLockoutMode"
    ELSE 'HARD_BLOCK'::"SubscriptionLockoutMode"`,
    },
    {
      name: "ignore the boolean and write HARD_BLOCK unconditionally",
      harm:
        "The exact regression this migration is ordered to avoid: a club that deliberately switched the lockout OFF is silently hard-blocked from the next deploy onward, with no admin action, no notice, and the boolean that recorded their choice already dropped.",
      find: `SET "mode" = CASE
    WHEN "enabled" THEN 'HARD_BLOCK'::"SubscriptionLockoutMode"
    ELSE 'NO_BLOCK'::"SubscriptionLockoutMode"
  END`,
      replace: `SET "mode" = 'HARD_BLOCK'::"SubscriptionLockoutMode"`,
    },
    {
      name: "drop the WHERE clause, so the backfill overwrites a chosen mode",
      harm:
        "A club that had already chosen NON_MEMBER_PRICING is reset to HARD_BLOCK by its legacy boolean — the club is put back to refusing the members it had decided to charge non-member rates instead, and the money regime changes under them.",
      find: `WHERE "mode" IS NULL;`,
      replace: ";",
    },
    {
      name: "leave `mode` nullable",
      harm:
        "The column the whole application now reads as authoritative can hold NULL again, so a row inserted without it resolves through a fallback that no longer exists — the settings load returns an unresolvable policy instead of a club's choice.",
      find: `  ALTER COLUMN "mode" SET DEFAULT 'HARD_BLOCK',
  ALTER COLUMN "mode" SET NOT NULL;`,
      replace: `  ALTER COLUMN "mode" SET DEFAULT 'HARD_BLOCK';`,
    },
  ],
};

export default verification;
