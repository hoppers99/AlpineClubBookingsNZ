-- The public "Book Now" button is switched OFF for every club (#2430, owner
-- decision recorded on PR #2466, 1 Aug 2026).
--
-- Two statements, one decision. The first decision flipped only the column
-- DEFAULT, so a fresh install shipped without a public booking button while an
-- existing club kept whatever it had saved. The owner then widened it: after
-- this release the button is OFF for EVERY club, whether or not the club had
-- chosen to show it. The owner knows and accepts that this overrides a
-- deliberate saved choice, including a live club currently showing the button;
-- a club that wants it back ticks "Show the Book Now button" under Admin >
-- Setup & Configuration > Site Appearance & Content > Page Content and presses
-- Save visibility. One click, and nothing else about the club's public content
-- is touched.

-- 1. Fresh installs: the shipped column default.
-- AlterTable
ALTER TABLE "PublicContentSettings" ALTER COLUMN "showBookNow" SET DEFAULT false;

-- 2. Existing clubs: the backfill this decision is actually about. Deliberately
--    a plain UPDATE over the whole table rather than a lookup of id = 'default'.
--    The table is a singleton by convention only, and a statement that assumed
--    the convention would silently miss a row on any install that ever grew a
--    second one. Guarded on the current value so it is idempotent — a re-run
--    matches nothing, and a club already hiding the button takes no write at
--    all.
--
--    NEITHER "updatedAt" NOR "updatedByMemberId" IS TOUCHED, deliberately, for
--    the same reason as 20260731140000_repair_zero_benefit_promo_allocations:
--    this is a release-level change, not an admin edit, so the row's record of
--    who last saved that panel and when must keep naming the admin who really
--    did. It also keeps the session-clock DML gate out of the picture — no
--    CURRENT_TIMESTAMP and no now() is written anywhere in this file, so
--    nothing here can write a local wall clock into a naive timestamp column
--    (the #1627/#1656 class). The operator-facing record of this change is the
--    release note in docs/UPGRADING.md.
UPDATE "PublicContentSettings" SET "showBookNow" = false WHERE "showBookNow" = true;
