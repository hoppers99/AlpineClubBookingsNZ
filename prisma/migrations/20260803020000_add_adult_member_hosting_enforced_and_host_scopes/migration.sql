-- #2569 — the configurable adult-member-hosting policy: a third CONSEQUENCE
-- (ENFORCED) and a second, independent HOST-QUALIFICATION dimension.
--
-- Purely additive EXPAND, in three statements plus one trigger replacement:
--
--   1. ALTER TYPE "AdultMemberHostingMode" ADD VALUE 'ENFORCED' — catalog-only,
--      takes no table lock. Nothing selects it: no migration writes ENFORCED, so
--      every existing club and lodge keeps the consequence it already had.
--   2. Two NULLABLE, NO-DEFAULT boolean columns on "AdultMemberHostingPolicy"
--      holding the host-qualification scope set. Catalog-only ADD COLUMNs with no
--      heap rewrite and NO BACKFILL: every existing row keeps NULL, which resolves
--      to the built-in default (same-booking only) — byte-identical to the
--      pre-#2569 rule, so no club's behaviour moves at migration time (#2569 §15).
--   3. A CHECK holding the two columns to all-NULL or all-set, so a
--      half-configured scope set cannot exist for the resolver to guess at.
--
-- The revision trigger is replaced so a scope-set change advances the
-- compare-and-swap token, which the existing one would have ignored.
--
-- Nothing is dropped, renamed, rewritten or backfilled. No index, no foreign
-- key, no session-clock DML, no provider call.

-- ---------------------------------------------------------------------------
-- 1. The third consequence.
-- ---------------------------------------------------------------------------
--
-- IF NOT EXISTS so a re-run is a no-op: PostgreSQL cannot remove an enum value,
-- so this statement is not reversible and must be idempotent.
ALTER TYPE "AdultMemberHostingMode" ADD VALUE IF NOT EXISTS 'ENFORCED';

-- ---------------------------------------------------------------------------
-- 2. The host-qualification scope set.
-- ---------------------------------------------------------------------------
--
-- Separate boolean columns rather than one enum or a bitmask, because the owner's
-- decision is explicit that the scopes are INDEPENDENT CHECKBOXES combined with
-- OR, and any combination is legal. Two columns say that in the schema; an enum of
-- the legal combinations would say it only in application code, and adding a scope
-- later would then be an enum change rather than another additive column.
--
-- TWO COLUMNS, AND THESE TWO. The spec originally named three scopes, and the
-- owner's later decisions of 3 Aug 2026 settled the model at exactly two:
--
--   * the lodge-wide "any adult member staying at the lodge" scope is REMOVED
--     (#2575) — a booking must not become compliant because an unrelated member
--     happens to be at the lodge, and the decision is a removal, not a deferral:
--     no column, no dormant value, nothing for a later lane to switch on;
--   * the nominated-host scope is REPLACED (#2576) by "SAME_BOOKING_OWNER" —
--     coverage from a qualifying adult member attending another eligible booking
--     with the exact same "Booking"."memberId". No nomination, invitation,
--     acceptance or candidate-search machinery exists or is planned.
--
-- Both are edited into this migration rather than fixed by a follow-up because it
-- is UNMERGED and has never been applied to any database — the repository's
-- no-rewrite rule protects deployed migrations, and this is neither deployed nor
-- merged, so there is no environment where either column ever existed.
--
-- "AdultMemberHostingPolicy" holds one club-wide row plus at most one row per
-- lodge — single-digit rows, read on booking gates and admin page render, never
-- written on a hot path — so the brief ACCESS EXCLUSIVE lock these ADD COLUMNs
-- take is momentary. The table is absent from HOT_TABLE_SQL_REGEX.
ALTER TABLE "AdultMemberHostingPolicy"
    ADD COLUMN "hostScopeSameBooking" BOOLEAN,
    ADD COLUMN "hostScopeSameBookingOwner" BOOLEAN;

-- ---------------------------------------------------------------------------
-- 3. All-or-nothing, enforced by the database.
-- ---------------------------------------------------------------------------
--
-- NULL is the "this scope did not decide, inherit" signal, and it is only
-- meaningful for the SET as a whole: a row saying "same-booking yes,
-- same-booking-owner NULL" has no defensible reading — is the second scope off,
-- or inherited from the club while the first is custom? Refusing the shape
-- outright means the resolver never has to answer that, and means config
-- transfer, operator psql and any future writer are all held to it rather than
-- only the API route.
--
-- Written as an equality of NULL-counts rather than ORed clauses so it stays
-- readable, and so adding a third scope column is a one-line edit. Every existing
-- row has both NULL, so the constraint validates against the current contents
-- without a single violation.
ALTER TABLE "AdultMemberHostingPolicy"
    ADD CONSTRAINT "AdultMemberHostingPolicy_host_scopes_all_or_none"
    CHECK (
        (
            ("hostScopeSameBooking" IS NULL)::int
            + ("hostScopeSameBookingOwner" IS NULL)::int
        ) IN (0, 2)
    );

-- ---------------------------------------------------------------------------
-- 4. The revision trigger learns about the new dimension.
-- ---------------------------------------------------------------------------
--
-- CREATE OR REPLACE FUNCTION, so the trigger definition itself is untouched.
-- The 20260802160000 body compares only (mode, capacityMode, lodgeId, scopeKey)
-- to decide whether an UPDATE is MATERIAL. Leaving it alone would make a change
-- of scope set look like a no-op write: the trigger would silently reset
-- NEW."version" to OLD."version", so the API's `version + 1` would be discarded
-- and two admins editing the scope set concurrently would each believe they had
-- won the compare-and-swap. Adding the two columns to the comparison makes a
-- scope-set change advance the token exactly like a consequence change.
--
-- The rest of the contract is unchanged and deliberately still strict: inserts
-- must start at 1, a material update must present OLD + 1, and a genuinely
-- non-material write (updatedAt-only, or a re-save of identical values) keeps
-- the old token so a no-op cannot invalidate somebody else's open editor.
--
-- Old-colour safety: a draining old colour's UPDATE does not name the two new
-- columns, so NEW and OLD agree on them and its writes are classified exactly as
-- they were before this migration.
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
        NEW."scopeKey",
        NEW."hostScopeSameBooking",
        NEW."hostScopeSameBookingOwner"
    ) IS NOT DISTINCT FROM ROW(
        OLD."mode",
        OLD."capacityMode",
        OLD."lodgeId",
        OLD."scopeKey",
        OLD."hostScopeSameBooking",
        OLD."hostScopeSameBookingOwner"
    ) THEN
        NEW."version" := OLD."version";
    ELSIF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'AdultMemberHostingPolicy version must advance exactly once'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;
