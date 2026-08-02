-- #2284 (S2): personal opt-out for the "a family member added you to a booking"
-- FYI notification. Defaults on, so existing members keep receiving it until
-- they choose otherwise. Timestamp deliberately above 20260802160000 (#2364's
-- current-highest, on an unmerged branch) to avoid a prefix clash; see the
-- #2284 close-out note on migration coordination.
ALTER TABLE "NotificationPreference"
  ADD COLUMN "bookingAddedByFamily" BOOLEAN NOT NULL DEFAULT true;
