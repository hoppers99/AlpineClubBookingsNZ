-- #2543 / #2561 — CONTRACT half of the three-way subscription booking lockout:
-- backfill `mode`, make it mandatory, and drop the legacy `enabled` boolean.
--
-- Background. `20260803000000_subscription_lockout_three_way_mode` (the EXPAND
-- half, in this same release) added the `SubscriptionLockoutMode` enum and a
-- NULLABLE `mode` column, leaving `enabled` in place and the application writing
-- both. That shape assumed a later contract release. OWNER DIRECTIVE, 3 Aug 2026
-- (#2561): complete the change in ONE release as an explicit maintenance-window
-- migration instead, and remove every dual-read/dual-write path with it.
--
-- previous_expand_release. 20260803000000_subscription_lockout_three_way_mode.
-- It ships in the SAME release as this migration rather than an earlier one, and
-- that is exactly why this is declared `old_code_compatible=windowed` rather than
-- `yes`: there is no drained colour that has stopped reading `enabled`. The
-- previous release's Prisma client names `enabled` on every unnarrowed
-- find/create of this model, so between migrate and cutover the old colour errors
-- on the admin subscription-lockout panel and on `loadMembershipLockoutSettings`.
-- The deploy therefore runs behind a maintenance window with traffic removed and
-- the old app and workers stopped. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv and
-- docs/PRODUCTION_UPGRADE_RUNBOOK.md -> "Windowed migration deploy sequence".
--
-- ORDER IS LOAD-BEARING. The backfill reads `enabled`, so it MUST precede the
-- DROP. Dropping first would lose the off-switch of every club that never opened
-- the panel and silently hard-block them — the one money-affecting regression
-- this migration exists to avoid.
--
-- Data safety. The backfill is scoped `WHERE "mode" IS NULL`, so a club that has
-- already chosen a mode keeps it: a club on NON_MEMBER_PRICING is not reset to
-- HARD_BLOCK by its (deliberately `true`) legacy boolean. Every club that never
-- opened the panel gets the mapping the read path applied at runtime anyway
-- (`true -> HARD_BLOCK`, `false -> NO_BLOCK`), so no club's booking behaviour
-- moves across this migration. Verified against real rows by
-- prisma/migration-verification/20260803010000_contract_subscription_lockout_drop_enabled.ts.
--
-- Lock impact. "MembershipLockoutSettings" is a cold, admin-only, SINGLE-ROW
-- config table, absent from the deploy guard's HOT_TABLE_SQL_REGEX. The backfill
-- UPDATE touches at most one row. `SET DEFAULT` and `SET NOT NULL` are
-- metadata-only catalog changes on that one row (the NOT NULL validation scan
-- reads a single tuple), and `DROP COLUMN` is metadata-only with no table
-- rewrite. Each takes a brief ACCESS EXCLUSIVE lock. No index, constraint,
-- trigger, foreign key, session-clock write or provider call is involved.
--
-- Rollback. rollback.sql beside this file recreates `enabled` from `mode`
-- (NO_BLOCK -> false, HARD_BLOCK and NON_MEMBER_PRICING -> true) and returns `mode`
-- to nullable-without-default. It does NOT drop `mode` or its enum type: they are
-- now the only record of each club's policy, and the previous release's client never
-- names either, so they sit there inert and it runs. Rehearsed both ways against a
-- production-shaped database; the transcript summary is in
-- docs/PRODUCTION_UPGRADE_RUNBOOK.md.

-- 1. Backfill every un-chosen row from the legacy boolean. Must run BEFORE the
--    drop below, and must not overwrite a mode an admin has already chosen.
UPDATE "MembershipLockoutSettings"
SET "mode" = CASE
    WHEN "enabled" THEN 'HARD_BLOCK'::"SubscriptionLockoutMode"
    ELSE 'NO_BLOCK'::"SubscriptionLockoutMode"
  END
WHERE "mode" IS NULL;

-- 2. `mode` becomes mandatory. HARD_BLOCK is the default because it is the
--    behaviour the old `enabled = true` default produced, so a fresh install
--    starts where every existing club already was.
ALTER TABLE "MembershipLockoutSettings"
  ALTER COLUMN "mode" SET DEFAULT 'HARD_BLOCK',
  ALTER COLUMN "mode" SET NOT NULL;

-- 3. The legacy column goes. Nothing in this release reads or writes it.
ALTER TABLE "MembershipLockoutSettings"
  DROP COLUMN "enabled";
