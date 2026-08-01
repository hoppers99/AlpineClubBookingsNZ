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
  up. Those records are the club's own law about what a member owes — the same
  figure the "record a payment" screen works out — so the amount asked for is
  exactly what the club would accept as settlement in full. Keeping them in step
  with Xero afterwards is a separate job: a hand-edited credit note, or an
  allocation the accounting system never finished processing, can still put the
  two out of step, and a reconciliation check (issue #2501) is being built to
  warn admins whenever that happens rather than letting a member be the one who
  notices.

  Because of that timing, the wording changes direction when the netting is
  shown: instead of "transfer the amount the invoice shows", it asks the member
  to hold the email's figure if their invoice asks for **more**, pay the invoice
  if it asks for **less**, and tell the club either way. An invoice that has not
  been reduced yet would otherwise cause the very overpayment this fixes, and
  chasing an invoice that asks for more than the club wants would cause it in
  the other direction.

  Two edge cases both err towards asking for less rather than more. When the
  credit covers the booking exactly, the confirmation says so and asks for
  nothing — it never quotes the full price. When the records somehow hold more
  credit than the booking costs, the two cannot both be true, so the email names
  no figure at all: it states the booking's price as a fact, asks the member to
  wait while the club works out what is left to pay, and logs the contradiction
  for an admin.

  Clubs that invoice by hand (the accounting module switched off) get the same
  figure in their "needs a manual invoice" alert, so the invoice the club raises
  and the amount the member was asked for can never disagree.

  Nothing else about the email changed. A booking with no credit against it —
  which is every unpaid confirmation the system sends today — is exactly as
  #2444 left it, word for word, and so are confirmations that are paid, partly
  paid, or covered entirely by credit. A credit record the system could not read
  falls back to the #2444 wording too. No new token was added, so a club with
  customised wording gets all of this without editing anything —
  `{{totalDue}}` simply carries the netted amount, which is what it has always
  meant.
