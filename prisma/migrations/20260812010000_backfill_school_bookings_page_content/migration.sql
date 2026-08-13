-- Backfill the built-in "/school-bookings" PageContent row so existing
-- deployments gain the database-backed, token-driven school-group booking page
-- after this release (static -> dynamic migration). The production blue/green
-- deploy runs Prisma migrations but not the seed, so this row must exist after
-- migrations alone; the code-backed route falls back to the bare form only until
-- it does.
--
-- ON CONFLICT DO NOTHING keeps this safe to run where the seed has already
-- created the page (or an admin has edited it): existing rows are never touched.
-- This is a pure data migration -- no schema change.
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
    'starter-page-school-bookings',
    'school-bookings',
    '/school-bookings',
    'For schools & groups',
    '',
    'School Bookings',
    'Planning a school or group trip? Tell us your dates and numbers, and we''ll email you a quote for your school to review.',
    29,
    '{{school-bookings}}',
    -- UTC wall clock, not CURRENT_TIMESTAMP: the session-clock DML gate (#1627)
    -- blocks CURRENT_TIMESTAMP/now() in a new migration's INSERT payload. updatedAt
    -- here is cosmetic content-freshness on the cold PageContent table (no
    -- createdAt/updatedAt ordering invariant), and this is the gate's recommended
    -- form.
    timezone('UTC', statement_timestamp())
  )
ON CONFLICT DO NOTHING;
