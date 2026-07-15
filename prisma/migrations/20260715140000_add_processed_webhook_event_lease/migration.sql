-- F16 webhook dedup lease (issue #1887). Additive, expand-only: two new columns
-- on ProcessedWebhookEvent turn the dedup claim into a processing lease so a
-- crashed or concurrently-failing handler can no longer silently drop a webhook
-- event. Old-colour compatible during a blue/green deploy — the previous release
-- neither reads nor writes these columns, and both carry constant/now() defaults,
-- so its inserts keep working (they land as "PROCESSING" and are safely
-- reprocessed by the new colour on redelivery rather than ACKed as done).

-- AlterTable: new columns default so existing and old-colour rows are valid.
ALTER TABLE "ProcessedWebhookEvent"
  ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  ADD COLUMN     "processingStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: every pre-migration row is a historically fully-processed event, so
-- mark them COMPLETED. New inserts (new-colour code) set "PROCESSING" explicitly
-- and flip to "COMPLETED" on success; the column default only ever covers an
-- old-colour insert mid-deploy, which must reprocess rather than drop.
--
-- Scoped to rows that existed when this migration ran (`processedAt <
-- CURRENT_TIMESTAMP`, the transaction start): (1) it never rewrites the whole
-- unbounded table blindly (no pruning job exists), and (2) it leaves any
-- concurrent old-colour insert during a blue/green deploy at the "PROCESSING"
-- default so the new colour reprocesses it on redelivery rather than ACKing it
-- as done. This is a data statement only — no schema effect, drift-clean.
UPDATE "ProcessedWebhookEvent"
  SET "status" = 'COMPLETED'
  WHERE "processedAt" < CURRENT_TIMESTAMP;
