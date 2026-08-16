- **Invariant documentation mistakes now fail the repository check more reliably
  (#2889).** The check now reads indented index rows and the migration safety
  ledger; understands pull-request synchronize payloads without confusing their
  previous-head field for a push; rejects dotted numeric sub-IDs; and no longer
  loses list, thematic-break or raw-HTML boundaries in forms accepted by GitHub.

  This changes contributor validation only; it does not change booking,
  payment, membership, lodge or deployment behaviour.
