-- B5 (#2262): manual mark-paid provenance for booking payments (cash /
-- off-Xero bank transfer) + the durable hand-back task a cash cancellation
-- raises.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds four nullable columns (no defaults, no backfill) plus one btree index
--    and one SetNull foreign key to Payment,
--  * registers the new "ManualRefundTaskStatus" enum type,
--  * creates the brand-new, empty "ManualRefundTask" table with its indexes and
--    foreign keys.
-- Nothing is dropped, renamed, retyped or backfilled. NULL provenance means
-- "not manually settled", so every existing Payment row is semantically
-- unchanged and the old colour — which never names these columns — keeps
-- behaving exactly as before.
--
-- Timestamp coordination: this sorts strictly after
-- 20260727120000_add_booking_no_emails (#2258) and strictly after #2265's
-- reserved 20260729120000_add_booking_credit_election — this migration's
-- prefix was moved from 120000 to 180000 precisely to avoid colliding with it
-- (the duplicate-prefix ratchet in scripts/check-migration-safety-coverage.sh
-- turns main red on the second merge of a shared prefix). #2263's and #2286's
-- reserved migrations must each choose a strictly later timestamp than this
-- one.

-- Manual settlement provenance. Nullable with no default, so the ADD COLUMNs
-- are PostgreSQL catalog-only adds (no table rewrite, no row scan) even though
-- Payment is a hot table; each takes a brief ACCESS EXCLUSIVE lock.
-- "manuallyMarkedPaidAt IS NOT NULL" alone is the provenance predicate: a Xero
-- id stamped later by an out-of-loop stamper must never launder it away.
ALTER TABLE "Payment" ADD COLUMN "manuallyMarkedPaidAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "manuallyMarkedPaidByMemberId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "manualPaymentNote" VARCHAR(500);
ALTER TABLE "Payment" ADD COLUMN "manuallyMarkedPaidPreviousStatus" "BookingStatus";

-- Audit FK + its index for the "who recorded it" column, mirroring the
-- MemberSubscription.manuallyMarkedPaidByMemberId shape from #1944. Every
-- existing row has the column NULL, so FK validation matches nothing.
CREATE INDEX "Payment_manuallyMarkedPaidByMemberId_idx" ON "Payment"("manuallyMarkedPaidByMemberId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_manuallyMarkedPaidByMemberId_fkey" FOREIGN KEY ("manuallyMarkedPaidByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The hand-back queue. A brand-new type and a brand-new empty table, so the
-- CREATE TYPE is a catalog-only registration and every index/FK build below is
-- against zero rows.
CREATE TYPE "ManualRefundTaskStatus" AS ENUM ('OPEN', 'COMPLETED', 'DISMISSED');

CREATE TABLE "ManualRefundTask" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "ManualRefundTaskStatus" NOT NULL DEFAULT 'OPEN',
    "completedByMemberId" TEXT,
    "completedAt" TIMESTAMP(3),
    "note" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualRefundTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ManualRefundTask_status_idx" ON "ManualRefundTask"("status");
CREATE INDEX "ManualRefundTask_bookingId_idx" ON "ManualRefundTask"("bookingId");
CREATE INDEX "ManualRefundTask_paymentId_idx" ON "ManualRefundTask"("paymentId");
CREATE INDEX "ManualRefundTask_completedByMemberId_idx" ON "ManualRefundTask"("completedByMemberId");

-- Restrict off Booking/Payment so a booking or payment carrying an unresolved
-- hand-back task can never be hard-deleted out from under it; SetNull off
-- Member so deleting the closing admin clears the pointer rather than blocking.
ALTER TABLE "ManualRefundTask" ADD CONSTRAINT "ManualRefundTask_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualRefundTask" ADD CONSTRAINT "ManualRefundTask_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualRefundTask" ADD CONSTRAINT "ManualRefundTask_completedByMemberId_fkey" FOREIGN KEY ("completedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
