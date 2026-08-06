-- Club-wide Google Analytics configuration singleton (#2573).
--
-- Purely additive EXPAND: one brand-new, empty table. No row is seeded — every
-- reader synthesises the code defaults on a miss and fails closed, so the shipped
-- state is "analytics not configured" until an admin saves a measurement ID under
-- Admin -> Integrations. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the full
-- blue/green analysis.
CREATE TABLE "AnalyticsSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "measurementId" TEXT,
    "consentBannerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "bannerMessage" TEXT,
    "consentRevision" INTEGER NOT NULL DEFAULT 1,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsSettings_updatedByMemberId_idx" ON "AnalyticsSettings"("updatedByMemberId");
