-- #2543 — the subscription booking lockout becomes a three-way policy.
--
-- The old boolean `enabled` could only say "hard-block an unpaid member" or
-- "do not gate at all". Clubs also want the third answer: let them book, but at
-- non-member rates. Modelled as an enum rather than a second boolean so the
-- three answers stay mutually exclusive and a club can never be in two states.
--
-- EXPAND ONLY, and deliberately so (docs/BLUE_GREEN_MIGRATION_POLICY.md). Two
-- things this migration does NOT do, each for a stated reason:
--
--  1. It does not DROP the old `enabled` column. That is a destructive contract
--     change: between `migrate` and cutover the draining old colour is still
--     reading `enabled`, and dropping it here would error every booking gate on
--     that colour. `enabled` stays, the application keeps writing it in step with
--     the new column (`legacyEnabledForLockoutMode`), and a later contract
--     release drops it once no colour reads it.
--
--  2. It does not BACKFILL. `mode` is left NULLABLE with no default, and NULL
--     means "this club has not chosen a mode yet, so read the legacy boolean" —
--     `normalizeMembershipLockoutSettings` maps `enabled = true -> HARD_BLOCK`
--     and `false -> NO_BLOCK` at read time. A club that had deliberately
--     switched the lockout OFF therefore stays off. An UPDATE backfill would
--     reach the same answer today but would make this a data-rewriting migration
--     (a verification fixture, per scripts/check-data-migration-verification.sh)
--     for a rewrite that duplicates a mapping the read path must own regardless:
--     a draining old colour can still write `enabled`, so a backfilled `mode`
--     can go stale during the cutover window and the read-time mapping is the
--     thing that has to be correct.
--
-- Net effect on every existing club: none. No club's booking behaviour moves
-- until an admin picks a mode in Admin -> Subscription lockout.

CREATE TYPE "SubscriptionLockoutMode" AS ENUM ('NO_BLOCK', 'HARD_BLOCK', 'NON_MEMBER_PRICING');

ALTER TABLE "MembershipLockoutSettings"
  ADD COLUMN "mode" "SubscriptionLockoutMode";
