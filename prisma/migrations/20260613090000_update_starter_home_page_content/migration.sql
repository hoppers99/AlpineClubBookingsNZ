-- Issue #716: the starter "/home" PageContent row backfilled by
-- 20260611101500_backfill_starter_page_content used Ruapehu/Whakapapa
-- specific copy. Replace it with club-agnostic copy.
--
-- The WHERE clause guards on every field being changed (caption, title,
-- headerText) still holding its original default value, so deployments
-- where an admin has edited any of these fields are left untouched.
--
-- Keep these values in sync with the "home" entry in
-- prisma/starter-page-content.ts (enforced by
-- src/lib/__tests__/page-content-starter-backfill.test.ts).
UPDATE "PageContent"
SET
  "caption" = 'Welcome to the Club Lodge',
  "title" = 'Club Lodge',
  "headerText" = 'Our club lodge welcomes members and guests year-round. Book a stay, join the club, and explore New Zealand''s mountains.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  "slug" = 'home'
  AND "caption" = 'Whakapapa, Mt Ruapehu'
  AND "title" = 'Mt Ruapehu Lodge'
  AND "headerText" = 'Our club lodge sits in the Whakapapa ski area on Mt Ruapehu. Book a stay, join the club, and explore New Zealand''s mountains.';
