-- #2770: per-discount switch for whether a LATER EDIT earns the group discount
-- on the nights it newly buys (INV-MOD-026).
--
-- Purely additive EXPAND. One ALTER TABLE adds a NOT NULL BOOLEAN with the
-- constant default true to the cold singleton settings table, which PostgreSQL
-- installs as catalog metadata without rewriting the heap. The table holds at
-- most one row.
--
-- The default is deliberately true, not false: every edit path already passed
-- the group discount into pricing (INV-MOD-006), so an existing club must read
-- back exactly the behaviour it has today and no price may move at deploy.
ALTER TABLE "GroupDiscountSetting"
  ADD COLUMN "applyToEdits" BOOLEAN NOT NULL DEFAULT true;
