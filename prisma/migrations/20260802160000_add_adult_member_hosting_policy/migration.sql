-- #2364 adult-member hosting policy and its per-booking review state.
--
-- Two additive pieces:
--   1. the new AdultMemberHostingPolicy table (one club-wide row plus per-lodge
--      override rows) with its scope-identity, lock and revision machinery;
--   2. five additive Booking columns holding the hosting review — snapshot,
--      status, and who accepted the hazard and why.
--
-- Nothing is dropped, rewritten or backfilled. The policy table is created
-- empty, so the deliberate absence of a capacityMode default (D-R6: capacity
-- mode is explicit for new policies) costs no backfill and leaves no hidden
-- value for a writer to inherit.

CREATE TYPE "AdultMemberHostingMode" AS ENUM ('INHERIT', 'DISABLED', 'ADMIN_REVIEW_REQUIRED');

CREATE TABLE "AdultMemberHostingPolicy" (
    "id" TEXT NOT NULL,
    "lodgeId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "mode" "AdultMemberHostingMode" NOT NULL,
    "capacityMode" "PolicyExceptionCapacityMode" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdultMemberHostingPolicy_pkey" PRIMARY KEY ("id")
);

-- Scope identity is one row per scope, and the database says so rather than the
-- application. A plain unique index on the nullable "lodgeId" would NOT do it:
-- PostgreSQL treats NULLs as distinct, so two club-wide rows would both be
-- admitted and resolution would stop being deterministic. The generated-looking
-- "scopeKey" is pinned to COALESCE("lodgeId", 'club-wide') by a CHECK, so it
-- cannot drift from "lodgeId" on any write, and the unique index on it covers
-- BOTH the club-wide singleton and the one-row-per-lodge rule with one index.
-- (Lodge ids are cuids, so a real lodge id can never be the literal
-- 'club-wide'.) A plain unique index also keeps this out of
-- prisma/partial-unique-indexes.tsv, which exists only for predicated indexes.
CREATE UNIQUE INDEX "AdultMemberHostingPolicy_scopeKey_key"
    ON "AdultMemberHostingPolicy"("scopeKey");

CREATE INDEX "AdultMemberHostingPolicy_lodgeId_idx"
    ON "AdultMemberHostingPolicy"("lodgeId");

ALTER TABLE "AdultMemberHostingPolicy"
    ADD CONSTRAINT "AdultMemberHostingPolicy_scopeKey_matches_lodge"
    CHECK ("scopeKey" = COALESCE("lodgeId", 'club-wide'));

-- INHERIT means "use the club default", so the club-wide row cannot hold it:
-- there is nothing above it to inherit from and resolution would not terminate.
-- Enforced here rather than only in the API because config transfer, psql and
-- any future writer must all be held to it.
ALTER TABLE "AdultMemberHostingPolicy"
    ADD CONSTRAINT "AdultMemberHostingPolicy_clubwide_not_inherit"
    CHECK ("lodgeId" IS NOT NULL OR "mode" <> 'INHERIT');

-- Restrict, matching MinimumStayPolicy: deleting a lodge must not silently
-- delete the hosting rule that was protecting its guests.
ALTER TABLE "AdultMemberHostingPolicy"
    ADD CONSTRAINT "AdultMemberHostingPolicy_lodgeId_fkey"
    FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Policy-set serialisation, mirroring MinimumStayPolicy_lock_set (#2363).
--
-- Honest note on WHY, because the reason is NOT the same as its sibling's. The
-- #2363 trigger is a blue/green drain boundary: a draining old colour already
-- wrote MinimumStayPolicy and could not call the new TypeScript helper. THIS
-- table did not exist before this migration, so no old colour writes it and
-- there is no drain to protect. The trigger is here so that the lock order is
-- unconditional anyway — every writer, including operator psql DML, the config
-- importer and any future colour, takes the set key BEFORE PostgreSQL takes a
-- tuple lock — which is what keeps "advisory then row" true of the whole table
-- rather than only of the code paths we happen to have written. Keep it a
-- BEFORE STATEMENT trigger: a row-level one would invert that order.
CREATE OR REPLACE FUNCTION "lock_adult_member_hosting_policy_set"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('adult-member-hosting-policy-set'));
    RETURN NULL;
END;
$$;

CREATE TRIGGER "AdultMemberHostingPolicy_lock_set"
BEFORE INSERT OR UPDATE OR DELETE ON "AdultMemberHostingPolicy"
FOR EACH STATEMENT
EXECUTE FUNCTION "lock_adult_member_hosting_policy_set"();

