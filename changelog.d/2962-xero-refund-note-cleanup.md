- Fixed canonical Xero link cleanup and the reconciliation report deactivating
  legitimate Stripe per-delta refund credit-note links, which fed the daily
  credit-reconciliation self-heal an unbounded duplicate-note loop (#2901).
  Cleanup and the drift report are now source-aware: Stripe multi-delta coverage
  is preserved (even when the scalar pointer is null) while non-Stripe sources
  keep single-canonical enforcement. Added a dry-run-first operator repair
  (`scripts/xero-refund-note-link-repair.ts`) that restores wrongly deactivated
  links to exactly the refunded total and deactivates local mirrors of
  operator-voided notes — local ledger writes only, never a provider call.
