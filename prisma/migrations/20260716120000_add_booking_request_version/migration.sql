-- Optimistic-concurrency version counter for the held-request conversion fences
-- (#1923). The conversion claims previously fenced on updatedAt (TIMESTAMP(3),
-- millisecond precision); two writes in the same millisecond collide and defeat
-- the CAS. This integer counter is bumped on every mutating write of the row and
-- the fences claim on it instead. Additive, expand-only: the constant default
-- makes every existing and old-colour row valid, and old application versions
-- that neither read nor write the column keep working during a blue/green
-- deploy. The ADD COLUMN with a constant default is a catalog-only change on
-- PostgreSQL 11+ (no table rewrite, brief lock).
ALTER TABLE "BookingRequest"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
