-- #2365: turn eligible SOFT booking-policy failures into a durable, auditable
-- member-request + admin-decision flow by extending BookingChangeRequest.
--
-- Purely additive EXPAND. Nothing is dropped, rewritten or backfilled: the two
-- new BookingChangeRequestStatus values and the new BookingChangeRequestKind
-- enum only ever appear on rows the new colour writes, and every new column is
-- either nullable-with-no-default or NOT NULL with a CONSTANT default, so
-- PostgreSQL adds them by catalog update with no heap rewrite. BookingChangeRequest
-- is a low-write admin-review table (absent from HOT_TABLE_SQL_REGEX), so the
-- brief ACCESS EXCLUSIVE lock the ALTERs take never contends with a hot path.

-- Two new terminal outcomes for a POLICY_EXCEPTION request. A LOCKED_PERIOD row
-- never reaches them, so the draining old colour — whose pending queue selects
-- `status = 'REQUESTED'` — never reads one (see the ledger note for the bounded
-- per-booking read exposure). IF NOT EXISTS keeps the migration idempotent, the
-- same guard every enum-add in this tree uses.
ALTER TYPE "BookingChangeRequestStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "BookingChangeRequestStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';

-- The request flavour. A brand-new enum type, so using it as a column default
-- below is safe in this same transaction (the ADD VALUE restriction is about
-- using a NEWLY-ADDED value of an EXISTING type, which this migration never does).
CREATE TYPE "BookingChangeRequestKind" AS ENUM ('LOCKED_PERIOD', 'POLICY_EXCEPTION');

-- All additive columns in one ALTER. `kind`, `attemptCount`, `conflictCount`
-- and `version` are NOT NULL with a constant default, which PostgreSQL applies
-- as a catalog-only ADD COLUMN (no rewrite, no backfill) and which keeps an old
-- colour's column-omitting INSERT valid — it simply receives the default. Every
-- other column is nullable with no default: null is exactly "this is not a
-- policy-exception row" / "no conflict recorded yet".
ALTER TABLE "BookingChangeRequest"
    ADD COLUMN "kind" "BookingChangeRequestKind" NOT NULL DEFAULT 'LOCKED_PERIOD',
    ADD COLUMN "proposalSnapshot" JSONB,
    ADD COLUMN "proposalHash" VARCHAR(64),
    ADD COLUMN "frozenEvidence" JSONB,
    ADD COLUMN "aggregateCapacityMode" "PolicyExceptionCapacityMode",
    ADD COLUMN "memberMessage" VARCHAR(1000),
    ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "conflictCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastConflictAt" TIMESTAMP(3),
    ADD COLUMN "lastConflictReason" VARCHAR(500),
    ADD COLUMN "supersededByRequestId" TEXT,
    ADD COLUMN "cancelledAt" TIMESTAMP(3),
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- The policy-exception queue index: pending requests of one kind, oldest first,
-- so the Booking Officer view shows request age without scanning the table.
CREATE INDEX "BookingChangeRequest_kind_status_createdAt_idx"
    ON "BookingChangeRequest"("kind", "status", "createdAt");
