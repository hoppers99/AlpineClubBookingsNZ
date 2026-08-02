-- #2525: provisional per-night capacity reservations for HELD booking-policy
-- exception requests (BookingChangeRequest kind = POLICY_EXCEPTION).
--
-- Purely additive EXPAND. One brand-new table plus its two indexes and two
-- foreign keys, all referencing objects that already exist. Nothing is dropped,
-- rewritten, or backfilled. The table is created EMPTY: a reservation row is
-- only ever written by the new colour's request-hold path and only ever read by
-- the new colour's capacity calculation, so a draining old colour — which knows
-- neither the table nor the Prisma model — writes and reads occupancy exactly as
-- it did before this migration (its capacity query never joins this table).
--
-- The CREATE TABLE and its indexes lock only the objects created here. The two
-- FKs take a brief SHARE ROW EXCLUSIVE lock on BookingChangeRequest and Lodge to
-- validate; because the new table is empty the validation scan checks nothing.
-- No booking, capacity, money, allocation, provider, or session-clock write
-- occurs. Run in the normal deploy window.

CREATE TABLE "PolicyExceptionReservationNight" (
    "id" TEXT NOT NULL,
    "changeRequestId" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "night" DATE NOT NULL,
    "beds" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyExceptionReservationNight_pkey" PRIMARY KEY ("id")
);

-- One reservation row per (request, night): the footprint is a set of nights.
CREATE UNIQUE INDEX "PolicyExceptionReservationNight_changeRequestId_night_key"
    ON "PolicyExceptionReservationNight"("changeRequestId", "night");

-- The canonical capacity read sums beds for one lodge across a night window.
CREATE INDEX "PolicyExceptionReservationNight_lodgeId_night_idx"
    ON "PolicyExceptionReservationNight"("lodgeId", "night");

-- Cascade from the owning request: normal operation deletes the rows in the
-- terminal/approval transaction, but a cascade means a (never-in-practice)
-- request delete can never strand an orphan reservation.
ALTER TABLE "PolicyExceptionReservationNight"
    ADD CONSTRAINT "PolicyExceptionReservationNight_changeRequestId_fkey"
    FOREIGN KEY ("changeRequestId") REFERENCES "BookingChangeRequest"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT on the lodge: a lodge with live reservations cannot be deleted out
-- from under the capacity view, matching Booking.lodgeId's non-null discipline.
ALTER TABLE "PolicyExceptionReservationNight"
    ADD CONSTRAINT "PolicyExceptionReservationNight_lodgeId_fkey"
    FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
