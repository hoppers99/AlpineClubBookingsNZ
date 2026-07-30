# Membership Cancellation Policy

Membership cancellation is an account lifecycle process with two entry points.
Usually it is member-initiated: members or their family managers request
cancellation, adult participants confirm their own inclusion where required,
and admins approve or reject each participant. An admin can also raise a
request directly against any active member from that member's admin page —
including a member who has no login of their own, such as most family
dependants — in which case the request is confirmed on the member's behalf at
creation and goes straight to the same review queue. Either way, approval is a
separate admin decision per participant.

## Refund Policy

Paid membership subscriptions are not refunded. Approval stops future
membership obligations and disables the local membership, but money already paid
stays with the club.

Unpaid or overdue membership subscriptions are cleared in Xero. The cancellation
approval path queues a Xero credit note against the subscription invoice so the
invoice is no longer due.

## Scenarios

### PAID Subscription

The member has already paid the season subscription invoice.

- Admin approval cancels the local membership.
- No Stripe refund is created.
- No Xero credit note is created for the paid subscription invoice.
- Any exception that needs manual handling should be tracked through the admin
  alert path.

### UNPAID Subscription

The member has a subscription invoice that has not been paid.

- Admin approval cancels the local membership.
- The existing Xero cancellation path queues a credit note for the unpaid
  invoice.
- The credit note is allocated against the invoice so it is no longer due.

### OVERDUE Subscription

The member has a subscription invoice that is overdue.

- Admin approval cancels the local membership.
- The existing Xero cancellation path queues a credit note for the overdue
  invoice.
- The credit note is allocated against the invoice so the overdue balance is
  cleared.

### Mixed Family Group

A family cancellation can include participants with different subscription
states.

- Each participant is reviewed and processed independently.
- Paid participant subscriptions remain non-refundable.
- Unpaid or overdue participant invoices are cleared with allocated Xero credit
  notes.
- The family request completes only after all included participants are resolved
  through approval, rejection, withdrawal, or decline.

## GST Treatment

For unpaid or overdue subscriptions, the Xero credit note reverses the GST on
the original subscription invoice. Paid subscriptions are not credited, so no
GST reversal is created for those invoices.
