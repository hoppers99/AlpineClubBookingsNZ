-- #2576 — same-owner hosting coverage: the durable officer-facing incident and
-- the bounded re-evaluation outbox.
--
-- Purely additive EXPAND. Two brand-new enum types and two brand-new tables plus
-- their indexes and foreign keys, all referencing objects that already exist.
-- Nothing is dropped, renamed, rewritten or backfilled, and no row is written:
-- both tables are created EMPTY.
--
-- OLD-COLOUR SAFETY IS TOTAL HERE, unlike its sibling 20260803020000. A draining
-- old colour knows neither type, neither table nor either Prisma model, so it
-- cannot read or write them, and nothing it does reads them indirectly — the
-- capacity, occupancy, booking-list and email queries never join these tables.
-- An incident row is written only by the new colour's hosting reconciler and read
-- only by the new colour's officer queue. There is likewise no reverse-rollback
-- exposure of the kind an added ENUM VALUE creates: these are whole new types, so
-- a rolled-back colour simply never looks at them, and the rows survive as inert
-- extras (expect `prisma migrate diff` to report two leftover tables against the
-- previous release's schema, which is the intended end state, not drift).
--
-- LOCK IMPACT. CREATE TYPE and CREATE TABLE lock only the objects created here.
-- The two foreign keys take a brief SHARE ROW EXCLUSIVE lock on "Booking" and
-- "Member" to validate; because both new tables are empty the validation scan
-- checks nothing, so the lock is held for microseconds rather than for a scan of
-- "Booking". "Booking" IS a hot table, so that distinction matters: no ALTER
-- touches "Booking" itself, only the new child. No index is built on an existing
-- table, no session-clock DML runs, no money, capacity, allocation or provider
-- work happens. Run in the normal deploy window and let the deploy guard stop on
-- lock timeout.

-- ---------------------------------------------------------------------------
-- 1. Why an incident exists, and how it ended.
-- ---------------------------------------------------------------------------
--
-- Exactly two causes, because there are exactly two ways a confirmed booking can
-- lose its cover: an authorised Booking Officer deliberately overrode the refusal
-- (#2576 §7), or an authoritative change outside the ordinary member edit flow
-- removed the cover and could not reasonably be blocked (§8). An ordinary member
-- self-service change is neither — it is refused before it commits — so it never
-- produces an incident.
CREATE TYPE "HostingCoverageIncidentCause" AS ENUM ('OFFICER_OVERRIDE', 'SYSTEM_CHANGE');

-- The four ways §7 and §16 say an incident stops being a live problem. Recorded
-- rather than inferred: "cover came back" and "the booking was cancelled" are the
-- same absence of a hazard and a very different story for an officer.
CREATE TYPE "HostingCoverageIncidentResolution" AS ENUM ('COVERAGE_RESTORED', 'BOOKING_AMENDED', 'EXCEPTION_APPROVED', 'BOOKING_CANCELLED');

-- ---------------------------------------------------------------------------
-- 2. The incident.
-- ---------------------------------------------------------------------------
--
-- Deliberately NOT a second hosting review. "Booking"."adultMemberHostingReview*"
-- records what the rule currently says about a booking; this table records that
-- cover was TAKEN AWAY from a booking the club had already accepted. The booking
-- keeps its status, its beds and its payments (§7, §16 both forbid automatic
-- cancellation), and this row is what puts it in front of an officer.
CREATE TABLE "HostingCoverageIncident" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    -- Denormalized copy of the booking's lodge so the officer queue can filter
    -- and index by lodge without a join. Safe because "Booking"."lodgeId" is
    -- immutable: a booking never changes lodge, it is cancelled and re-made.
    "lodgeId" TEXT NOT NULL,
    "cause" "HostingCoverageIncidentCause" NOT NULL,
    -- Fingerprint of the uncovered state: policy revision plus the exact
    -- uncovered guest/night pairs in the evaluator's deterministic order. Two
    -- reconciliations of the same unchanged problem compute the same key and
    -- update nothing, which is what makes the incident and its notification
    -- idempotent (§8, §16).
    "stateKey" VARCHAR(300) NOT NULL,
    -- The frozen hosting violation, in the same snapshot shape the review column
    -- stores, so an officer reads one evidence format.
    "evidence" JSONB NOT NULL,
    "overriddenByMemberId" TEXT,
    "overrideReason" VARCHAR(500),
    -- Transition-based notification state (§16): the key the owner was last told
    -- about. Recomputing the same key sends nothing.
    "notifiedStateKey" VARCHAR(300),
    "ownerNotifiedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolution" "HostingCoverageIncidentResolution",

    CONSTRAINT "HostingCoverageIncident_pkey" PRIMARY KEY ("id")
);

-- Every read of one booking's incidents (the booking page, the reconciler's
-- open-or-update, the resolution sweep).
CREATE INDEX "HostingCoverageIncident_bookingId_idx"
    ON "HostingCoverageIncident"("bookingId");