-- Revision handling, separate from locking and running only once the statement
-- trigger above already holds the set key. Stricter than its #2363 sibling: that
-- one tolerates an update that leaves the token alone (the draining old colour
-- did not name `version` in its UPDATE data), and this table has no such writer,
-- so a material update MUST present OLD + 1 and a stale token is refused instead
-- of silently advancing. Non-material writes (updatedAt-only, or a re-save of
-- identical values) keep the old token so a no-op cannot invalidate somebody
-- else's open editor.
CREATE OR REPLACE FUNCTION "version_adult_member_hosting_policy"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."version" <> 1 THEN
            RAISE EXCEPTION 'AdultMemberHostingPolicy inserts must start at version 1'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(
        NEW."mode",
        NEW."capacityMode",
        NEW."lodgeId",
        NEW."scopeKey"
    ) IS NOT DISTINCT FROM ROW(
        OLD."mode",
        OLD."capacityMode",
        OLD."lodgeId",
        OLD."scopeKey"
    ) THEN
        NEW."version" := OLD."version";
    ELSIF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'AdultMemberHostingPolicy version must advance exactly once'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "AdultMemberHostingPolicy_version"
BEFORE INSERT OR UPDATE ON "AdultMemberHostingPolicy"
FOR EACH ROW
EXECUTE FUNCTION "version_adult_member_hosting_policy"();

-- Hosting review state on Booking, in its OWN columns.
--
-- Not folded into requiresAdminReview/adminReviewReason/adminReviewStatus,
-- deliberately. Those carry the minors-only rule (#1372/#1422), and several
-- booking paths WIPE them the moment that rule stops applying. A hosting hazard
-- can be live at the same instant on the same booking with a different
-- lifecycle, so sharing one status column would let an unrelated guest edit
-- silently discard an admin's hosting decision. The two hazards are reported
-- together as structured codes at read time (bookingReviewReasonCodes) rather
-- than merged in storage — which is exactly what "without overloading the legacy
-- single review string" asks for.
--
-- Every column is nullable with no default, so PostgreSQL adds all five to the
-- hot Booking table by catalog update, with no heap rewrite and no backfill.
ALTER TABLE "Booking"
    ADD COLUMN "adultMemberHostingReview" JSONB,
    ADD COLUMN "adultMemberHostingReviewStatus" "AdminReviewStatus",
    ADD COLUMN "adultMemberHostingReviewReason" VARCHAR(500),
    ADD COLUMN "adultMemberHostingReviewedById" TEXT,
    ADD COLUMN "adultMemberHostingReviewedAt" TIMESTAMP(3);

-- The reviewer column is a real foreign key, matching "adminReviewedById" and
-- every other actor-attribution column on Booking. A bare TEXT id would outlive
-- the member it names: member merge repoints actor columns by walking the
-- Prisma relations, and deleting a member SetNulls them, so an id with no
-- relation is silently skipped by both and D-R4's "who accepted this hazard"
-- decays into a dangling id the database would never surface.
--
-- SetNull, not Restrict: losing the attribution must never block deleting a
-- member, and the reason text stays on the row either way. Created NOT VALID
-- then validated, so the ACCESS EXCLUSIVE lock is held only for the catalog
-- update and the row scan runs under a SHARE UPDATE EXCLUSIVE lock that does
-- not block booking writes. (The columns were added empty two statements above,
-- so the validation scan finds nothing to check.)
ALTER TABLE "Booking"
    ADD CONSTRAINT "Booking_adultMemberHostingReviewedById_fkey"
    FOREIGN KEY ("adultMemberHostingReviewedById") REFERENCES "Member"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
    NOT VALID;

ALTER TABLE "Booking"
    VALIDATE CONSTRAINT "Booking_adultMemberHostingReviewedById_fkey";

-- No index on the new columns, on purpose. Nothing in #2364 QUERIES by hosting
-- review state: every read is by booking id, from a path that already has the
-- booking. The queue that will scan for pending hosting reviews is #2365's, and
-- it should add the (predicated) index alongside the query that needs it —
-- together with its row in prisma/partial-unique-indexes.tsv, which CI holds to
-- set equality against the live database.
--
-- That includes the reviewer foreign key, which its sibling "adminReviewedById"
-- DOES index. The difference is what reads it: the admin review queue filters by
-- adminReviewedById, while nothing filters by this column. The only unindexed
-- scans it can cause are a member DELETE and a member merge repointing it —
-- rare, admin-initiated, already-slow lifecycle operations — and the cost of
-- avoiding them is a CREATE INDEX holding a write-blocking SHARE lock on the
-- hot Booking table, which is the larger risk of the two. #2365 adds the index
-- with the query that makes it earn its keep.
