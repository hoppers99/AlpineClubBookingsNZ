-- Zero-benefit promo redemptions must not consume usage caps (#2299).
--
-- DATA REPAIR ONLY (phase metadata-only): no schema change, no DDL, no enum,
-- no index, no constraint. Two idempotent statements on PromoRedemptionAllocation
-- and PromoCode — neither table appears in HOT_TABLE_SQL_REGEX in
-- scripts/validate-blue-green-migrations.sh, and neither statement matches its
-- breaking-statement regex, so THE BLUE/GREEN GATE IS SILENT FOR THIS MIGRATION
-- BY DESIGN. The voluntary docs/BLUE_GREEN_MIGRATION_SAFETY.tsv row is the audit
-- trail, and carries the full reasoning.
--
-- Background. An allocation row now means "this member actually got something",
-- and every usage cap counts those rows: uses per member, total redemptions
-- (via the denormalised PromoCode."currentRedemptions"), and unique members.
-- Before this release the code force-wrote an all-zero allocation row whenever a
-- promo had eligible guests, even when the computed benefit was nothing — so a
-- member could burn their single permitted use of a code that gave them no money
-- off at all. The application code no longer writes such rows and filters any
-- that remain out of every cap count, but the denormalised counter cannot be
-- fixed by a query filter, so it is rebased here.
--
-- The PromoRedemption rows themselves are deliberately LEFT ALONE. They are the
-- audit and reporting trail; only what counts as a *use* changes. Leaving them
-- alone also matters mechanically: the PromoRedemption_sync_allocation_insert /
-- _update triggers from 20260527120000_add_promo_redemption_allocations upsert a
-- booker allocation row on every PromoRedemption write, so touching those rows
-- here would re-create exactly the allocations statement (1) deletes. Neither
-- statement below writes PromoRedemption, so neither trigger fires. The triggers
-- stay in place on purpose (they are what keeps an old blue/green colour's
-- redemptions visible as allocations); the application neutralises them by
-- deleting a redemption's allocation rows immediately after each create/update.

-- 1. Remove the historical all-zero allocation rows: no money off, no price
--    change in either direction, and no subsidised night. Matches the benefit
--    test the application now applies (isBeneficialPromoAllocation /
--    BENEFICIAL_PROMO_ALLOCATION_FILTER in src/lib/promo.ts) exactly, so the two
--    can never disagree about which rows count.
DELETE FROM "PromoRedemptionAllocation"
WHERE "discountCents" <= 0
  AND "priceAdjustmentCents" = 0
  AND "freeNightsUsed" <= 0;

-- 2. Rebase the denormalised total-redemptions counter onto the surviving rows.
--    Every writer of "currentRedemptions" keeps it equal to the number of
--    allocation rows for the code, so recomputing it from those rows restores
--    that invariant after step 1 — and repairs any counter that had already
--    drifted. Written as a correlated count rather than a decrement so it is
--    idempotent: re-running it is a no-op. The WHERE clause keeps the statement
--    to codes that actually need it. "updatedAt" is deliberately not touched
--    (this is a system repair, not an admin edit), which also keeps the
--    session-clock DML gate out of the picture.
UPDATE "PromoCode"
SET "currentRedemptions" = COALESCE(counted."allocationCount", 0)
FROM (
  SELECT p."id" AS "promoCodeId",
         (SELECT COUNT(*) FROM "PromoRedemptionAllocation" a
          WHERE a."promoCodeId" = p."id") AS "allocationCount"
  FROM "PromoCode" p
) AS counted
WHERE "PromoCode"."id" = counted."promoCodeId"
  AND "PromoCode"."currentRedemptions" <> COALESCE(counted."allocationCount", 0);
