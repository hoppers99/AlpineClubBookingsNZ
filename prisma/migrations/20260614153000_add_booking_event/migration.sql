-- Durable booking-lifecycle event store (issue #740).
-- One row per transition (created, paid, confirmed, bumped, cancelled,
-- refunded, credited). Unlike AuditLog these rows are never retention-pruned,
-- so booking and payment-link narratives survive audit-log pruning.

-- CreateEnum
CREATE TYPE "BookingEventType" AS ENUM ('CREATED', 'MEMBER_PAID', 'NON_MEMBER_CONFIRMED', 'BUMPED', 'CANCELLED', 'REFUNDED', 'CREDITED');

-- CreateTable
CREATE TABLE "BookingEvent" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "type" "BookingEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorMemberId" TEXT,
    "amountCents" INTEGER,
    "reason" VARCHAR(500),
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingEvent_bookingId_occurredAt_idx" ON "BookingEvent"("bookingId", "occurredAt");

-- CreateIndex
CREATE INDEX "BookingEvent_type_idx" ON "BookingEvent"("type");

-- AddForeignKey
-- Restrict (not Cascade): no-cascade-off-Booking design. The only hard-delete
-- path (draft cleanup) deletes BookingEvents explicitly first.
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
