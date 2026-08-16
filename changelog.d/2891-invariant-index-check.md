- **Invariant documentation mistakes now fail the repository check more reliably
  (#2889).** The check now reads indented index rows and the migration safety
  ledger, and its Markdown parser no longer loses list or raw-HTML boundaries in
  forms accepted by GitHub.

  This changes contributor validation only; it does not change booking,
  payment, membership, lodge or deployment behaviour.
