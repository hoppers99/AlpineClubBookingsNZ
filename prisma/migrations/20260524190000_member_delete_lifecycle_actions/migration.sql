-- CreateEnum
CREATE TYPE "MemberLifecycleAction" AS ENUM ('DELETE');

-- CreateEnum
CREATE TYPE "MemberLifecycleActionRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "MemberLifecycleActionRequest" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "action" "MemberLifecycleAction" NOT NULL,
    "status" "MemberLifecycleActionRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "reviewNote" TEXT,
    "memberSnapshot" JSONB,
    "requestedByMemberId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByMemberId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberLifecycleActionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberLifecycleActionRequest_memberId_action_status_idx" ON "MemberLifecycleActionRequest"("memberId", "action", "status");

-- CreateIndex
CREATE INDEX "MemberLifecycleActionRequest_requestedByMemberId_idx" ON "MemberLifecycleActionRequest"("requestedByMemberId");

-- CreateIndex
CREATE INDEX "MemberLifecycleActionRequest_reviewedByMemberId_idx" ON "MemberLifecycleActionRequest"("reviewedByMemberId");

-- CreateIndex
CREATE INDEX "MemberLifecycleActionRequest_status_requestedAt_idx" ON "MemberLifecycleActionRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "MemberLifecycleActionRequest_action_status_idx" ON "MemberLifecycleActionRequest"("action", "status");

-- AddForeignKey
ALTER TABLE "MemberLifecycleActionRequest" ADD CONSTRAINT "MemberLifecycleActionRequest_requestedByMemberId_fkey" FOREIGN KEY ("requestedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberLifecycleActionRequest" ADD CONSTRAINT "MemberLifecycleActionRequest_reviewedByMemberId_fkey" FOREIGN KEY ("reviewedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
