-- #2263: member attribution for the authenticated whole-lodge request
-- front-door. A signed-in member can now ask for sole occupancy of the lodge;
-- the resulting BookingRequest needs to know WHICH member owns it so
-- "My requests", the withdraw authorisation check, the per-member open-request
-- cap and the admin "Member" badge can all key on one column.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * one nullable column on BookingRequest (no default, metadata-only add),
--  * one composite btree index,
--  * one nullable foreign key to Member (ON DELETE SET NULL).
-- Nothing is dropped, renamed, retyped or backfilled.
--
-- Timestamp coordination (Prisma applies migrations in lexical directory order,
-- so two branches must never claim the same stamp). Concurrently open branches
-- at the time of writing: #2265 20260729120000, #2262 20260729180000, #2322
-- 20260730120000 + 20260730130000, and #2306 (MG1) 20260731120000 +
-- 20260731120100. This migration is stamped 20260730140000 — strictly after
-- every stamp already claimed on 2026-07-30 and strictly before MG1's
-- 2026-07-31 pair, so it is unique and its ordering is stable whichever of
-- those branches lands first.

ALTER TABLE "BookingRequest" ADD COLUMN "requestedByMemberId" TEXT;

-- "My requests" reads by member; the open-request cap counts a member's
-- non-terminal rows. Both are (member, status) lookups.
CREATE INDEX "BookingRequest_requestedByMemberId_status_idx" ON "BookingRequest"("requestedByMemberId", "status");

-- Attribution FK, matching the shape every other nullable member back-reference
-- uses (see 20260714000000_add_exclusive_hold_fields). Every existing row has
-- the column NULL, so the constraint validates against nothing.
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_requestedByMemberId_fkey" FOREIGN KEY ("requestedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
