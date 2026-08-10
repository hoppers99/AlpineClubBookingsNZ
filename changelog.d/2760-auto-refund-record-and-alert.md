- **Every automatically refunded booking-change payment is now on the Payments
  page, and the email about it says what actually happened (#2760, #2761).** When
  a member pays for a booking change at the moment their booking is being
  cancelled or deleted, Stripe hands the money straight back on its own. That
  refund had a home on `/admin/payments` — the read-only **Refunded
  automatically — nothing to pay back** card — but only some of them ever reached
  it: the record depended on the order the member's browser and Stripe's
  notification arrived in, and it never covered a booking that was cancelled
  without being deleted.

  All of them reach it now, so the card no longer says it is an incomplete list.
  It says what it is: every automatic refund of the last 30 days, with the
  booking's audit log as the permanent record for anything older. Because the
  wider net includes refunds that are simply the expected outcome of cancelling a
  booking, the card is split into two groups — **the booking was deleted**, which
  is worth a look because remaking it means charging the member again, and **the
  booking was cancelled and is still on file**, which normally needs nothing.

  The alert email sent at the moment it happens is the same single email as
  before, rewritten. Its subject used to be the generic "Payment Failed", which
  described nothing that had happened and got triaged as noise; it now reads
  *Payment refunded automatically — booking already deleted* (or *… already
  cancelled*) and the body says which case it is and what, if anything, to do.
  It can no longer be switched off — not per admin in Notification Recipients,
  and not club-wide in Delivery Rules — because money moved without anybody
  deciding it, and it always resolves at least one recipient rather than
  silently going nowhere. It goes to everyone whose role can edit Finance.

  No refund amount, timing, or decision changed, no operator is queued for
  anything, and no badge or daily-digest count changed. One consequence worth
  knowing: because these events are no longer filed as payment failures, they no
  longer add to the daily digest's "Payment Failures" number — nothing failed.
