-- #2430 (owner decision, 1 Aug 2026): a fresh install advertises no public
-- "Book Now" button until an admin ticks it on. Column DEFAULT only — this
-- statement writes no row, so every existing club keeps the value it saved.
-- AlterTable
ALTER TABLE "PublicContentSettings" ALTER COLUMN "showBookNow" SET DEFAULT false;
