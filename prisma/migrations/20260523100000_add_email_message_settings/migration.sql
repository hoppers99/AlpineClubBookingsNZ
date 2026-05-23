CREATE TABLE "EmailMessageSetting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "clubName" TEXT,
    "bookingsName" TEXT,
    "lodgeName" TEXT,
    "emailFromName" TEXT,
    "supportEmail" TEXT,
    "contactEmail" TEXT,
    "publicUrl" TEXT,
    "lodgeTravelNote" TEXT,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailMessageSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailTemplateOverride" (
    "id" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "subject" TEXT,
    "bodyText" TEXT,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailTemplateOverride_pkey" PRIMARY KEY ("id")
);

CREATE TYPE "NotificationDeliveryMode" AS ENUM ('ALWAYS', 'CONTENT_ONLY', 'DISABLED');

CREATE TABLE "NotificationDeliveryPolicy" (
    "id" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "mode" "NotificationDeliveryMode" NOT NULL DEFAULT 'ALWAYS',
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationDeliveryPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailMessageSetting_updatedByMemberId_idx" ON "EmailMessageSetting"("updatedByMemberId");
CREATE UNIQUE INDEX "EmailTemplateOverride_templateName_key" ON "EmailTemplateOverride"("templateName");
CREATE INDEX "EmailTemplateOverride_updatedByMemberId_idx" ON "EmailTemplateOverride"("updatedByMemberId");
CREATE UNIQUE INDEX "NotificationDeliveryPolicy_templateName_key" ON "NotificationDeliveryPolicy"("templateName");
CREATE INDEX "NotificationDeliveryPolicy_updatedByMemberId_idx" ON "NotificationDeliveryPolicy"("updatedByMemberId");
CREATE INDEX "NotificationDeliveryPolicy_mode_idx" ON "NotificationDeliveryPolicy"("mode");
