-- Display authoring v2 (LTV-024, ADR-003 §1): replace the data-only region
-- template model with the Layout/Template authoring entities. Nothing shipped
-- to production (module flag OFF, staging-only MVP), so this is a forward
-- drop-and-create, not a data migration.

-- Detach the device from the old template model and drop its per-device
-- content column (v2 keeps per-display content on the Template, not the device).
ALTER TABLE "LodgeDisplayDevice" DROP CONSTRAINT "LodgeDisplayDevice_templateId_fkey";
ALTER TABLE "LodgeDisplayDevice" DROP COLUMN "regionConfig";

-- Drop the retired region/panel template model and its source enum.
DROP TABLE "DisplayTemplate";
DROP TYPE "DisplayTemplateSource";

-- CreateTable
CREATE TABLE "DisplayLayout" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "bodyHtml" TEXT NOT NULL,
    "defaultCss" TEXT NOT NULL,
    "areas" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisplayLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisplayTemplate" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "layoutId" TEXT NOT NULL,
    "slotContent" JSONB NOT NULL,
    "cssOverrides" TEXT NOT NULL,
    "footerHtml" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisplayTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisplayLayout_key_key" ON "DisplayLayout"("key");

-- CreateIndex
CREATE UNIQUE INDEX "DisplayTemplate_key_key" ON "DisplayTemplate"("key");

-- CreateIndex
CREATE INDEX "DisplayTemplate_layoutId_idx" ON "DisplayTemplate"("layoutId");

-- AddForeignKey
ALTER TABLE "DisplayTemplate" ADD CONSTRAINT "DisplayTemplate_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "DisplayLayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LodgeDisplayDevice" ADD CONSTRAINT "LodgeDisplayDevice_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DisplayTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
