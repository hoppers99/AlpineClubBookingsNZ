-- Maintenance reports (#2780): a member, or anyone standing in the lodge with a
-- phone, tells the maintenance officer that something is broken.
--
-- PURELY ADDITIVE EXPAND. Three new enum types, four brand-new empty tables, one
-- defaulted BOOLEAN column on the ClubModuleSettings singleton, and one
-- INSERT ... VALUES seeding the starter question set. Nothing is renamed,
-- retyped, dropped or repurposed, and no existing row's values are rewritten.
-- See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the blue/green analysis.
--
-- NOT DATA-REWRITING: the only DML is a five-row INSERT ... VALUES with
-- ON CONFLICT DO NOTHING. There is no SELECT anywhere in it and no DO UPDATE, so
-- it can only ADD rows to a table this migration just created and can never
-- alter or delete anything a club has typed.
--
-- NO SESSION CLOCK IN A PAYLOAD: the INSERT names no timestamp column at all;
-- createdAt/updatedAt come from the columns' own DDL defaults, which the #1627
-- gate explicitly permits.

-- CreateEnum
CREATE TYPE "MaintenanceQuestionType" AS ENUM ('SHORT_TEXT', 'LONG_TEXT', 'YES_NO', 'SINGLE_CHOICE');

-- CreateEnum
CREATE TYPE "MaintenanceReportSource" AS ENUM ('MEMBER_PORTAL', 'LODGE_QR');

-- CreateEnum
CREATE TYPE "MaintenanceReportStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN     "maintenanceReports" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "adminMaintenanceReport" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "MaintenanceReportSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "anonymousReportsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "photosEnabled" BOOLEAN NOT NULL DEFAULT true,
    "anonymousPhotosEnabled" BOOLEAN NOT NULL DEFAULT true,
    "photoRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "anonymousContactPrompt" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedByMemberId" TEXT,

    CONSTRAINT "MaintenanceReportSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceReportQuestion" (
    "id" TEXT NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "helpText" VARCHAR(300),
    "type" "MaintenanceQuestionType" NOT NULL DEFAULT 'SHORT_TEXT',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "choices" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceReportQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceReport" (
    "id" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "source" "MaintenanceReportSource" NOT NULL,
    "status" "MaintenanceReportStatus" NOT NULL DEFAULT 'OPEN',
    "memberId" TEXT,
    "reporterName" VARCHAR(120),
    "reporterContact" VARCHAR(200),
    "summary" VARCHAR(200) NOT NULL,
    "photoDataUrl" TEXT,
    "photoContentType" VARCHAR(40),
    "photoCapturedAt" TIMESTAMP(3),
    "photoExpiresAt" TIMESTAMP(3),
    "photoDeletedAt" TIMESTAMP(3),
    "photoDeletedById" TEXT,
    "photoDeleteReason" VARCHAR(300),
    "submitterIpHash" VARCHAR(64),
    "submitterIpHashExpiresAt" TIMESTAMP(3),
    "submitterIpHashDeletedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceReportAnswer" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "questionId" TEXT,
    "questionLabel" VARCHAR(200) NOT NULL,
    "questionType" "MaintenanceQuestionType" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "answerText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceReportAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LodgeMaintenanceReportToken" (
    "id" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "rotatedById" TEXT,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "LodgeMaintenanceReportToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaintenanceReportQuestion_active_sortOrder_idx" ON "MaintenanceReportQuestion"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "MaintenanceReport_lodgeId_status_createdAt_idx" ON "MaintenanceReport"("lodgeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MaintenanceReport_status_createdAt_idx" ON "MaintenanceReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MaintenanceReport_createdAt_idx" ON "MaintenanceReport"("createdAt");

-- CreateIndex
CREATE INDEX "MaintenanceReport_memberId_createdAt_idx" ON "MaintenanceReport"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "MaintenanceReport_photoExpiresAt_idx" ON "MaintenanceReport"("photoExpiresAt");

-- CreateIndex
CREATE INDEX "MaintenanceReport_submitterIpHashExpiresAt_idx" ON "MaintenanceReport"("submitterIpHashExpiresAt");

-- CreateIndex
CREATE INDEX "MaintenanceReportAnswer_reportId_sortOrder_idx" ON "MaintenanceReportAnswer"("reportId", "sortOrder");

-- CreateIndex
CREATE INDEX "MaintenanceReportAnswer_questionId_idx" ON "MaintenanceReportAnswer"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "LodgeMaintenanceReportToken_lodgeId_key" ON "LodgeMaintenanceReportToken"("lodgeId");

-- CreateIndex
CREATE UNIQUE INDEX "LodgeMaintenanceReportToken_tokenHash_key" ON "LodgeMaintenanceReportToken"("tokenHash");

-- AddForeignKey
ALTER TABLE "MaintenanceReport" ADD CONSTRAINT "MaintenanceReport_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceReport" ADD CONSTRAINT "MaintenanceReport_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceReportAnswer" ADD CONSTRAINT "MaintenanceReportAnswer_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "MaintenanceReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceReportAnswer" ADD CONSTRAINT "MaintenanceReportAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "MaintenanceReportQuestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LodgeMaintenanceReportToken" ADD CONSTRAINT "LodgeMaintenanceReportToken_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Starter question set.
--
-- SEED DEFAULT, not club data. Every string is deliberately generic — no club,
-- lodge, place or equipment name appears — because this repository is the
-- product and not one club's site (INV-CONFIG-001). An admin edits, reorders,
-- adds to or deactivates all five under Admin -> Lodge -> Maintenance reports.
--
-- Seeded HERE rather than in prisma/seed.ts on purpose: seed.ts runs on a fresh
-- install only, and an existing club upgrading into this release would otherwise
-- meet an empty form. The ids are fixed literals so a re-run is a no-op.
INSERT INTO "MaintenanceReportQuestion" ("id", "label", "helpText", "type", "required", "choices", "sortOrder", "active")
VALUES
  ('mtnq_starter_where', 'Where in the lodge is it?', 'For example: the room, the bathroom, the kitchen, outside.', 'SHORT_TEXT', true, ARRAY[]::TEXT[], 10, true),
  ('mtnq_starter_what', 'What is wrong?', 'Describe what you saw or what is not working.', 'LONG_TEXT', true, ARRAY[]::TEXT[], 20, true),
  ('mtnq_starter_urgency', 'How urgent is it?', NULL, 'SINGLE_CHOICE', true, ARRAY['Can wait for the next work party', 'Should be fixed this season', 'Needs attention now']::TEXT[], 30, true),
  ('mtnq_starter_safety', 'Is anyone at risk of being hurt?', 'Choose yes if this needs attention before the next guests arrive.', 'YES_NO', true, ARRAY[]::TEXT[], 40, true),
  ('mtnq_starter_other', 'Anything else the maintenance officer should know?', NULL, 'LONG_TEXT', false, ARRAY[]::TEXT[], 50, true)
ON CONFLICT ("id") DO NOTHING;
