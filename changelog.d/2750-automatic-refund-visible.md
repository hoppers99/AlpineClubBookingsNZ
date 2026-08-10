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
  amount, the day the money went back, and a link to the booking. It has no
  buttons, because there is nothing left for you to settle. It does say the one
  thing that might still need doing: if deleting the booking was the mistake
  rather than the payment, the booking has to be made again and the member
  charged again, because the refund has already gone out.

  No money moves differently. Refunds happen exactly when and in the amounts they
  did before; the only change is that you can see this one.
