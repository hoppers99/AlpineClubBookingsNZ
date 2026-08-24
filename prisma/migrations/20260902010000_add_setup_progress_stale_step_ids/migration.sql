-- Setup wizard C2 (#217; epic #213): persist which completed setup steps an
-- upstream change has put back in question, so "I completed this, then
-- something it depends on changed" survives a page reload and has a transition
-- instant the audit log can record.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds one array column to SetupProgress, with a constant default.
-- Nothing is dropped, renamed, retyped, backfilled or indexed.

-- AlterTable: NOT NULL with a CONSTANT default, which PostgreSQL 11+ records as
-- catalog metadata rather than rewriting the heap. Every existing row therefore
-- reads the empty array, which is the correct answer for it in both readings:
-- nothing before this release could have been marked stale, and the empty array
-- is this column's "computed: nothing is stale" value rather than an unknown.
-- That is what makes "no step goes stale on deploy day" true by construction.
--
-- The default is also the old-code compatibility pattern: the previously
-- deployed Prisma client's INSERT omits this column entirely, and an
-- omitted-column INSERT succeeds because the column supplies its own value.
ALTER TABLE "SetupProgress" ADD COLUMN     "staleStepIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
