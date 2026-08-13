-- Backfill the built-in "/booking-requests" PageContent row so existing
-- deployments gain the database-backed, token-driven booking-request page after
-- this release (static -> dynamic migration). The production blue/green deploy
-- runs Prisma migrations but not the seed, so this row must exist after
-- migrations alone; the code-backed route falls back to the bare form only until
-- it does.
--
-- ON CONFLICT DO NOTHING keeps this safe to run where the seed has already
-- created the page (or, in future, an admin has edited it): existing rows are
-- never touched. This is a pure data migration — no schema change — so it cannot
-- strand an old app colour's compiled queries during the blue/green drain.
--
-- THE EMPTY menuTitle IS THE POINT, not an omission. Advertising this form is
-- opt-in per club (#2818 decision 1): an empty menu title keeps the page out of
-- the public navigation AND out of search engines, because the page reads the
-- same field for its robots tag. Every existing deployment therefore keeps the
-- unlisted behaviour #2421 established, and a club that wants the form
-- advertised sets a menu title under Site Appearance & Content -> Page Content.
--
-- Keep these values in sync with starterPageContent in
-- prisma/starter-page-content.ts (enforced by
-- src/lib/__tests__/page-content-starter-backfill.test.ts).
INSERT INTO "PageContent"
  ("id", "slug", "path", "caption", "menuTitle", "title", "headerText", "sortOrder", "contentHtml", "updatedAt")
VALUES
  (
    'starter-page-booking-requests',
    'booking-requests',
    '/booking-requests',
    'Request a stay',
    '',
    'Booking Requests',
    'Request a stay without creating an account. We''ll email you to confirm your address, then review and price your request.',
    28,
    '{{booking-requests}}',
    -- UTC wall clock, not CURRENT_TIMESTAMP: the session-clock DML gate (#1627)
    -- blocks CURRENT_TIMESTAMP/now() in a new migration's INSERT payload. updatedAt
    -- here is cosmetic content-freshness on the cold PageContent table (no
    -- createdAt/updatedAt ordering invariant), and this is the gate's recommended
    -- form.
    timezone('UTC', statement_timestamp())
  )
ON CONFLICT DO NOTHING;
