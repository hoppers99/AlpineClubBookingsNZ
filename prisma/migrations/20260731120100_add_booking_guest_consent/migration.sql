-- #2306 (epic #2305, "+ Add Member Guest" MG1): the consent state of a MEMBER
-- added as another member's guest, held as columns on the guest row itself
-- (owner decision D-7).
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv). This
-- is the HOT-TABLE half of MG1 — BookingGuest is in HOT_TABLE_SQL_REGEX — and is
-- kept as its own migration so it carries its own ledger row and lock-impact
-- plan:
--  * CREATE TYPE "MemberGuestConsentStatus" is a catalog-only enum
--    registration. This migration REGISTERS the labels and never USES one
--    (there is no DML, and no column default names a label), so Prisma's
--    per-migration transaction is safe — the same pattern as 20260525000000 /
--    20260719130000 / 20260720130000 / 20260727120000;
--  * five ADD COLUMNs on "BookingGuest", ALL nullable with NO default, so each
--    is a PostgreSQL catalog-only add: no table rewrite, no row scan, no
--    backfill, only a brief ACCESS EXCLUSIVE lock;
--  * NO foreign key on "consentRespondedByMemberId" (deliberately a bare
--    column, the same choice as BookingGuest.rateMembershipTypeId): an FK would
--    add a validating constraint on this hot table plus a lock on "Member";
--  * ONE partial btree index for MG2's expiry sweep. It is created here, while
--    the predicate matches ZERO rows (nothing in this release can write a
--    non-null consentStatus), so the build is trivial and MG2 needs no
--    migration of its own. Prisma cannot express a predicated index, so the
--    index is invisible to schema.prisma and to db:check-drift — it is
--    recorded instead in prisma/partial-unique-indexes.tsv, which CI enforces
--    for set equality against pg_indexes.
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
-- scripts/check-partial-indexes.sh in the migration-drift CI job).
CREATE INDEX "BookingGuest_pendingConsent_expiresAt_idx" ON "BookingGuest" ("consentExpiresAt") WHERE "consentStatus" = 'PENDING';
