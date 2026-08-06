ALTER TABLE "HostingCoverageIncident"
ADD COLUMN "ownerNotificationClaimStateKey" VARCHAR(300),
ADD COLUMN "ownerNotificationClaimedAt" TIMESTAMP(3);
