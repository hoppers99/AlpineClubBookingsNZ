-- #2553: a time-to-live for the provisional capacity hold a REQUESTED
-- policy-exception request keeps (#2525), plus the terminal status the reaper
-- cron writes when that hold runs out.
--
-- Purely additive EXPAND. Nothing is dropped, rewritten or backfilled: one new
-- enum value that only the new colour can write, and one nullable column with no
-- default, which PostgreSQL adds by catalog update with no heap rewrite.
-- BookingChangeRequest is a low-write admin-review table (absent from
-- HOT_TABLE_SQL_REGEX), so the brief ACCESS EXCLUSIVE lock of the ALTER never
-- contends with a hot path.

-- The reaper's terminal outcome. Like CANCELLED and SUPERSEDED before it
-- (20260802190000), it is only ever written onto a POLICY_EXCEPTION-kind row the
-- new colour created, so the draining old colour — whose pending-review queue
-- selects `status = 'REQUESTED'` — never reads one. IF NOT EXISTS keeps the
-- migration idempotent, the same guard every enum-add in this tree uses. The
-- value is NOT used anywhere in this migration, so adding it inside the
-- migration transaction is safe (PostgreSQL only forbids USING a newly added
-- value of an existing type in the same transaction).
ALTER TYPE "BookingChangeRequestStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- When the request's provisional hold runs out. Nullable with no default: NULL
-- is exactly "no TTL applies" — a LOCKED_PERIOD row, a NO_HOLD policy-exception
-- request, or a HOLD request whose incremental footprint came out empty. None of
-- those reserve beds, so none strands capacity. Deliberately NOT backfilled:
-- every existing row is either
-- LOCKED_PERIOD or a policy-exception request created within hours of this
-- migration, and the reaper derives a conservative fallback deadline from
-- `createdAt` for a HOLD-aggregate row whose column is still NULL (the
-- migrate -> cutover drain window), so no hold can outlive the TTL even without
-- a data rewrite here.
ALTER TABLE "BookingChangeRequest"
    ADD COLUMN "holdExpiresAt" TIMESTAMP(3);
