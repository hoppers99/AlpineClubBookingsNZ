-- Reverse script for 20260803010000_contract_subscription_lockout_drop_enabled.
--
-- WHAT THIS IS FOR. That migration is declared `old_code_compatible=windowed` in
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv, so its rollback boundary is the MIGRATE
-- step, not the cutover: once it commits, the previous release is already broken
-- and aborting the deploy no longer restores service. This script is the path
-- that undoes the schema change without a full restore. See
-- docs/BLUE_GREEN_MIGRATION_POLICY.md -> "A `windowed` migration moves the
-- rollback boundary".
--
-- Prisma never applies, checksums or even reads this file. Run it by hand, as the
-- migration role, against the database you are rolling back.
--
-- WHEN TO USE IT. To go back to the release immediately before this one — the
-- release currently in production, whose schema has `enabled` and NO `mode` column
-- and no `SubscriptionLockoutMode` type at all, because both of this release's
-- migrations ship together (that is the whole point of the #2561 directive). If you
-- are rolling back further than that, use the verified backup instead.
--
-- WHAT IT RESTORES, AND WHAT IT DOES NOT.
--
--   * `enabled` is recreated and repopulated from `mode`: NO_BLOCK -> false, and
--     both HARD_BLOCK and NON_MEMBER_PRICING -> true. The NON_MEMBER_PRICING
--     direction is deliberate and is the owner's mapping (#2561): the previous
--     release cannot reprice anybody, so refusing an unpaid member is the honest
--     fallback, whereas `false` would hand them full member rates — the one
--     outcome the club explicitly decided against. The column comes back
--     byte-identical to the one `20260626120000` created —
--     `BOOLEAN NOT NULL DEFAULT true`.
--   * `mode` and its enum type deliberately SURVIVE, as inert extras. They are not
--     dropped, because `mode` is now the only record of each club's policy and
--     dropping it would destroy a setting the previous release cannot recreate. The
--     previous release's Prisma client does not name `mode` anywhere — it neither
--     selects it nor inserts it — so an extra nullable column is invisible to it,
--     which is exactly why the rollback works. Expect
--     `prisma migrate diff` against that release's `schema.prisma` to report two
--     leftover objects (`DROP COLUMN "mode"`, `DROP TYPE
--     "SubscriptionLockoutMode"`); that is the intended end state, not drift to
--     chase. Step 3 below returns `mode` to nullable-without-default so the shape
--     matches "expand applied, contract not applied", which is what makes a later
--     roll-forward a clean re-run of `migration.sql`.
--   * NOT restored: which clubs had never opened the panel. Before this
--     migration a NULL `mode` meant "no choice made, read the boolean"; the
--     backfill replaced those NULLs with a real mode, and this script cannot tell
--     a backfilled row from one an admin chose. That is lossless in BEHAVIOUR —
--     the backfilled value is exactly what the old read path computed from the
--     boolean, so the previous release resolves the same policy either way — but
--     it does mean the "never chosen" flag itself is gone. Nothing reads that
--     flag, so nothing is affected; it is recorded here because an operator
--     comparing row counts of NULL `mode` before and after will see the
--     difference and should not go looking for a fault.
--
-- After running this, redeploy the previous release's images. Do not run
-- `prisma migrate deploy` again until you intend to roll forward: the migration
-- will still be recorded as applied in `_prisma_migrations`, so rolling forward
-- means either deleting that row or re-applying migration.sql by hand.

-- 1. Recreate the column with the default the previous release's schema declares.
ALTER TABLE "MembershipLockoutSettings"
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- 2. Repopulate it from the mode, per the owner's mapping.
UPDATE "MembershipLockoutSettings"
SET "enabled" = ("mode" <> 'NO_BLOCK');

-- 3. Return `mode` to the shape the EXPAND migration in this release left it in:
--    nullable, no default. Not required for the previous release to run — its client
--    never names this column — but it makes the database agree with "expand applied,
--    contract not applied", so rolling forward later is a clean re-run of
--    migration.sql rather than a partially-applied shape to reason about.
ALTER TABLE "MembershipLockoutSettings"
  ALTER COLUMN "mode" DROP DEFAULT,
  ALTER COLUMN "mode" DROP NOT NULL;
