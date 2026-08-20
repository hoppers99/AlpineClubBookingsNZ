- Fixed account-credit cancellations being read as missing Stripe cash refunds by the Xero
  health check and the daily credit-reconciliation self-heal, which minted a fictitious refund
  credit note plus a refund payment against the Stripe bank account that no provider
  transaction backs (#2902). Every refund-note surface — health detection, the self-heal
  enqueue and its cap, the execution-time delta recompute (which now completes an
  already-queued fictitious operation without billing Xero), the nightly over-coverage drift
  class, and the #2901 operator repair's coverage target — now derives cash from
  provider-backed evidence (INV-PAY-050): successful `PaymentRefund` cents when the ledger has
  rows, else the pre-ledger fallback of the refunded mirror minus its account-credit
  disposition. The repair dry run reports pre-existing fictitious notes for the operator to
  void in Xero; nothing is ever voided automatically.
