- **A refund the club never decided now shows up where you handle refunds
  (#2750).** If a member's payment for a booking change arrives after that
  booking has already been deleted, Stripe hands the money straight back to
  them. That has always happened, and it still does — the money returning to the
  member is the right direction when nobody is there to decide. What was missing
  is that nobody was told: the record it left behind was closed the moment it was
  created, and the only screen it could have appeared on lists refunds that are
  still waiting to be paid.

  Payments now carries a second card, **"Refunded automatically — nothing to pay
  back"**, listing those refunds from the last 30 days with the member, the
  amount, the day the money went back and the stay. It has no buttons, because
  there is nothing left for you to settle. It does say the one thing that might
  still need doing: if deleting the booking was the mistake rather than the
  payment, the booking has to be made again and the member charged again, because
  the refund has already gone out.

  The card is careful about what it claims, and says so on screen: whether one of
  these refunds reaches it depends on the order the member's browser and Stripe
  reached us in, so an empty list means "none recorded here" rather than "none
  happened" — the booking's audit log and the payment alert email the club is sent
  at the time remain the full record. If the list cannot be loaded you get a line
  saying so instead of an empty card, and a problem reading it never hides the
  hand-back refunds you still owe members.

  No money moves differently. Refunds happen exactly when and in the amounts they
  did before; the only change is that you can see this one.
