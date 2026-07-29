-- Custodian bed hold (#2286, epic #2245).
--
-- EXPAND, forward-only, old-colour compatible. Three additive statements on
-- two COLD tables (HutLeaderAssignment, LodgeBed — neither is in
-- HOT_TABLE_SQL_REGEX):
--   1. a nullable ADD COLUMN with no default (PostgreSQL metadata-only, no
--      table rewrite, no row scan),
--   2. a plain btree index over that all-NULL column,
--   3. an FK whose validation scan matches nothing (every existing row NULL).
--
-- NULL is exactly today's semantics: an assignment without a bed is a role
-- only and has zero capacity effect, so the previously deployed colour — which
-- never names "bedId" — behaves identically. See
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the full reasoning.
--
-- Deliberately NOT restated here: HutLeaderAssignment."lodgeId"'s
-- dbgenerated default_lodge_id() default. This migration touches only the new
-- column.

-- AlterTable
ALTER TABLE "HutLeaderAssignment" ADD COLUMN     "bedId" TEXT;

-- CreateIndex
CREATE INDEX "HutLeaderAssignment_bedId_idx" ON "HutLeaderAssignment"("bedId");

-- AddForeignKey
ALTER TABLE "HutLeaderAssignment" ADD CONSTRAINT "HutLeaderAssignment_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "LodgeBed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
