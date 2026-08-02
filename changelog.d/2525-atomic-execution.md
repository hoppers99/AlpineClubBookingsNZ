- **Held booking-policy change requests now reserve capacity and are approved
  in one atomic step (#2525).** While a member's request to change an existing
  booking waits for a Booking Officer, the extra beds it needs are now held — only
  the beds beyond the unchanged live booking — and those held beds count as
  occupied everywhere the club reads availability, so the lodge cannot be oversold
  out from under a pending request. Withdrawing, superseding, rejecting, or
  approving a request frees the hold in the very same step that records the
  outcome. (New-booking exception requests are approved through the same atomic
  engine; their up-front bed hold arrives with the Booking Officer approval
  screen.)

  Approval is now genuinely all-or-nothing. When a Booking Officer approves a
  request the club re-checks their permission from live data, re-confirms the exact
  reviewed proposal has not drifted and that the policies still say what they said
  at review time, then creates the booking (or applies the modification) in a
  single transaction — there is no longer any window in which a request is marked
  approved but the booking has not yet been made. If a reviewed soft rule has since
  been switched off, the booking goes through without an override and the
  resolution is recorded; if the policy or the proposal has materially changed, the
  request stays pending for the member to resubmit. A request whose beds were not
  held (a mixed case that did not reserve) re-checks capacity at approval and simply
  stays pending with a clear message if the lodge is now full, rather than failing.
  Hard limits — whole-lodge capacity, payment, membership, past dates — remain firm
  refusals throughout.
