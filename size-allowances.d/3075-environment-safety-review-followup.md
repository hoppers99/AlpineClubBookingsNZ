# File-size allowances for #3075

Follow-up to the external review on #3071 (epic #2986). One file, and one only —
the other file this pull request grew (`src/lib/xero-group-settlement-invoices.ts`)
was brought back **under** its budget instead, by moving the reasoning for the new
in-lock re-check into `reassertXeroInvoiceEmailPolicy` in
`src/lib/xero-invoice-email.ts`, which is the module that owns that rule. No
allowance was taken for it, and none could have been: it was under budget on the
base ref, and an allowance may only let an already-over-budget file grow.

file: src/lib/xero-contacts.ts
lines: 1891
reason: fifteen lines of comment recording a time-of-check/time-of-use window an
  external reviewer found — the contact-email policy is resolved once, before up
  to 120 seconds of Xero calls and retry sleeps, so an administrator switching the
  safer override on mid-flight leaves one contact written under the previous
  answer. It is documented rather than closed on purpose: a lock spanning those
  provider calls is precisely the F7 (#1355) failure this function was
  restructured to remove, and a re-resolve between its phases would narrow the
  window while inviting the next reader to believe it was gone. The note has to
  sit on the `resolveXeroContactEmailPolicy` call it describes, because the whole
  point is what happens between that line and the writes below it — moving it to
  another file would separate the caveat from the call that carries it, which is
  how the two hosting exceptions drifted apart. No code was added: the function
  itself is unchanged by this pull request.
