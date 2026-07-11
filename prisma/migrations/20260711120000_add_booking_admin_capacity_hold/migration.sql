-- Admin capacity hold (#1764): nullable who/when columns on Booking. While
-- adminCapacityHoldAt is set AND the booking is PAYMENT_PENDING, the booking
-- consumes lodge capacity (capacityHoldingBookingFilter grows the disjunct).
-- Expand-only: nullable ADD COLUMNs, an index over the new all-NULL column,
-- and a SET NULL FK to Member.

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "adminCapacityHoldAt" TIMESTAMP(3),
ADD COLUMN     "adminCapacityHoldByMemberId" TEXT;

-- CreateIndex
CREATE INDEX "Booking_adminCapacityHoldByMemberId_idx" ON "Booking"("adminCapacityHoldByMemberId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_adminCapacityHoldByMemberId_fkey" FOREIGN KEY ("adminCapacityHoldByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
