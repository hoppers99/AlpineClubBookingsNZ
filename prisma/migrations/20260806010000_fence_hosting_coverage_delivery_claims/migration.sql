-- #2596 — fence both halves of same-owner hosting-coverage delivery to the
-- exact worker that owns the current lease.
--
-- Purely additive EXPAND. All three columns are nullable with no defaults, so
-- existing rows remain valid and PostgreSQL performs no table rewrite. The two
-- affected tables were introduced by 20260803070000 and are low-volume queue /
-- compliance tables rather than booking, payment or membership hot tables.
--
-- MIXED RUNTIMES ARE NOT SAFE even though old clients can deserialize this
-- additive schema. An old worker ignores the tokens and can claim/complete the
-- same queue row under the previous protocol while a new worker owns it. The
-- safety ledger therefore declares this migration windowed: old app + workers
-- stop before migrate, then only new workers start. New clients treat a NULL
-- re-evaluation token as unclaimed and use the explicit expiry for crash recovery;
-- notification completion/release additionally names the opaque claimant token so
-- a stale sender cannot clear a successor's lease.
ALTER TABLE "HostingCoverageReevaluation"
    ADD COLUMN "claimToken" VARCHAR(64),
    ADD COLUMN "claimExpiresAt" TIMESTAMP(3);

ALTER TABLE "HostingCoverageIncident"
    ADD COLUMN "ownerNotificationClaimToken" VARCHAR(64);
