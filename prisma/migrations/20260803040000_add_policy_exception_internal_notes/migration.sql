-- #2562: split the Booking Officer's decision note in two.
--
-- The existing `adminNotes` column on both policy-exception request tables is
-- MEMBER-VISIBLE: it is rendered to the member on their own request list, and it
-- is interpolated into the approval email. That was the right default — a member
-- refused an exception needs to be told why — but it left officers with nowhere
-- to write the commentary they do NOT want the member to read, so the honest
-- options were to say nothing or to write it somewhere it would be seen.
--
-- `internalNotes` is that place. It is read by admin-guarded surfaces only (the
-- officer queue list and its per-request detail endpoint); no member-facing
-- projection, route select, email template or notification names it, and the
-- member DTO (src/lib/member-exception-requests.ts) is a strict allowlist with no
-- slot for it. The privacy rule is recorded in docs/DOMAIN_INVARIANTS.md.
--
-- Purely additive EXPAND, twice. Nothing is dropped, renamed, rewritten or
-- backfilled: two nullable columns with no default, which PostgreSQL adds by
-- catalog update with no heap rewrite. Both tables are low-write admin-review
-- tables absent from HOT_TABLE_SQL_REGEX, so each brief ACCESS EXCLUSIVE lock
-- never contends with a hot path, and no traffic window is needed.
--
-- OLD-COLOUR COMPATIBLE IN BOTH DIRECTIONS. Forward: the previously deployed
-- Prisma client does not name the column, so it neither selects nor writes it,
-- and its INSERTs receive NULL. Reverse: a row the old colour writes during the
-- drain carries internalNotes NULL, which the new colour reads as exactly "the
-- officer left no private note" — the correct reading, because the old colour had
-- no field to write one in. A decision the old colour records lands in
-- `adminNotes` alone, which is what it has always meant.
--
-- Timestamp coordination: 20260803040000 sorts strictly after current main's
-- 20260803030000 #2520 contract migration. It is distinct from #2569's earlier
-- 20260803020000 policy migration and that lane's renumbered 20260803070000
-- coverage-incidents migration. The duplicate-prefix ratchet in
-- scripts/check-migration-safety-coverage.sh turns main red on a collision.

-- The MODIFICATION flavour (POLICY_EXCEPTION rows on the shared table). Nullable
-- and never populated for a LOCKED_PERIOD row, which has no officer-decision
-- surface of this shape.
ALTER TABLE "BookingChangeRequest"
    ADD COLUMN "internalNotes" VARCHAR(2000);

-- The NEW-booking flavour, on its own table.
ALTER TABLE "NewBookingPolicyExceptionRequest"
    ADD COLUMN "internalNotes" VARCHAR(2000);
