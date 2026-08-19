- **The club's refund model can now hold money for an unpriceable booking edit
  without pretending it was settled (#2797, foundation).** A manual refund task
  no longer has to sit against a captured payment or carry a fixed amount: a
  pure account credit can be owed with no payment behind it, and a task can be
  raised with its amount left genuinely unknown until the club prices it, rather
  than defaulting to a misleading `$0.00`.

  Every existing hand-back and late-capture task now carries a typed reason
  (cash cancellation, deleted-booking late capture, or automatically refunded
  record) so the finance queue classifies them without reading the note text,
  and the booking-finance view now notices a pending credit-only adjustment on a
  booking that has no payment — so reconciliation cannot mistake a booking with
  money still to return for a fully settled one.

  This release lands the data model and the safe reading of it; the member- and
  admin-facing "stay saved, adjustment awaiting club review" flow that raises
  these tasks builds on top of it.
