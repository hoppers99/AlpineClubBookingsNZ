- **Deleted bookings now read as deleted, and two admin actions that still
  worked on them no longer do (#2674).** When a cancelled booking is deleted, the
  club considers it gone: it disappears from the booking page for everyone but a
  Full Admin. A review asked whether the underlying actions agreed, and the
  answer was mostly yes and partly no.

  The action the review was filed about — setting or clearing a member's expected
  arrival time — turned out to be safe already. It refused, because deleting a
  booking requires cancelling it first, and that action already refuses cancelled
  bookings. Nothing was ever written and nothing appeared in the audit log. What
  it got wrong was only the explanation: it said "this booking is cancelled"
  rather than "this booking does not exist". It now says the latter, to everyone,
  including a Full Admin, because this is a change rather than a look.

  Checking the rest of the family found the real cases. Every one of the booking
  actions was reviewed, and all but a few were already refusing a deleted booking
  for one reason or another. The ones that were not are now fixed, and they are
  the ones nobody had noticed:

  - **Asking for a refund on a deleted booking.** This one refused any booking
    that was *not* cancelled — so a deleted booking, which is always cancelled,
    sailed straight through. A refund request could be raised against a booking
    the club had already removed, complete with an alert email to the office.
  - **Cancelling a pending policy-exception request on a deleted booking.**

  Nothing here changes what happens to a live booking, and no existing refund
  request, exception request or arrival time is altered. If you have been relying
  on being able to raise a refund request after deleting a booking, raise it
  before deleting, or ask an admin to restore the record first.
