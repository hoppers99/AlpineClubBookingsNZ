-- Reciprocal "other club member" rate on a booking (Other Lodges epic,
-- follow-up to #2749).
--
--  * Booking gains a nullable "otherLodgeId" FK to the existing OtherLodge
--    registry: the partner lodge a booking officer names on the edit screen.
--  * BookingGuest gains "otherLodgeMember", the per-person opt-in that prices a
--    NON-MEMBER guest from the club's own FULL member rate rows instead of
--    NON_MEMBER's. It changes the RATE only: "isMember" stays false, so hosting,
--    the non-member hold, split bookings and the subscription gate are untouched.
--
-- ADDITIVE EXPAND ONLY. Both columns are nullable or carry a constant NOT NULL
-- DEFAULT (catalog-only on modern PostgreSQL, no heap rewrite), there is no DML,
-- and the draining old colour neither selects nor writes either column.

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "otherLodgeId" TEXT;

-- AlterTable
ALTER TABLE "BookingGuest" ADD COLUMN     "otherLodgeMember" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Booking_otherLodgeId_idx" ON "Booking"("otherLodgeId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_otherLodgeId_fkey" FOREIGN KEY ("otherLodgeId") REFERENCES "OtherLodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
