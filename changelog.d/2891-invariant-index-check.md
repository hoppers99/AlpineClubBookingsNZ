- **Invariant documentation mistakes now fail the repository check more reliably
  (#2889).** Every invariant prefix must remain dense from `001`, so a newly
  misnumbered ID fails immediately. The check also compares against the exact
  base revision, so deleting a prefix's historical highest ID or its whole
  prefix cannot pass merely because the remaining current sequence looks dense.

  The same check now reads every tracked text form using Git's binary/text
  classification; understands pull-request synchronize payloads without
  confusing their previous-head field for a push; rejects decorated headings
  and dotted numeric sub-IDs; and no longer loses list, thematic-break or
  raw-HTML boundaries in forms accepted by GitHub.

  This changes contributor validation only; it does not change booking,
  payment, membership, lodge or deployment behaviour.
