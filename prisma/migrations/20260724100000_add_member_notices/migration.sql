-- Member Notices / Recent News (memberNotices module).
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * CREATE TYPE "NoticeStatus" and "NoticeAudienceKind" (two catalog-only enum
--    registrations touching no existing table);
--  * CREATE TABLE "Notice", "NoticeAudience", "NoticeReadReceipt" (three
--    brand-new cold tables) with plain btree indexes, one @@unique
--    ([noticeId, memberId]) on NoticeReadReceipt, and foreign keys to
--    Member/MembershipType/Lodge/CommitteeRole (SetNull for the Notice
--    creator/updater audit pointers; Cascade for the audience-target and
--    receipt relations so a deleted target/member cannot leave a stale row that
--    widens visibility — the audience columns fail closed);
--  * ALTER TABLE "ClubModuleSettings" ADD COLUMN "memberNotices" BOOLEAN NOT
--    NULL DEFAULT true — a PostgreSQL metadata-only ADD COLUMN with a constant
--    default (no table rewrite), on the cold ClubModuleSettings catalog
--    singleton, taking a brief ACCESS EXCLUSIVE lock.
--  Purely additive / expand-safe: the previously deployed (old-colour) Prisma
--  client has no Notice* models (never reads/writes the new tables) and reads
--  ClubModuleSettings only through CLUB_MODULE_SETTINGS_COLUMN_SELECT, which
--  does not name the new column, so the added flag is invisible to it and
--  defaults true. No DROP, no RENAME, no ALTER COLUMN TYPE / SET NOT NULL on
--  existing data, no backfill DML, no session-clock DML, and no provider call.
--  All three new tables are absent from HOT_TABLE_SQL_REGEX; the FKs reference
--  Member/MembershipType/Lodge/CommitteeRole but the referencing tables are
--  brand-new/empty, so no lock is taken on the referenced hot rows beyond the
--  brief validation of an empty child table. The new-colour runtime is the only
--  reader/writer. Forward-only expand: dropping the tables/column on rollback
--  only discards notices and their read receipts.

-- CreateEnum
CREATE TYPE "NoticeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "NoticeAudienceKind" AS ENUM ('ALL_MEMBERS', 'MEMBER', 'MEMBERSHIP_TYPE', 'LODGE', 'COMMITTEE_ROLE');

-- CreateTable
CREATE TABLE "Notice" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "status" "NoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "requiresAcknowledgement" BOOLEAN NOT NULL DEFAULT false,
    "financialMembersOnly" BOOLEAN NOT NULL DEFAULT false,
    "emailedAt" TIMESTAMP(3),
    "createdByMemberId" TEXT,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoticeAudience" (
    "id" TEXT NOT NULL,
    "noticeId" TEXT NOT NULL,
    "kind" "NoticeAudienceKind" NOT NULL,
    "memberId" TEXT,
    "membershipTypeId" TEXT,
    "lodgeId" TEXT,
    "committeeRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoticeAudience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoticeReadReceipt" (
    "id" TEXT NOT NULL,
    "noticeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "NoticeReadReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notice_status_publishedAt_idx" ON "Notice"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "Notice_createdByMemberId_idx" ON "Notice"("createdByMemberId");

-- CreateIndex
CREATE INDEX "Notice_updatedByMemberId_idx" ON "Notice"("updatedByMemberId");

-- CreateIndex
CREATE INDEX "NoticeAudience_noticeId_idx" ON "NoticeAudience"("noticeId");

-- CreateIndex
CREATE INDEX "NoticeAudience_memberId_idx" ON "NoticeAudience"("memberId");

-- CreateIndex
CREATE INDEX "NoticeAudience_membershipTypeId_idx" ON "NoticeAudience"("membershipTypeId");

-- CreateIndex
CREATE INDEX "NoticeAudience_lodgeId_idx" ON "NoticeAudience"("lodgeId");

-- CreateIndex
CREATE INDEX "NoticeAudience_committeeRoleId_idx" ON "NoticeAudience"("committeeRoleId");

-- CreateIndex
CREATE INDEX "NoticeReadReceipt_noticeId_readAt_idx" ON "NoticeReadReceipt"("noticeId", "readAt");

-- CreateIndex
CREATE INDEX "NoticeReadReceipt_memberId_idx" ON "NoticeReadReceipt"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "NoticeReadReceipt_noticeId_memberId_key" ON "NoticeReadReceipt"("noticeId", "memberId");

-- AddForeignKey
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_createdByMemberId_fkey" FOREIGN KEY ("createdByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_updatedByMemberId_fkey" FOREIGN KEY ("updatedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeAudience" ADD CONSTRAINT "NoticeAudience_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeAudience" ADD CONSTRAINT "NoticeAudience_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeAudience" ADD CONSTRAINT "NoticeAudience_membershipTypeId_fkey" FOREIGN KEY ("membershipTypeId") REFERENCES "MembershipType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeAudience" ADD CONSTRAINT "NoticeAudience_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeAudience" ADD CONSTRAINT "NoticeAudience_committeeRoleId_fkey" FOREIGN KEY ("committeeRoleId") REFERENCES "CommitteeRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeReadReceipt" ADD CONSTRAINT "NoticeReadReceipt_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeReadReceipt" ADD CONSTRAINT "NoticeReadReceipt_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN "memberNotices" BOOLEAN NOT NULL DEFAULT true;
