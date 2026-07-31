-- Issue #2421: the starter "/home" hero written by
-- 20260613090000_update_starter_home_page_content said the lodge "welcomes
-- members and guests year-round. Book a stay, join the club, ...", which
-- reads as an open invitation for anyone to book. Whether a club hosts
-- non-members at all is the club's own policy — the starter FAQ in the same
-- seed already says guests come by member invitation — so the default copy
-- must not contradict it. No other starter field changes.
--
-- The WHERE clause guards on the headerText still holding the value the #716
-- migration wrote, so deployments where an admin has edited the hero are left
-- untouched.
--
-- Keep this value in sync with the "home" entry in
-- prisma/starter-page-content.ts (enforced by
-- src/lib/__tests__/page-content-starter-backfill.test.ts).
--
-- "updatedAt" is stamped with an explicit UTC literal rather than
-- CURRENT_TIMESTAMP, which is what scripts/validate-blue-green-migrations.sh
-- asks for: the session clock is the deploying database's local wall clock, so
-- a skewed session would write a local time into a column every reader treats
-- as UTC. PageContent."updatedAt" is cosmetic — it feeds only the "Updated:"
-- line on the admin page-content panel — so a fixed release-dated stamp is
-- both accurate enough and deterministic.
UPDATE "PageContent"
SET
  "headerText" = 'Our club lodge welcomes members year-round. Sign in to book a stay, or apply to join and explore New Zealand''s mountains.',
  "updatedAt" = TIMESTAMP '2026-08-01 00:00:00'
WHERE
  "slug" = 'home'
  AND "headerText" = 'Our club lodge welcomes members and guests year-round. Book a stay, join the club, and explore New Zealand''s mountains.';
