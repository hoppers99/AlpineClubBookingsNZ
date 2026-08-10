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
  - **Sending a guest their payment link.** This one already refused, but it
    said so to the wrong person. Someone with no connection to the booking was
    told "you are not allowed" while it existed, and "no such booking" once it
    had been deleted — which is a way of learning that a booking was deleted
    without being entitled to know anything about it at all. It now says "you
    are not allowed" either way, and only someone who *is* entitled to act on
    the booking is told it no longer exists.

  Nothing here changes what happens to a live booking, and no existing refund
  request, exception request, arrival time or payment link is altered. If you
  have been relying on being able to raise a refund request after deleting a
  booking, raise it before deleting, or ask an admin to restore the record first.

  Two further actions were left alone here, because each needed a decision
  rather than a guard: recording a guest's consent answer, and recording a
  modification payment the card provider has already taken. Two read-only
  screens also still showed the owner their own deleted booking's details. Those
  decisions have since been taken and all four are dealt with in this same
  release — the consent answer and both screens now refuse, and the modification
  payment is recorded and raised for a person rather than left silent. See the
  #2700 entry below.
