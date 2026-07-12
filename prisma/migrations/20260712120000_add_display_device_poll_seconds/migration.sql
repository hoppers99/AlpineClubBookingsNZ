-- Per-device display polling interval (LTV-039, issue #85; consolidates #66):
-- an optional per-device override for the lobby display's state-poll cadence in
-- seconds. NULL keeps the client default (~60s). The value is clamped
-- server-side (15–600) on both read and write. The state poll doubles as the
-- device heartbeat, so this column also governs how often "last seen" refreshes.
--
-- Additive, nullable ADD COLUMN with no default: a metadata-only catalog change
-- taking a brief lock with no table rewrite and no row scan. The previously
-- deployed colour has no model field for the column and never reads or writes
-- it (old_code_compatible = yes trivially).

-- AlterTable
ALTER TABLE "LodgeDisplayDevice" ADD COLUMN     "pollSeconds" INTEGER;
