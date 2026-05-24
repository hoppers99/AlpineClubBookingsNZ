-- Add archive as a second governed member lifecycle action.
ALTER TYPE "MemberLifecycleAction" ADD VALUE 'ARCHIVE';

-- Add archive metadata to member records. The lifecycle request table already
-- exists from the delete lifecycle migration, and memberId intentionally has no
-- FK so approved delete request snapshots can outlive the deleted member row.
ALTER TABLE "Member"
ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "archivedReason" TEXT,
ADD COLUMN "archivedViaLifecycleActionRequestId" TEXT;

CREATE INDEX "Member_archivedViaLifecycleActionRequestId_idx" ON "Member"("archivedViaLifecycleActionRequestId");

CREATE INDEX "Member_archivedAt_idx" ON "Member"("archivedAt");

ALTER TABLE "Member"
ADD CONSTRAINT "Member_archivedViaLifecycleActionRequestId_fkey"
FOREIGN KEY ("archivedViaLifecycleActionRequestId")
REFERENCES "MemberLifecycleActionRequest"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
