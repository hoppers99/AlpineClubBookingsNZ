-- Admin review workflow for bookings flagged by the no-adult rule.
-- Introduces AWAITING_REVIEW BookingStatus, AdminReviewStatus enum, and the
-- supporting fields on Booking. Backfills existing flagged rows into the
-- new queue.

-- 1. New enum values.
ALTER TYPE "BookingStatus" ADD VALUE 'AWAITING_REVIEW';

CREATE TYPE "AdminReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- 2. New columns on Booking.
ALTER TABLE "Booking"
  ADD COLUMN "memberReviewJustification" VARCHAR(1000),
  ADD COLUMN "adminReviewStatus" "AdminReviewStatus",
  ADD COLUMN "adminReviewNotes" VARCHAR(2000),
  ADD COLUMN "adminReviewedById" TEXT,
  ADD COLUMN "adminReviewedAt" TIMESTAMP(3);

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_adminReviewedById_fkey"
  FOREIGN KEY ("adminReviewedById") REFERENCES "Member"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Booking_adminReviewStatus_createdAt_idx"
  ON "Booking" ("adminReviewStatus", "createdAt");
CREATE INDEX "Booking_adminReviewedById_idx"
  ON "Booking" ("adminReviewedById");

-- 3. Backfill existing flagged rows.
-- Branch A: flagged rows that already paid (PAID/CONFIRMED, or have a
-- SUCCEEDED Payment row) were valid under the old rules. Mark them
-- auto-approved so they do not appear in the new review queue.
UPDATE "Booking" b
SET "adminReviewStatus" = 'APPROVED',
    "adminReviewNotes"  = 'Auto-approved during admin-review rollout (payment already taken).',
    "adminReviewedAt"   = NOW()
WHERE b."requiresAdminReview" = TRUE
  AND (
    b."status" IN ('PAID', 'CONFIRMED', 'COMPLETED')
    OR EXISTS (
      SELECT 1 FROM "Payment" p
      WHERE p."bookingId" = b."id" AND p."status" = 'SUCCEEDED'
    )
  );

-- Branch B: flagged rows still awaiting payment (PAYMENT_PENDING with no
-- successful payment). Move into AWAITING_REVIEW + PENDING so admins must
-- decide before payment can proceed.
UPDATE "Booking" b
SET "status" = 'AWAITING_REVIEW',
    "adminReviewStatus" = 'PENDING'
WHERE b."requiresAdminReview" = TRUE
  AND b."status" = 'PAYMENT_PENDING'
  AND b."adminReviewStatus" IS NULL;

-- Branch C: any remaining flagged rows in other states (PENDING, DRAFT,
-- WAITLISTED, etc.) get adminReviewStatus = PENDING but keep their status.
-- Admins will see them in the queue and can act when the booking progresses.
UPDATE "Booking" b
SET "adminReviewStatus" = 'PENDING'
WHERE b."requiresAdminReview" = TRUE
  AND b."adminReviewStatus" IS NULL;
