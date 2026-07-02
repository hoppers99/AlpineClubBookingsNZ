-- CreateEnum
CREATE TYPE "TwoFactorMethod" AS ENUM ('TOTP', 'EMAIL');

-- AlterTable
ALTER TABLE "ClubModuleSettings"
  ADD COLUMN "twoFactor" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Member"
  ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "twoFactorMethod" "TwoFactorMethod",
  ADD COLUMN "totpSecret" TEXT,
  ADD COLUMN "twoFactorEnrolledAt" TIMESTAMP(3),
  ADD COLUMN "twoFactorFailedAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "twoFactorLockedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TwoFactorEmailCode" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "used" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TwoFactorEmailCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactorRecoveryCode" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TwoFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorEmailCode_codeHash_key" ON "TwoFactorEmailCode"("codeHash");
CREATE INDEX "TwoFactorEmailCode_memberId_idx" ON "TwoFactorEmailCode"("memberId");
CREATE INDEX "TwoFactorEmailCode_codeHash_idx" ON "TwoFactorEmailCode"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorRecoveryCode_codeHash_key" ON "TwoFactorRecoveryCode"("codeHash");
CREATE INDEX "TwoFactorRecoveryCode_memberId_idx" ON "TwoFactorRecoveryCode"("memberId");
CREATE INDEX "TwoFactorRecoveryCode_codeHash_idx" ON "TwoFactorRecoveryCode"("codeHash");
CREATE INDEX "TwoFactorRecoveryCode_usedAt_idx" ON "TwoFactorRecoveryCode"("usedAt");

-- CreateIndex
CREATE INDEX "Member_twoFactorEnabled_idx" ON "Member"("twoFactorEnabled");
CREATE INDEX "Member_twoFactorLockedUntil_idx" ON "Member"("twoFactorLockedUntil");

-- AddForeignKey
ALTER TABLE "TwoFactorEmailCode"
  ADD CONSTRAINT "TwoFactorEmailCode_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorRecoveryCode"
  ADD CONSTRAINT "TwoFactorRecoveryCode_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
