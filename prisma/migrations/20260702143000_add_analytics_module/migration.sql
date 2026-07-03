-- Add the admin activation flag for consent-gated Google Analytics.
ALTER TABLE "ClubModuleSettings"
  ADD COLUMN "analytics" BOOLEAN NOT NULL DEFAULT false;
