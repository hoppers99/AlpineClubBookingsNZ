# File-size allowances for #3035 (ENV-SAFETY 2 — the delivery boundary)

Two already-over-budget files grow here, and both gain a gate in a decision they
already own rather than a new concern.

**The files this change actually invents are all well inside budget, and that is
the standard this list should be read against.** The policy module
(`environment-delivery-policy.ts`, 344), the mailer's half of the boundary
(`email/environment-gate.ts`, 167) and the Xero invoice-email wrapper
(`xero-invoice-email.ts`, 184) are new modules carrying the whole of the new
logic, so this feature creates no size debt of its own. `email/core.ts` — the
module the boundary is really about — went from 637 to 683 against a 700 ceiling
and needs no allowance, because the reasoning lives in
`email/environment-gate.ts` and only the eight-line gate lives in the mailer.
`xero-group-settlement-invoices.ts` came within eight lines of its ceiling (690
of 700) and was compacted rather than allowanced: an allowance is explicitly NOT
available for a file crossing its budget for the first time, so the prose moved
into the wrapper's docblock and the three call sites now share one
`resolveXeroInvoiceEmailPolicy()` answer instead of each spelling the rule out.
That shared helper is what kept this list to two entries.

file: src/lib/payment-link.ts
lines: 1197
reason: seventeen lines, and they fix a defect rather than add a feature. The
  fresh-payment-link path ENUMERATED the untransmitted mailer outcomes and then
  returned `{ emailed: true }`, so #3035's new environment withhold would have
  reported a payment link as emailed when nothing left the building — and so
  would the next outcome added after it. The fix is a fail-closed `!== "sent"`
  branch, and it has to sit beside the two sibling guards it completes: lifting
  those three guards out would move the member-facing wording ("we could not
  email it") away from the link-minting it belongs to, and that wording is
  deliberately identical across all three so a member never learns which
  internal reason applied.

file: src/lib/xero-booking-invoices.ts
reason: thirty-eight lines inside the invoice-email block that already holds two
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
lines: 1332
