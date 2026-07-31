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

## Who Can Be Cancelled

Every account holder's membership is cancellable from their admin page,
whatever else is true about them (#2383):

- Ordinary members, and members with no login of their own such as most family
  dependants.
- Admins of every class — Full Admin, Membership Officer, Booking Officer,
  Treasurer, Content Manager, and holders of club-defined custom roles. Holding
  admin access is not a reason to refuse: an admin is a fee-paying member like
  anyone else, and cancelling no longer requires their access to be destroyed
  first (which the member page cannot undo).
- Organisation and school accounts, which hold real fee-paying memberships.

Only two kinds of record are refused, because they are not account holders and
have no membership to cancel: **the lodge kiosk device login**, and **the
booking-request contact records** — the guest contact minted by a public booking
request, and the school owner contact and teacher records minted by a school
booking request. Those are refused silently: no cancellation action is offered
on their page, and there is nothing to explain, because there is no membership
being withheld.

"The lodge kiosk device login" means a record whose *whole* account type is the
kiosk — the one the member page's User Type shows as **Lodge (kiosk account)**.
Ticking the **Lodge** access role on a real person, so they can use the kiosk
and the lodge operations tools, does not make them a device and does not hide
the cancellation action, as long as they hold some other role too (an admin
bundle, a finance role, or a club-defined custom role). A person given *only*
the Lodge role and nothing else is indistinguishable from the kiosk account, and
is treated as one — their member page says so, in the same User Type field.

**The member-raised route is narrower than this.** Everything above describes
the admin-raised route, from a member's admin page. Members using
**Cancel Membership** in their own profile still see the older, narrower rule:
that self-service flow is offered only to ordinary member accounts, and only
ordinary member accounts appear in its family list — so an admin, or an
organisation account, must be cancelled by an admin from the member page.
Widening the self-service flow is tracked separately; nothing about the
admin-raised route depends on it.

Cancellation eligibility is deliberately not a permissions question. Two
separate rules govern the **approval** of a cancellation against an account that
holds privileged access, and both are enforced server-side inside the approval
transaction (#1604/#1622):

- Only a Full Admin may approve a cancellation for an account holding any
  privileged access role. A scoped admin may raise the request, but not approve
  it.
- **The club can never be left with no Full Admin.** Approving a cancellation
  disables the member's login, so if the target is the last active,
  login-enabled Full Admin the approval is refused — by anyone, including
  another Full Admin, and including the admin themselves. Give another active
  account Full Admin access first, then approve.

Because any account holder can now be raised, the review queue labels what is
being cancelled: a participant who holds admin access is marked (approving that
one needs a Full Admin — the badge uses the guard's own test), and an
organisation account is marked as one. The reviewer is the last human check
before an approval that is allowed but mistaken.

An admin may raise a cancellation request against their own membership. They
cannot then approve it: cancellation approval always requires a different admin.
A club's only Full Admin therefore cannot complete their own departure alone —
they must appoint a successor Full Admin, who then approves. This is deliberate,
and is the same separation-of-duties rule the archive and deletion queues use.
If the admin who raised a request has since been deleted from the club records,
approval is refused rather than allowed — with the raiser gone there is no way
to show the approval was independent. Reject that request and raise a new one.

Approving a cancellation does **not** delete the member's access roles. It sets
the account **inactive** — which is what actually stops every admin area, since
every server-side admin check re-reads it — and disables the login, and leaves
the dormant role rows in place, the same as archive and deletion approval do, so
the account stays protected by the Full-Admin-only rule above if it is later
archived.

Two consequences of that worth knowing before you approve:

- **A cancelled ex-admin cannot be hard-deleted.** Deletion refuses any account
  that still holds admin access, and cancellation deliberately keeps the rows.
  Remove the roles first if the club also wants the record deleted.
- **Approving an organisation or school account's cancellation can archive a
  Xero contact that is still billing.** When "archive Xero contacts on
  cancellation" is switched on, approval queues an archive of the member's Xero
  contact — and for an organisation that is often the invoice contact for its
  booking invoices. The approval blockers cover future bookings, not open
  invoices, so check the organisation has nothing outstanding in Xero first.

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
