- **A new nightly check warns admins when a member's account credit and Xero
  disagree about a booking (#2501).** When a member applies account credit to a
  booking, the club's Xero invoice is reduced by exactly that credit. Since
  #2483 the confirmation email tells the member what to transfer using the
  club's own record of that credit, with no wait on Xero — which is fast, but
  means the two could quietly drift apart if someone edits a credit note or
  invoice directly in Xero, or an allocation never completed.

  This checker closes that gap. Once a day it compares, for every booking the
  system believes it has already credited in Xero, the club's recorded credit
  against what Xero's invoice actually shows allocated. If they differ it emails
  the admins a detailed warning naming the member, the booking, the invoice and
  the exact amount of the difference — and, when the invoice is short, which
  Xero credit notes it did and did not find. It only emails when there is a real
  mismatch, and it is gated by the existing "Xero sync errors" email preference.

  It never changes anything in Xero or in the club's records — it is a warning
  to review, not an automatic fix, so it can surface a problem rather than
  paper over it. It is careful not to cry wolf: a booking whose allocation is
  still being processed, or one it cannot read because Xero is briefly
  unavailable, is quietly skipped and rechecked next time rather than reported
  as a mismatch. It also throttles itself to about once a day so it cannot use
  up the club's daily Xero request budget.
