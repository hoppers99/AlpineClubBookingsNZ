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
-- old colour cannot call the new TypeScript lock helper, so a BEFORE STATEMENT
-- trigger takes the exact same global policy-set lock before PostgreSQL takes
-- any tuple lock. New-runtime writers already hold this key and re-enter it.
-- Both colours therefore follow advisory -> row order; a row-level advisory
-- trigger would invert that order for the old colour and can deadlock.
CREATE OR REPLACE FUNCTION "lock_minimum_stay_policy_set"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('minimum-stay-policy-set'));
    RETURN NULL;
END;
$$;

CREATE TRIGGER "MinimumStayPolicy_lock_set"
BEFORE INSERT OR UPDATE OR DELETE ON "MinimumStayPolicy"
FOR EACH STATEMENT
EXECUTE FUNCTION "lock_minimum_stay_policy_set"();

-- Revision handling is deliberately separate from locking. This row trigger
-- runs only after the statement trigger already holds the policy-set key.
CREATE OR REPLACE FUNCTION "version_minimum_stay_policy"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."version" <> 1 THEN
            RAISE EXCEPTION 'MinimumStayPolicy inserts must start at version 1'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
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

CREATE TRIGGER "MinimumStayPolicy_version"
BEFORE INSERT OR UPDATE ON "MinimumStayPolicy"
FOR EACH ROW
EXECUTE FUNCTION "version_minimum_stay_policy"();
