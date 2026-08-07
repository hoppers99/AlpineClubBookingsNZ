- **Approving an account deletion no longer cancels a member's stays before discovering
  it cannot finish (#2623).** Approving a deletion cancels the member's future bookings
  one at a time and only removes their personal details at the end. If a Xero contact
  change for that member was still in progress, the deletion was correctly stopped — but
  only at the very last step, after the bookings had already been cancelled. The
  administrator was told to resolve the Xero operation and try again, with the member's
  stays already gone.

  The Xero check now runs at the start, alongside the other checks that can refuse an
  approval, so a deletion that cannot complete stops before anything is cancelled. The
  final check stays exactly where it was, so a Xero operation that starts midway through
  is still caught and the deletion can still be resumed.
