-- CreateEnum
CREATE TYPE "DisplayTemplateSource" AS ENUM ('BUILT_IN_OVERRIDE', 'CUSTOM');

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN     "lobbyDisplay" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Lodge" ADD COLUMN     "displayConfig" JSONB;

-- CreateTable
CREATE TABLE "DisplayTemplate" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "source" "DisplayTemplateSource" NOT NULL,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisplayTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LodgeDisplayDevice" (
    "id" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "pairingCode" VARCHAR(16),
    "pairingCodeExpiresAt" TIMESTAMP(3),
    "tokenHash" TEXT,
    "templateId" TEXT,
    "regionConfig" JSONB,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LodgeDisplayDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisplayTemplate_key_key" ON "DisplayTemplate"("key");

-- CreateIndex
CREATE UNIQUE INDEX "LodgeDisplayDevice_tokenHash_key" ON "LodgeDisplayDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "LodgeDisplayDevice_lodgeId_idx" ON "LodgeDisplayDevice"("lodgeId");

-- CreateIndex
CREATE INDEX "LodgeDisplayDevice_templateId_idx" ON "LodgeDisplayDevice"("templateId");

-- AddForeignKey
ALTER TABLE "LodgeDisplayDevice" ADD CONSTRAINT "LodgeDisplayDevice_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LodgeDisplayDevice" ADD CONSTRAINT "LodgeDisplayDevice_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DisplayTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

