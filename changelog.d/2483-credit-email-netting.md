- **A booking confirmed with money still owing now shows the member exactly what
  to transfer when the club has put their account credit towards it (#2483).**
  This is the second half of #2444. That change stopped the email promising a
  netting it could not compute, and told the member to pay whatever the invoice
  asked for. It did not tell them the amount — and where the club's records
  already show credit against the booking, the invoice will ask for less than
  the "Total Due" figure, so a member following the email could still send too
  much.

  Such a confirmation now reads as a sum that adds up: `Booking Total: $300.00`,
  `Account credit applied: -$120.00`, `Total Due: $180.00`, with the paragraph
  underneath asking for the $180.00 and saying in words where it came from.

  The figure comes from the club's own credit records, not from Xero, so the
  email is sent immediately and never waits on the accounting system to catch
  up. Those are the same records that decide what Xero will take off the
  invoice, so the two agree by construction — what can still put them out of
  step is someone editing a credit note in Xero by hand, and a separate
  reconciliation check (issue #2501) is being built to warn admins whenever the
  two disagree, rather than letting a member be the one who notices.

  Because of that timing, the wording changes direction when the netting is
  shown: instead of "transfer the amount the invoice shows", it asks the member
  to transfer the figure in the email and let the club know if their invoice
  says something different. An invoice that has not been reduced yet would
  otherwise cause the very overpayment this fixes.

  Nothing else about the email changed. A booking with no credit against it —
  which is every unpaid confirmation the system sends today — is exactly as
  #2444 left it, word for word, and so are confirmations that are paid, partly
  paid, or covered entirely by credit. The system also declines to state a
  netting it cannot make sense of (credit as large as the whole booking on a
  booking that is still unpaid, or a credit record it could not read): the
  member gets the #2444 wording and an admin gets a log entry, because a precise
  figure that is wrong would be worse than none. No new token was added, so a
  club with customised wording gets all of this without editing anything —
  `{{totalDue}}` simply carries the netted amount, which is what it has always
  meant.
