-- Reverse script for 20260803030000_contract_drop_family_group_member_role.
--
-- WHAT THIS IS FOR. That migration is declared `old_code_compatible=windowed` in
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv, so its rollback boundary is the MIGRATE
-- step, not the cutover: once it commits, the previous release is already broken
-- and aborting the deploy no longer restores service. This script is the path that
-- undoes the schema change without a full restore. See
-- docs/BLUE_GREEN_MIGRATION_POLICY.md -> "A `windowed` migration moves the
-- rollback boundary".
--
-- Prisma never applies, checksums or even reads this file. Run it by hand, as the
-- migration role, against the database you are rolling back.
--
-- WHEN TO USE IT. To go back to the release that was in production before this
-- one. Under the owner's 3 Aug 2026 directive the RUNTIME half (#2565) was never
-- deployed on its own, so that release is the last tagged one — v0.13.2 or
-- whatever the operator recorded at runbook §1.4 — whose prisma/schema.prisma
-- declares `role String @default("MEMBER")` with NO `@ignore`, i.e. a client that
-- names the column in ordinary SELECTs, in insert column lists and in a WHERE
-- clause (`role: "ADMIN"`). Without this script that release cannot serve the
-- family surface at all. If you are rolling back further than that release, use
-- the verified backup instead.
--
-- WHAT IT RESTORES, AND WHAT IT DOES NOT.
--
--   * The COLUMN comes back byte-identical to the one
--     20260407120000_add_family_group_member_join_table created:
--     `"role" TEXT NOT NULL DEFAULT 'MEMBER'`. That is exactly the shape the
--     previous release's Prisma client expects from
--     `role String @default("MEMBER")` — TEXT, NOT NULL, constant default — so its
--     reads, its omitted-column inserts and its `role: "ADMIN"` filters all work
--     again. Adding a column with a CONSTANT default is metadata-only on
--     PostgreSQL 11+, so every existing row is populated by the same statement
--     with no table rewrite and no window in which the column exists unpopulated.
--
--   * THE PER-ROW VALUES ARE NOT RESTORED, and cannot be: PostgreSQL cannot
--     un-drop a column, and this script has nowhere to read the old labels from.
--     Every row comes back as 'MEMBER'.
--
-- WHY 'MEMBER' IS THE SAFE COMPATIBILITY VALUE. It is the column's own default
-- since it was created, so it is the value the database itself supplied to every
-- row inserted after #2565 stopped the client naming the column — for those rows
-- it is not a substitute, it is the actual value. It is also the LEAST-PRIVILEGED
-- of the three labels that ever existed ('MEMBER', 'ADMIN', 'LEAD'): restoring
-- 'MEMBER' can only ever withhold a power, never grant one. Reconstructing 'ADMIN'
-- by heuristic — from who created the group, or from FamilyGroup.billingMembershipId
-- — was considered and rejected: that is a guess about who holds a privilege, and
-- guessing in the granting direction is the one mistake a rollback script must not
-- make.
--
-- WHAT 'MEMBER' COSTS, stated plainly rather than buried. On a rolled-back release
-- that PREDATES #2284 — which the last tagged release does — the value is read in
-- one place: the one-step partner declaration
-- (`listOneStepPartnerCandidates` and the one-step path of `requestPartnerLink` in
-- src/lib/member-partner-link.ts) requires the acting member to hold
-- `role: "ADMIN"` in a group the target belongs to. With every row back as
-- 'MEMBER' nobody holds ADMIN, so that path finds no candidates and, for a
-- no-login target, returns its 403 ("Only the admin of their family group can
-- declare this partnership directly; otherwise ask an admin"). Everything else
-- about family groups — membership, billing family, join/invite/removal requests,
-- admin editing, merges — is unaffected, because nothing else reads the value.
-- That is a FAIL-CLOSED loss of one convenience path, not a data loss and not a
-- privilege escalation, and it is the correct direction for a fallback. The
-- workaround on the rolled-back release is the ordinary consent round-trip: the
-- partner link is still creatable, it just asks the other member first.
--
-- IF YOU NEED THE EXACT OLD VALUES BACK, there are two sources, in order of
-- preference:
--
--   1. The per-row dump the runbook's pre-migration checks take
--      (docs/PRODUCTION_UPGRADE_RUNBOOK.md -> "Windowed migration deploy
--      sequence", #2520 step 8). If you took it, run step 3 below after step 1 to
--      restore every label exactly. This is why that dump is in the checklist.
--   2. The verified backup taken immediately before migrating. Use it if the dump
--      was skipped and the labels genuinely matter.
--
-- After running this, redeploy the previous release's images. Do not run
-- `prisma migrate deploy` again until you intend to roll forward: the migration
-- will still be recorded as applied in `_prisma_migrations`, so rolling forward
-- means either deleting that row or re-applying migration.sql by hand.

-- 1. Recreate the column in the exact shape the previous release's client expects.
--    The constant default repopulates every existing row in this one statement.
ALTER TABLE "FamilyGroupMember"
  ADD COLUMN "role" TEXT NOT NULL DEFAULT 'MEMBER';

-- 2. Confirm the shape before you redeploy. Expect one row:
--    role | text | NO | 'MEMBER'::text
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'FamilyGroupMember'
  AND column_name = 'role';

-- 3. OPTIONAL — exact value restore from the pre-migration dump. Only run this if
--    you took the per-row `\copy` at step 8 of the window and you need the old
--    labels back (see "WHAT 'MEMBER' COSTS" above for when that matters). Load the
--    CSV into a temporary table and copy the labels across by id. Rows that have
--    been deleted since the dump simply do not match, and rows created since the
--    dump keep their 'MEMBER' default, which is correct for both.
--
--    RUN IT AS A SCRIPT FILE — `psql -f restore.sql`, not `psql -c "..."`. `\copy`
--    is a psql meta-command, so it is a syntax error inside `-c`, and the TEMP
--    table has to live in the same session as the UPDATE. Rehearsed exactly this
--    way (runbook §7.2): it reported `UPDATE 2` and restored every label.
--
--    CREATE TEMP TABLE "family_group_member_role_restore" (
--      "id"   TEXT PRIMARY KEY,
--      "role" TEXT NOT NULL
--    );
--    \copy "family_group_member_role_restore" FROM 'family-group-member-role-YYYYMMDD.csv' CSV HEADER
--    UPDATE "FamilyGroupMember" AS target
--    SET "role" = restore."role"
--    FROM "family_group_member_role_restore" AS restore
--    WHERE target."id" = restore."id"
--      AND target."role" <> restore."role";
