- Fixed canonical Xero link cleanup and the reconciliation report deactivating
  legitimate Stripe per-delta refund credit-note links, which fed the daily
  credit-reconciliation self-heal an unbounded duplicate-note loop (#2901).
  Cleanup and the drift report are now source- and status-aware: LIVE Stripe
  multi-delta coverage is preserved (even when the scalar pointer is null), a
  note recorded VOIDED/DELETED in Xero counts as zero coverage everywhere and
  its still-active local mirror is deactivated as stale drift, non-Stripe
  sources keep single-canonical enforcement, and a new
  `overCoveredStripeRefundPayments` drift class flags active coverage above the
  refunded total (the state that silently suppresses later refund notes). Added
  a dry-run-first operator repair (`scripts/xero-refund-note-link-repair.ts`):
  it records each linked note's live Xero status first (read-only provider
  GETs — the script never creates, voids or deletes anything in Xero), never
  reactivates a cancelled or unknown-status note, never pushes coverage past
  the refunded total, refuses payments with a still-executable credit-note
  operation (queued, running, awaiting payment, failed-but-retryable, or a
  queued retry of one), and applies only the payment ids the operator
  reviewed.
