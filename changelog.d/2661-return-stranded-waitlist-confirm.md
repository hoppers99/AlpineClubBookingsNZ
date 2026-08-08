- **An administrator can now put a stuck free waitlist booking back in the queue,
  without touching the database (#2649).** Very rarely, a member confirming a
  waitlist offer for nights that cost them nothing gets half-way: the offer is
  used up and the booking moves to "awaiting payment", but the final step cannot
  finish and cannot undo itself. The booking then owes nothing, blocks nobody
  else's nights, and has no offer left to retry. The member is told exactly that,
  and the club gets
  a critical entry in Admin -> Audit log — but until now the only way to give
  them their place back was for someone with database access to do it by hand.
  The waitlist screen could not help, because a booking in that state is no
  longer waitlisted, and neither Force Confirm nor Record payment would accept
  it.

  Open the booking from **Admin -> Bookings** and press **Return to waitlist** in
  the Admin tools card. The booking goes back on the waitlist for the same
  nights, the beds it was assigned are freed and offered to whoever is next, and
  the member gets an email of its own saying their waitlist place is back at
  their position — it states plainly that their offer did **not** run out and
  that they need do nothing, because they confirmed in time and it was our system
  that failed. If that booking has "No emails" switched on, the message is
  withheld and listed on the booking for an officer to pass on instead. The
  action is recorded in the audit log, and the entry names the earlier failure it
  resolves, so the two ends of the story are linked.

  The button appears only where the audit log shows this exact failure on that
  booking and it has not already been repaired. Free, awaiting payment and no
  payment record is deliberately not enough on its own: several ordinary things
  leave a booking looking like that — a date change that reprices to nothing, an
  admin approving a booking that was waiting on review, a guest being added or
  removed — and none of those members were ever in a queue to be returned to. It
  is not a general "un-confirm" tool, and it will not act on a booking that has a
  balance to pay. If someone else confirms or cancels the booking at the same
  moment, the action says so plainly and changes nothing. If the booking is busy
  — something else is part way through changing it — it says that too and asks
  you to try again in a moment, rather than reporting a failure that sounds like
  the repair itself is broken. It needs the same booking-edit access that Force
  Confirm needs, and the waitlist feature must be switched on.

  If the booking also carries an admin hold on its nights, the confirmation
  dialog says so before you press: returning it to the waitlist releases the
  hold, so those nights become available to other members straight away, and the
  audit entry records what was released. Set the hold again afterwards if you
  still need it.

  Cancelling the booking and asking the member to rejoin is still available and
  is still the right choice when the nights are no longer wanted. The operator
  runbook in `docs/MAINTENANCE.md` and the Waitlist guide both describe the new
  route.
