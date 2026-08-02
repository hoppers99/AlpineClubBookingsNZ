- **Held booking-policy change requests now reserve capacity and are approved
  in one atomic step (#2525).** While a member's request to change an existing
  booking waits for a Booking Officer, the extra beds it needs are now held — the
  beds beyond a capacity-holding live booking, or the full proposed party when the
  booking being changed is not yet holding capacity — and those held beds count as
  occupied everywhere the club reads availability, so the lodge cannot be oversold
  out from under a pending request. A request is never allowed to hold more beds
  than the lodge actually has free; if there is no room to hold the change it is
  declined up front rather than parking phantom beds that would block others.
  Withdrawing, superseding, rejecting, or approving a request frees the hold in the
  very same step that records the outcome. (New-booking exception requests will be
  approved through the same atomic engine, and their up-front bed hold is still to
  come — that reservation is deferred to a follow-up, #2526.)

  Approval is now genuinely all-or-nothing. When a Booking Officer approves a
  request the club re-checks their permission from live data, re-confirms the exact
  reviewed proposal has not drifted and that the policies still say what they said
  at review time, then creates the booking (or applies the modification) in a
  single transaction — there is no longer any window in which a request is marked
  approved but the booking has not yet been made. If a reviewed soft rule has since
  been switched off, the booking goes through without an override and the
  resolution is recorded; if the policy or the proposal has materially changed, the
  request stays pending for the member to resubmit. Every approval re-checks real
  capacity at approval time — including one that was holding beds, whose own hold is
  released first so it is measured against the true remaining room — and simply
  stays pending with a clear message if the lodge is now full, rather than executing
  an overbooking. Hard limits — whole-lodge capacity, payment, membership, past
  dates — remain firm refusals throughout.

  Note for operators: the post-approval provider work (any refund, payment-intent,
  or notification the canonical booking/modification service schedules) runs after
  the approval commits and relies on that service's existing idempotency-keyed
  recovery queue to retry safely — this atomic-approval layer does not add its own
  retry, so a transient provider failure is recovered exactly once by the canonical
  queue, never double-charged or double-refunded.
