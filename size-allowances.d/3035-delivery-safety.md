# File-size allowances for #3035 (ENV-SAFETY 2 — the delivery boundary)

Four already-over-budget files grow here, and each gains a gate — or a fix to one
— inside a decision it already owns rather than a new concern.

**The files this change actually invents are all well inside budget, and that is
the standard this list should be read against.** The policy module
(`environment-delivery-policy.ts`, 453), the mailer's half of the boundary
(`email/environment-gate.ts`, 233), the Xero invoice-email wrapper
(`xero-invoice-email.ts`, 196) and the transport module it moved logging into
(`email/internal.ts`, 224) carry the whole of the new logic between them, so this
feature creates no size debt of its own.

**Two files came close enough to their ceiling that the review round pushed them
over, and both were COMPACTED back rather than allowanced** — an allowance is
explicitly not available to a file crossing its budget for the first time.
`email/core.ts` reached 720 of 700 when the capture-transport log line was added;
that line and its reasoning moved into `email/internal.ts`, the module that owns
transports, leaving a four-line call and the file at 695.
`xero-group-settlement-invoices.ts` reached 712 of 700 when the withhold-reason
fix landed with its explanation; the explanation moved into
`resolveXeroInvoiceEmailPolicy`'s docblock — where the rule belongs, since it is
about what every caller of that function may report — leaving the file at 696.
The same shared helper is what kept the three invoice workflows out of this list
in the first place.

file: src/lib/payment-link.ts
lines: 1228
reason: forty-eight lines across two sibling guards, and both fix defects rather
  than add features. The fresh-payment-link path ENUMERATED the untransmitted
  mailer outcomes and then returned `{ emailed: true }`, so #3035's new
  environment withhold would have reported a payment link as emailed when nothing
  left the building — and so would the next outcome added after it. The
  split-guest path then bucketed every non-send as `suppressed`, which the route
  turns into a 502 reading "your email address is undeliverable" — shown to a
  MEMBER, on this epic's headline case of a live club upgraded without the
  declaration. Both fixes have to sit beside the guards they complete: lifting
  them out would move the member-facing wording ("we could not email it") away
  from the link-minting it belongs to, and that wording is deliberately identical
  across all three so a member never learns which internal reason applied.

file: src/lib/xero-booking-invoices.ts
lines: 1336
reason: forty-two lines inside the invoice-email block that already holds two
  other non-send decisions — the booking's "No emails" switch and the
  unreadable-switch fault — and the new environment gate has to be read against
  both, because the whole point is that the three stay distinguishable. Splitting
  it would put the third reason in a different file from the two it must not be
  confused with. Most of the growth is the comment: it records that a re-drive
  short-circuits on `payment.xeroInvoiceId` and therefore never resends, so the
  truthful remediation for an unconfirmed role is to declare the role and send
  that one invoice from Xero by hand. The decision logic itself moved OUT, into
  `xero-invoice-email.ts`, which is why the other two invoice workflows grew by a
  handful of lines each and needed no allowance at all.

file: src/lib/booking-request-quotes.ts
lines: 1718
reason: twenty-four lines, all of them a defect fix in the one function that
  reports back to the officer who pressed Send. `sendBookingRequestQuote` treated
  every outcome the mailer RETURNS as a delivery, so an environment withhold gave
  that officer `emailDelivered: true` and wrote an audit row reading "Booking
  request quote sent" — for a quote the requester has never seen, whose response
  token is live in the database. The inspection has to sit where
  `emailDelivered` is computed, because that one variable feeds three things at
  once: the audit row's `outcome`, its summary sentence, and the value returned to
  the route. Splitting it would separate the three consumers of a single fact.

file: src/lib/email/booking.ts
lines: 1431
reason: four lines. `sendPreArrivalReminderEmail` swallowed the mailer's outcome,
  so the pre-arrival cron could not tell a send from a withhold — and that cron
  stamps `preArrivalReminderSentAt` BEFORE sending, with the selecting query
  filtered on that column being null, so the claim was consumed permanently for a
  message that never went. This message carries the lodge's door code and arrival
  instructions. The fix is `await sendEmail(...)` becoming `return sendEmail(...)`
  plus the comment saying why; it belongs in the sender it is about, and the other
  seventeen senders in this file already use the returning form.
