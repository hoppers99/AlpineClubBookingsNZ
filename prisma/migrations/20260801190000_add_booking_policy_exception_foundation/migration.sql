-- #2363 booking-policy exception foundation.
--
-- Both columns are additive and carry constant defaults so PostgreSQL can
-- populate every existing MinimumStayPolicy row without a table rewrite.
-- HOLD is the owner-decided migration value for every existing policy. The
-- capacityMode default remains solely so the draining pre-#2363 colour can
-- still create a row during blue/green cutover; the new API requires callers
-- to submit the mode explicitly and never relies on this default.
CREATE TYPE "PolicyExceptionCapacityMode" AS ENUM ('HOLD', 'NO_HOLD');

ALTER TABLE "MinimumStayPolicy"
    ADD COLUMN "capacityMode" "PolicyExceptionCapacityMode" NOT NULL DEFAULT 'HOLD',
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- The database is the compatibility boundary during a blue/green drain. The
-- old colour cannot call the new TypeScript lock helper and does not know about
-- version, so every row writer takes the identical namespaced advisory key here
-- and every material UPDATE advances the revision. New-runtime writers already
-- take this lock and increment version; transaction advisory locks are
-- re-entrant, and the trigger recognises OLD.version + 1 so it never increments
-- them twice.
CREATE OR REPLACE FUNCTION "lock_and_version_minimum_stay_policy"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_scope_key TEXT;
    new_scope_key TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        new_scope_key := 'minimum-stay-policy-set:' ||
            CASE
                WHEN NEW."lodgeId" IS NULL THEN 'club-wide'
                ELSE 'lodge:' || NEW."lodgeId"
            END;
        PERFORM pg_advisory_xact_lock(hashtext(new_scope_key));
        IF NEW."version" <> 1 THEN
            RAISE EXCEPTION 'MinimumStayPolicy inserts must start at version 1'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    old_scope_key := 'minimum-stay-policy-set:' ||
        CASE
            WHEN OLD."lodgeId" IS NULL THEN 'club-wide'
            ELSE 'lodge:' || OLD."lodgeId"
        END;

    IF TG_OP = 'DELETE' THEN
        PERFORM pg_advisory_xact_lock(hashtext(old_scope_key));
        RETURN OLD;
    END IF;

    new_scope_key := 'minimum-stay-policy-set:' ||
        CASE
            WHEN NEW."lodgeId" IS NULL THEN 'club-wide'
            ELSE 'lodge:' || NEW."lodgeId"
        END;

    -- The application never moves a policy between scopes, but fail safely for
    -- maintenance SQL: acquire both scope keys in bytewise order so two moves
    -- cannot form a lock cycle under a locale-dependent database collation.
    IF old_scope_key = new_scope_key THEN
        PERFORM pg_advisory_xact_lock(hashtext(old_scope_key));
    ELSIF old_scope_key COLLATE "C" < new_scope_key COLLATE "C" THEN
        PERFORM pg_advisory_xact_lock(hashtext(old_scope_key));
        PERFORM pg_advisory_xact_lock(hashtext(new_scope_key));
    ELSE
        PERFORM pg_advisory_xact_lock(hashtext(new_scope_key));
        PERFORM pg_advisory_xact_lock(hashtext(old_scope_key));
    END IF;

    IF ROW(
        NEW."name",
        NEW."startDate",
        NEW."endDate",
        NEW."triggerDays",
        NEW."minimumNights",
        NEW."active",
        NEW."capacityMode",
        NEW."lodgeId"
    ) IS NOT DISTINCT FROM ROW(
        OLD."name",
        OLD."startDate",
        OLD."endDate",
        OLD."triggerDays",
        OLD."minimumNights",
        OLD."active",
        OLD."capacityMode",
        OLD."lodgeId"
    ) THEN
        -- updatedAt-only/no-op writes are not material revisions, even if a
        -- caller tried to advance the token.
        NEW."version" := OLD."version";
    ELSIF NEW."version" = OLD."version" THEN
        -- Draining old colour: it does not name version in UPDATE data.
        NEW."version" := OLD."version" + 1;
    ELSIF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'MinimumStayPolicy version must advance exactly once'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "MinimumStayPolicy_lock_and_version"
BEFORE INSERT OR UPDATE OR DELETE ON "MinimumStayPolicy"
FOR EACH ROW
EXECUTE FUNCTION "lock_and_version_minimum_stay_policy"();
