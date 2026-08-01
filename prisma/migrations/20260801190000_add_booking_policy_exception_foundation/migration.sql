-- #2363 booking-policy exception foundation.
--
-- Both columns are additive and carry constant defaults so PostgreSQL can
-- populate every existing MinimumStayPolicy row without a table rewrite.
-- HOLD is the owner-decided migration value for every existing policy. The
-- capacityMode default remains solely so the draining pre-#2363 colour can
-- still create a row during blue/green cutover; the new API requires callers
-- to submit the mode explicitly and never relies on this default.
CREATE TYPE "PolicyExceptionCapacityMode" AS ENUM ('HOLD', 'NO_HOLD');

ALTER TABLE "MinimumStayPolicy"
    ADD COLUMN "capacityMode" "PolicyExceptionCapacityMode" NOT NULL DEFAULT 'HOLD',
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
