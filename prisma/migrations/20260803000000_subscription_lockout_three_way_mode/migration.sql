-- #2543 — the subscription booking lockout becomes a three-way policy.
--
-- The old boolean `enabled` could only say "hard-block an unpaid member" or
-- "do not gate at all". Clubs also want the third answer: let them book, but at
-- non-member rates. Modelled as an enum rather than a second boolean so the
-- three answers stay mutually exclusive and a club can never be in two states.
--
-- EXPAND HALF ONLY. This file adds the type and the column and nothing else: no
-- backfill, no default, no destructive change. `mode` is left NULLABLE and NULL,
-- and every existing club's stored policy is still the legacy `enabled` boolean at
-- the end of this migration.
--
-- READ ITS SIBLING NEXT. `20260803010000_contract_subscription_lockout_drop_enabled`
-- ships in the SAME release and is what finishes the change: it backfills `mode`
-- from `enabled` (`true -> HARD_BLOCK`, `false -> NO_BLOCK`), makes `mode`
-- `NOT NULL DEFAULT 'HARD_BLOCK'`, and DROPS `enabled`. That is an OWNER DIRECTIVE
-- (3 Aug 2026, #2561): complete the change in one release behind an explicit
-- maintenance window, rather than keeping a dual-write and a read-time fallback
-- alive for a later contract release. So this release contains no
-- `legacyEnabledForLockoutMode` dual-write and no legacy branch in
-- `normalizeMembershipLockoutSettings` — if you are looking for either because an
-- older draft of this comment named them, they were removed by that directive, not
-- lost. The deploy sequence, the window and `rollback.sql` are described on the
-- contract migration and in docs/BLUE_GREEN_MIGRATION_SAFETY.tsv.
--
-- WHY TWO FILES AND NOT ONE. They are two different declarations. This one is
-- additive and old-code compatible (`old_code_compatible=yes`); the drop is not
-- (`windowed`), it is `phase=contract`, and it needs a `previous_expand_release` to
-- name — which is this file. Folding them together would hide a destructive change
-- inside an additive row, and the safety ledger would have one row where the
-- operator needs to read two.
--
-- Net effect on every existing club, across both migrations: none. A club that had
-- deliberately switched the lockout OFF resolves NO_BLOCK; one that never opened the
-- panel keeps hard-blocking. Nothing moves until an admin picks a mode in
-- Admin -> Subscription lockout.

CREATE TYPE "SubscriptionLockoutMode" AS ENUM ('NO_BLOCK', 'HARD_BLOCK', 'NON_MEMBER_PRICING');

ALTER TABLE "MembershipLockoutSettings"
  ADD COLUMN "mode" "SubscriptionLockoutMode";
