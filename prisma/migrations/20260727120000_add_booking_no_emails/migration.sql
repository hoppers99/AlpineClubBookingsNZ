-- #2258: per-booking "No emails" switch (owner decision D10) + the audit trail
-- that records what the mailer withheld.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * registers one new EmailLogStatus label,
--  * adds three columns to Booking (one boolean with a constant default, two
--    nullable audit columns),
--  * adds one nullable column plus one btree index to EmailLog.
-- Nothing is dropped, renamed, retyped or backfilled.

-- Terminal, non-retryable outcome for a send withheld by the booking's
-- "No emails" switch. The migration only REGISTERS the label and never USES it,
-- so Prisma's per-migration transaction is safe (same pattern as
-- 20260719130000 / 20260720130000).
ALTER TYPE "EmailLogStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_NO_EMAILS';

-- The switch itself plus who/when audit columns, mirroring the
-- wholeLodgeHold / wholeLodgeHoldAt / wholeLodgeHoldByMemberId shape.
ALTER TABLE "Booking" ADD COLUMN "noEmails" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Booking" ADD COLUMN "noEmailsAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "noEmailsByMemberId" TEXT;

-- Booking identity on the mail log so a withheld send is attributable, the
-- retry cron can re-evaluate the flag before a replay, and the booking page can
-- list what was held back. Deliberately NO foreign key (see schema.prisma).
ALTER TABLE "EmailLog" ADD COLUMN "bookingId" TEXT;
CREATE INDEX "EmailLog_bookingId_createdAt_idx" ON "EmailLog"("bookingId", "createdAt");

-- Audit FK + its index for the "who set it" column, matching the sibling hold
-- columns (see 20260714000000_add_exclusive_hold_fields).
CREATE INDEX "Booking_noEmailsByMemberId_idx" ON "Booking"("noEmailsByMemberId");
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_noEmailsByMemberId_fkey" FOREIGN KEY ("noEmailsByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
