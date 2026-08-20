-- #2797: hold unpriceable edit money as an explicit pending admin task.
--
-- EXPAND-ONLY. Four ADD COLUMNs (all nullable, no default, so catalog-only and
-- no heap rewrite), two DROP NOT NULLs, two indexes and five CHECK constraints.
-- No row is read, rewritten or deleted by this file: there is no UPDATE, no
-- INSERT and no DELETE anywhere in it, so every existing ManualRefundTask,
-- BookingGuest and BookingGuestNight row is byte-identical afterwards.
--
-- Old-code compatible: the draining colour's Prisma client selects none of the
-- new columns and keeps reading "paymentId"/"amountCents", which every existing
-- row still carries. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the full
-- reasoning, including the one bounded drain interaction (a new colour may write
-- a NULL "amountCents"/"paymentId" on an EDIT_FINANCIAL_REVIEW row while the old
-- colour is still serving).

-- CreateEnum
CREATE TYPE "ManualRefundTaskKind" AS ENUM ('CANCELLED_BOOKING_HAND_BACK', 'DELETED_BOOKING_LATE_CAPTURE', 'AUTOMATIC_LATE_CAPTURE_RECORD', 'EDIT_FINANCIAL_REVIEW');

-- AlterTable
ALTER TABLE "ManualRefundTask" ADD COLUMN "raisedAmountCents" INTEGER;
ALTER TABLE "ManualRefundTask" ADD COLUMN "kind" "ManualRefundTaskKind";
ALTER TABLE "ManualRefundTask" ADD COLUMN "occurrenceKey" TEXT;
ALTER TABLE "ManualRefundTask" ADD COLUMN "reviewContext" JSONB;

-- AlterTable: an adjustment can be owed with no captured payment behind it
-- (owner decision D2), and an OPEN task can carry a genuinely unknown amount
-- rather than a magic zero another consumer would read as "assessed at nothing".
ALTER TABLE "ManualRefundTask" ALTER COLUMN "paymentId" DROP NOT NULL;
ALTER TABLE "ManualRefundTask" ALTER COLUMN "amountCents" DROP NOT NULL;

-- CreateIndex: one task per occurrence, across OPEN / COMPLETED / DISMISSED.
-- Postgres permits many NULLs under a unique index, so every pre-#2797 row and
-- every legacy-kind writer (which carry their own idempotency) is unaffected.
CREATE UNIQUE INDEX "ManualRefundTask_occurrenceKey_key" ON "ManualRefundTask"("occurrenceKey");

-- CreateIndex
CREATE INDEX "ManualRefundTask_kind_status_idx" ON "ManualRefundTask"("kind", "status");

-- Integrity: money is non-negative integer cents (INV-MONEY-001), and a task
-- cannot be COMPLETED without a confirmed amount (#2797 acceptance criterion 8).
-- Validated, not NOT VALID: every existing row was written under the old NOT NULL
-- columns with a positive policy refund amount, so the scan cannot fail, and the
-- table is small and cold.
ALTER TABLE "ManualRefundTask" ADD CONSTRAINT "ManualRefundTask_amount_nonnegative" CHECK ("amountCents" IS NULL OR "amountCents" >= 0);
ALTER TABLE "ManualRefundTask" ADD CONSTRAINT "ManualRefundTask_raised_amount_nonnegative" CHECK ("raisedAmountCents" IS NULL OR "raisedAmountCents" >= 0);
ALTER TABLE "ManualRefundTask" ADD CONSTRAINT "ManualRefundTask_completed_amount_present" CHECK ("status" <> 'COMPLETED' OR "amountCents" IS NOT NULL);

-- Integrity: keep the negative-stored-sold-price population empty GOING FORWARD
-- (#2797 acceptance criterion 14). The 11 Aug 2026 read-only audit measured that
-- population at zero (0 of 382 BookingGuest rows, 0 of 657 BookingGuestNight
-- rows), so there is nothing to repair and this file deliberately repairs nothing.
--
-- NOT VALID, and that is the point rather than a shortcut. "Forward only" is the
-- owner's rule (#2797 scope note): a deployment that somehow holds a negative row
-- must not have its deploy blocked, and must not have that row silently
-- rewritten either — correcting an already-damaged row is an audited owner
-- decision on #2745. NOT VALID also skips the validating scan, so neither of
-- these hot tables takes a full-table ACCESS EXCLUSIVE lock: the constraint is
-- enforced on every INSERT and UPDATE from this statement on, which is exactly
-- and only what the criterion asks for.
ALTER TABLE "BookingGuest" ADD CONSTRAINT "BookingGuest_price_nonnegative" CHECK ("priceCents" >= 0) NOT VALID;
ALTER TABLE "BookingGuestNight" ADD CONSTRAINT "BookingGuestNight_price_nonnegative" CHECK ("priceCents" >= 0) NOT VALID;
