-- Admin-editable site content for the public footer columns (issue #993).
-- Chrome fragments kept in a dedicated table, deliberately separate from the
-- public "PageContent" table so they never appear in the website menu.

-- CreateEnum
CREATE TYPE "SiteContentKey" AS ENUM ('FOOTER_BLURB', 'FOOTER_QUICK_LINKS', 'FOOTER_AFFILIATIONS');

-- CreateTable
CREATE TABLE "SiteContent" (
    "id" TEXT NOT NULL,
    "key" "SiteContentKey" NOT NULL,
    "contentHtml" TEXT NOT NULL,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteContent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteContent_key_key" ON "SiteContent"("key");

-- CreateIndex
CREATE INDEX "SiteContent_updatedByMemberId_idx" ON "SiteContent"("updatedByMemberId");

-- Backfill the three footer columns with the copy previously hardcoded in
-- src/components/website-footer.tsx so every environment that runs
-- migrations (including deploy-only environments that never run the seed)
-- keeps a pixel-identical footer. Values duplicate
-- prisma/starter-site-content.ts; the site-content-starter-backfill test
-- keeps them in sync. ON CONFLICT DO NOTHING keeps this safe to re-run and
-- never overwrites admin-edited content.
INSERT INTO "SiteContent"
  ("id", "key", "contentHtml", "updatedAt")
VALUES
  ('site-content-footer-blurb', 'FOOTER_BLURB', $cms$<p>Established 1969. Encouraging tramping, mountaineering, climbing, skiing, and alpine activities in New Zealand.</p>$cms$, CURRENT_TIMESTAMP),
  ('site-content-footer-quick-links', 'FOOTER_QUICK_LINKS', $cms$<h3>Quick Links</h3><ul><li><a href="/about">About the Club</a></li><li><a href="/join">Join the Club</a></li><li><a href="/faq">FAQ</a></li><li><a href="/rules">Club Rules</a></li><li><a href="/contact">Contact Us</a></li><li><a href="/login">Member Login</a></li></ul>$cms$, CURRENT_TIMESTAMP),
  ('site-content-footer-affiliations', 'FOOTER_AFFILIATIONS', $cms$<h3>Affiliations</h3><ul><li><a href="https://www.fmc.org.nz/" target="_blank" rel="noopener noreferrer">Federated Mountain Clubs (FMC)</a></li><li><a href="https://rmca.org.nz/" target="_blank" rel="noopener noreferrer">Ruapehu Mountain Clubs Association (RMCA)</a></li><li><a href="{{facebook-url}}" target="_blank" rel="noopener noreferrer">Facebook</a></li></ul>$cms$, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