-- The officer queue: unresolved first, oldest first.
CREATE INDEX "HostingCoverageIncident_resolvedAt_openedAt_idx"
    ON "HostingCoverageIncident"("resolvedAt", "openedAt");

-- The same queue narrowed to one lodge.
CREATE INDEX "HostingCoverageIncident_lodgeId_resolvedAt_idx"
    ON "HostingCoverageIncident"("lodgeId", "resolvedAt");

-- ONE ACTIVE INCIDENT PER BOOKING (§16: "create or update ONE durable active
-- compliance incident for the materially identical uncovered state").
--
-- A partial unique index rather than application care, so the invariant survives
-- a concurrent second opener: the loser gets a unique violation instead of
-- doubling the officer's queue. Predicated on "resolvedAt" IS NULL rather than on
-- a status column so there is one source of truth for "still a live problem" —
-- the same shape as MembershipSubscriptionChargeCoverage_active_subscription_unique.
-- Resolved rows accumulate as history outside the predicate.
--
-- Prisma cannot express a predicated index, so it is invisible to
-- db:check-drift; it is recorded in prisma/partial-unique-indexes.tsv and
-- scripts/check-partial-indexes.sh enforces set equality in CI.
CREATE UNIQUE INDEX "HostingCoverageIncident_active_booking_unique"
    ON "HostingCoverageIncident"("bookingId") WHERE ("resolvedAt" IS NULL);

-- CASCADE from the booking: an incident is a fact ABOUT one booking and is
-- meaningless without it. Bookings are soft-deleted in normal operation
-- ("deletedAt"), so this fires only on a genuine row removal.
ALTER TABLE "HostingCoverageIncident"
    ADD CONSTRAINT "HostingCoverageIncident_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL for the overriding officer, matching
-- "Booking"."adultMemberHostingReviewedById": the reason and the audit log stay
-- even if that member's row is later removed, exactly as they do for a hosting
-- review decision.
ALTER TABLE "HostingCoverageIncident"
    ADD CONSTRAINT "HostingCoverageIncident_overriddenByMemberId_fkey"
    FOREIGN KEY ("overriddenByMemberId") REFERENCES "Member"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. The bounded re-evaluation outbox.
-- ---------------------------------------------------------------------------
--
-- §8: an authoritative change is allowed, and the re-evaluation work it implies
-- is recorded DURABLY IN THE SAME TRANSACTION, then drained after commit against
-- freshly-read facts. Bounded by construction — one owner, one lodge, an explicit
-- night list — which is how §10's "no lodge-wide sweep" is held: this table has
-- no way to express one.
CREATE TABLE "HostingCoverageReevaluation" (
    "id" TEXT NOT NULL,
    -- A real foreign key, not a snapshot column: this is a LIVE pointer used to
    -- re-read facts, so a member merge must repoint it or the queued work would
    -- look at an account that no longer holds the bookings.
    "memberId" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    -- Sorted, unique NZ lodge-nights (YYYY-MM-DD) as a JSON array: one column,
    -- one write, and no per-night child rows for work that lives for seconds.
    "nights" JSONB NOT NULL,
    "cause" "HostingCoverageIncidentCause" NOT NULL,
    "sourceBookingId" TEXT,
    "actorMemberId" TEXT,
    "reason" VARCHAR(500),
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(1000),

    CONSTRAINT "HostingCoverageReevaluation_pkey" PRIMARY KEY ("id")
);

-- The drain: unprocessed first, oldest first.
CREATE INDEX "HostingCoverageReevaluation_processedAt_enqueuedAt_idx"
    ON "HostingCoverageReevaluation"("processedAt", "enqueuedAt");

-- Collapsing duplicate work for one owner at one lodge.
CREATE INDEX "HostingCoverageReevaluation_memberId_lodgeId_idx"
    ON "HostingCoverageReevaluation"("memberId", "lodgeId");

-- CASCADE: a hard-deleted member has no bookings left to re-evaluate, so the
-- queued work is moot rather than orphaned.
ALTER TABLE "HostingCoverageReevaluation"
    ADD CONSTRAINT "HostingCoverageReevaluation_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
