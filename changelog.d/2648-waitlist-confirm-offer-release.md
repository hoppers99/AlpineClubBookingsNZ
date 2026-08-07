- **A free waitlisted booking can no longer be left in limbo, and the "Confirm
  Booking" button no longer invites a click on an offer that has already been used
  up (#2623).** Confirming a waitlist offer happens in two steps: the club's
  records first move the booking off the waitlist — which uses up the offer — and
  then finalise it. For a booking that costs nothing, if that second step collided
  with another change being saved at the same moment, the app tried to undo the
  first step and put the member's waitlist place back. That undo could itself
  collide, and when it did the member saw a generic failure while their booking sat
  in a state with no offer left, nothing to pay, and nothing to retry.

  The undo now gets a considerably longer window to succeed, tries a second time
  if it collides, and can no longer turn into an unexplained error. The window is
  kept short enough that a member is never left waiting much past half a minute.
  In the rare case
  where it still cannot run, the member is told plainly what happened — their offer
  was used up, the booking is waiting on a lodge administrator, and they should not
  try again — and the club gets a critical entry in Admin -> Audit log (filter on
  `waitlist.confirm_offer_release_failed`) naming the booking, the lodge and the
  stay, so it can be put right rather than sitting unnoticed. `docs/MAINTENANCE.md`
  explains the two ways to fix one. That new entry is filed under the **Bookings**
  audit category, so it is visible to exactly the administrators who can already
  see the booking it names and to nobody new; the audit writer census totals move
  from 418 sites to 419 and `booking` from 79 to 80 to record it.

  The offer card is now honest about all of this. Previously, several refusals
  arrived *after* the offer had been used up but left an enabled "Confirm Booking"
  button on screen; clicking it again could only produce an internal-sounding
  "Booking is not in WAITLIST_OFFERED status". The card now replaces the button
  with "Reload booking status" whenever the server says the offer is gone, and
  keeps it live only when the offer really is still open. Two refusals that used to
  claim a bed was no longer available now say what actually happened instead.

  One related hardening: a free booking's $0 payment record is now written only
  after the booking is confirmed paid, so a collision at that exact moment can no
  longer leave behind a payment record on a booking that was never confirmed —
  which would have made the booking look paid and blocked its real payment record
  permanently. No existing booking is affected and nothing needs to be re-run.
