-- Alpine Central Server (ServerNZ) integration.
--
--  * ClubModuleSettings gains the `alpineCentralServer` module flag. Metadata-only
--    ADD COLUMN with a constant NOT NULL DEFAULT false — safe/instant on Postgres
--    and blue/green compatible (older readers ignore the unknown column; the
--    column-select is derived from MODULE_KEYS so no reader names it until this
--    release ships).
--  * ServerNzSettings: a singleton (id = 'default') holding the NON-secret
--    connection settings — base URL, per-shared-item enable flags, and last-sync
--    bookkeeping. The API key is NOT stored here; it lives encrypted in
--    IntegrationCredential (provider 'servernz').

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN     "alpineCentralServer" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ServerNzSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "baseUrl" VARCHAR(500),
    "otherLodgesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "otherLodgesLastUploadAt" TIMESTAMP(3),
    "otherLodgesLastDownloadAt" TIMESTAMP(3),
    "otherLodgesCursor" VARCHAR(64),
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerNzSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServerNzSettings_updatedByMemberId_idx" ON "ServerNzSettings"("updatedByMemberId");
