-- #2306 (epic #2305, "+ Add Member Guest" MG1): the consent state of a MEMBER
-- added as another member's guest, held as columns on the guest row itself
-- (owner decision D-7).
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv). This
-- is the HOT-TABLE half of MG1 — BookingGuest is in HOT_TABLE_SQL_REGEX — and is
-- kept as its own migration so it carries its own ledger row and lock-impact
-- plan:
--  * CREATE TYPE "MemberGuestConsentStatus" registers a brand-new enum type.
--    The partial index at the bottom DOES name one of its labels ('PENDING'),
--    so this is NOT a "registers the labels and never uses one" migration —
--    and it does not need to be. What PostgreSQL forbids is using a label added
--    by ALTER TYPE ... ADD VALUE inside the transaction that added it; a type
--    introduced by CREATE TYPE is usable immediately in that same transaction,
--    so Prisma's per-migration transaction is safe here. (20260525000000 /
--    20260719130000 / 20260720130000 / 20260727120000 are the ALTER TYPE case,
--    which is exactly why those migrations never use the label they add.)
--    What matters for blue/green is narrower and does hold: no DML and no
--    column default names a label, so no ROW in this database ever carries one
--    as a result of this migration;
--  * five ADD COLUMNs on "BookingGuest", ALL nullable with NO default, so each
--    is a PostgreSQL catalog-only add: no table rewrite, no row scan, no
--    backfill;
--  * NO foreign key on "consentRespondedByMemberId" (deliberately a bare
--    column, the same choice as BookingGuest.rateMembershipTypeId): an FK would
--    add a validating constraint on this hot table plus a lock on "Member";
--  * ONE partial btree index for MG2's expiry sweep, created here so MG2 needs
--    no migration of its own. Three honest notes about what that costs:
--     - Prisma runs this WHOLE FILE in ONE transaction. The ACCESS EXCLUSIVE
--       lock that the first ADD COLUMN takes on "BookingGuest" is therefore
--       held until COMMIT — through the index build — rather than being
--       released and re-taken as a briefer SHARE lock for the CREATE INDEX.
--       The blocking window for writers is the whole migration, not each
--       statement in turn;
--     - the predicate matches ZERO rows (the columns were added moments
--       earlier and nothing in this release can write a non-null
--       consentStatus), so the index this writes is EMPTY — but building a
--       predicated index still scans the whole heap of "BookingGuest" to
--       evaluate the predicate row by row. The cost is proportional to the
--       table, not to the zero matches. That is acceptable at this table's
--       size (club-scale: a handful of rows per booking) in the normal deploy
--       window, and it is why the deploy guard's lock timeout is the backstop;
--     - CREATE INDEX CONCURRENTLY is NOT the escape hatch to reach for.
--       PostgreSQL forbids it inside a transaction block and Prisma always
--       wraps a migration in one, so it cannot be used here at all. If
--       "BookingGuest" ever grows to where a full heap scan under ACCESS
--       EXCLUSIVE is unacceptable, the index has to be built OUT OF BAND (a
--       manual CONCURRENTLY build, recorded in
--       prisma/partial-unique-indexes.tsv like the rest) — not by editing this
--       file.
--    Prisma cannot express a predicated index, so the index is invisible to
--    schema.prisma and to db:check-drift — it is recorded instead in
--    prisma/partial-unique-indexes.tsv, which CI enforces for set equality
--    against pg_indexes.
--
-- Old-colour compatible in BOTH directions. Forward: the previously deployed
-- client has no consent* fields, never selects them, and never names the new
-- enum. Reverse: the usual "new colour writes an enum label the old colour
-- cannot deserialise" risk CANNOT occur here, because this release ships DARK —
-- MEMBER_GUEST_WIDENING_ENABLED is false, cross-family adds are still refused,
-- and therefore NO code path writes a non-null consentStatus at all. The
-- widening lands in MG2 (#2307), a release after the labels exist.
--
-- No DROP, no RENAME, no ALTER COLUMN TYPE / SET NOT NULL, no backfill DML, no
-- session-clock DML, and no provider call.

-- CreateEnum
CREATE TYPE "MemberGuestConsentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED', 'EXPIRED');

-- AlterTable
ALTER TABLE "BookingGuest" ADD COLUMN     "consentExpiresAt" TIMESTAMP(3),
ADD COLUMN     "consentRequestedAt" TIMESTAMP(3),
ADD COLUMN     "consentRespondedAt" TIMESTAMP(3),
ADD COLUMN     "consentRespondedByMemberId" TEXT,
ADD COLUMN     "consentStatus" "MemberGuestConsentStatus";

-- CreateIndex
-- Partial (predicated) index for MG2's PENDING-consent expiry sweep. Prisma
-- cannot express this, so it is raw SQL here and documented in
-- prisma/partial-unique-indexes.tsv (set-equality enforced by
-- scripts/check-partial-indexes.sh in the migration-drift CI job). This is the
-- one statement in the file that names an enum label; see the note at the top
-- for why that is safe with CREATE TYPE (and would not be with ALTER TYPE), and
-- for the heap-scan / lock-duration cost it carries.
CREATE INDEX "BookingGuest_pendingConsent_expiresAt_idx" ON "BookingGuest" ("consentExpiresAt") WHERE "consentStatus" = 'PENDING';
