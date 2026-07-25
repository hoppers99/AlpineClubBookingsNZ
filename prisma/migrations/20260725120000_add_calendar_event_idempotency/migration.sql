-- Idempotent calendar-event create (#calendar). A create may carry an optional
-- client dedup token; a duplicate replay returns the first event instead of
-- inserting another.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds ONE new nullable column on CalendarEvent plus a unique index. Purely
--    additive — the previously deployed (old-colour) client never writes this
--    column, so every row it inserts leaves it NULL, and NULLs are DISTINCT in a
--    Postgres unique index (no collision), so it keeps working unchanged during
--    migrate -> cutover drain. No enum change, no column drop/alter, no RENAME,
--    no backfill DML, no foreign key, no session-clock write, and no external
--    provider call. The new-colour runtime is the only writer of the token.

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_idempotencyKey_key" ON "CalendarEvent"("idempotencyKey");
