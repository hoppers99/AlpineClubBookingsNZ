-- #2524: member request surfaces for booking-policy exceptions. Two additive,
-- blue/green-safe changes on top of the #2365 foundation (20260802190000):
--
--   (1) A brand-new NewBookingPolicyExceptionRequest table. The #2365
--       BookingChangeRequest store cannot hold a NEW-booking proposal because its
--       bookingId is a required FK and a new booking has no row yet, so
--       new-booking requests get their own fully-constrained table (owner
--       decision). It reuses the existing BookingChangeRequestStatus and
--       PolicyExceptionCapacityMode enums (no new enum), so there is no
--       ALTER TYPE at all.
--
--   (2) One additive nullable column, openStateKey, on the existing
--       BookingChangeRequest table, plus its unique index: the DB-enforced
--       one-open-request slot for a POLICY_EXCEPTION modification request.
--
-- Purely additive EXPAND. No DROP/RENAME/SET-NOT-NULL on existing data, no
-- backfill DML, no session-clock write, no provider call. Old-colour compatible
-- in BOTH directions: the previously deployed Prisma client does not know the new
-- table (never reads or writes it) and its BookingChangeRequest INSERTs omit
-- openStateKey (it receives NULL, and PostgreSQL treats NULLs as distinct so the
-- unique index never rejects an old-colour write). A row the old colour writes
-- during the drain carries openStateKey NULL, which the new colour reads as
-- exactly "no open-request slot held" — correct for a locked-period row.

-- The new-booking request table. All columns are either NOT NULL with a CONSTANT
-- default (status/attemptCount/conflictCount/version/createdAt) or nullable with
-- no default, so PostgreSQL creates it in one shot with no rewrite. The table did
-- not exist a moment earlier, so its CREATE / index / trigger-free build locks
-- only objects nothing else can be reading.
CREATE TABLE "NewBookingPolicyExceptionRequest" (
    "id" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "requestedByMemberId" TEXT NOT NULL,
    "status" "BookingChangeRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "proposalSnapshot" JSONB NOT NULL,
    "proposalHash" VARCHAR(64) NOT NULL,
    "frozenEvidence" JSONB NOT NULL,
    "aggregateCapacityMode" "PolicyExceptionCapacityMode" NOT NULL,
    "memberMessage" VARCHAR(1000) NOT NULL,
    "reviewedByMemberId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "adminNotes" VARCHAR(2000),
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "lastConflictAt" TIMESTAMP(3),
    "lastConflictReason" VARCHAR(500),
    "supersededByRequestId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdBookingId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "openStateKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewBookingPolicyExceptionRequest_pkey" PRIMARY KEY ("id")
);

-- One-open-request slot: NULL-distinct unique index caps a member at one open
-- request per identical proposal race-safely (the durable backstop behind the
-- application open-request check). Set to nbpe:{memberId}:{proposalHash} while
-- REQUESTED, NULLed by every terminal transition.
CREATE UNIQUE INDEX "NewBookingPolicyExceptionRequest_openStateKey_key" ON "NewBookingPolicyExceptionRequest"("openStateKey");

-- Officer queue (pending, oldest first, to show request age), the member's own
-- list, and a per-lodge slice.
CREATE INDEX "NewBookingPolicyExceptionRequest_status_createdAt_idx" ON "NewBookingPolicyExceptionRequest"("status", "createdAt");

CREATE INDEX "NewBookingPolicyExceptionRequest_requestedByMemberId_status_idx" ON "NewBookingPolicyExceptionRequest"("requestedByMemberId", "status", "createdAt");

CREATE INDEX "NewBookingPolicyExceptionRequest_lodgeId_status_createdAt_idx" ON "NewBookingPolicyExceptionRequest"("lodgeId", "status", "createdAt");

-- RESTRICT to Lodge mirrors every other Lodge-owning table: a pending proposal
-- must always resolve to a real lodge. RESTRICT / SET NULL to Member mirror
-- BookingChangeRequest.requestedBy / reviewedBy exactly (the member owns the
-- request; the reviewer is a nullable actor back-ref). The referenced rows are
-- cold or admin-scale and the child table is empty, so FK validation is
-- instantaneous.
ALTER TABLE "NewBookingPolicyExceptionRequest" ADD CONSTRAINT "NewBookingPolicyExceptionRequest_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NewBookingPolicyExceptionRequest" ADD CONSTRAINT "NewBookingPolicyExceptionRequest_requestedByMemberId_fkey" FOREIGN KEY ("requestedByMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NewBookingPolicyExceptionRequest" ADD CONSTRAINT "NewBookingPolicyExceptionRequest_reviewedByMemberId_fkey" FOREIGN KEY ("reviewedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The POLICY_EXCEPTION modification one-open-request slot on the existing
-- BookingChangeRequest table. Nullable, no default: an old colour's
-- column-omitting INSERT receives NULL (no constraint impact), and every
-- LOCKED_PERIOD row leaves it NULL. Set to pe:{bookingId}:{requestedByMemberId}
-- while a policy-exception request is REQUESTED, NULLed by every terminal
-- transition. BookingChangeRequest is a low-write admin-review table absent from
-- HOT_TABLE_SQL_REGEX, and every existing row has openStateKey NULL, so the
-- unique index builds in milliseconds with nothing to reject.
ALTER TABLE "BookingChangeRequest" ADD COLUMN "openStateKey" TEXT;

CREATE UNIQUE INDEX "BookingChangeRequest_openStateKey_key" ON "BookingChangeRequest"("openStateKey");
