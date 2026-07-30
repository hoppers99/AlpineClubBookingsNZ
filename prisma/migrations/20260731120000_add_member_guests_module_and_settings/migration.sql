-- #2306 (epic #2305, "+ Add Member Guest" MG1): the memberGuests module flag
-- and the member-guest policy singleton.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds ONE constant-defaulted boolean column to the cold ClubModuleSettings
--    catalog singleton: ADD COLUMN "memberGuests" NOT NULL DEFAULT false. A
--    metadata-only ADD COLUMN with a constant default — no table rewrite, no
--    row scan, brief ACCESS EXCLUSIVE lock on a one-row table;
--  * creates ONE brand-new cold settings singleton table
--    ("MemberGuestSettings") with a plain btree index and NO foreign key
--    (updatedByMemberId is deliberately a plain string, the same shape as
--    BookingRequestSettings.updatedByMemberId, so nothing here references
--    Member and the FK case of HOT_TABLE_SQL_REGEX is not tripped).
--
-- Purely additive / expand-safe: the previously deployed (old-colour) Prisma
-- client has no MemberGuestSettings model and never reads the new module column
-- (every ClubModuleSettings read is narrowed by
-- CLUB_MODULE_SETTINGS_COLUMN_SELECT), so it keeps working unchanged through
-- the migrate -> cutover drain. No enum change, no DROP, no RENAME, no
-- ALTER COLUMN TYPE / SET NOT NULL on existing data, no backfill DML, no
-- session-clock DML, and no provider call. NO settings row is seeded: the
-- singleton is created lazily on the first WRITE, and every read synthesises
-- the schema defaults on a miss without materialising anything (reading is not
-- what creates the row — that distinction matters because several
-- setup-readiness signals key on row existence).

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN     "memberGuests" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MemberGuestSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "approvalRequired" BOOLEAN NOT NULL DEFAULT true,
    "pendingHoldExpiryDays" INTEGER NOT NULL DEFAULT 7,
    "openMemberSearchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "openMemberSearchIncludesMinors" BOOLEAN NOT NULL DEFAULT false,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberGuestSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberGuestSettings_updatedByMemberId_idx" ON "MemberGuestSettings"("updatedByMemberId");
