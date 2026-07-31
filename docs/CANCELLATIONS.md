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
booking request. Those are refused silently on the admin member page: no
cancellation action is offered there, and there is nothing to explain, because
there is no membership being withheld. The member-raised route answers in
words instead — it says plainly that the login holds no membership of its own —
but that answer is reachable only through the member cancellation API, never
through the profile page: the authenticated layout sends a lodge-only login
straight to `/lodge/kiosk`, so the kiosk can never render the panel. The wording
exists so that a direct call gets a truthful reason rather than a bare refusal.

"The lodge kiosk device login" means a record whose *whole* account type is the
kiosk — the one the member page's User Type shows as **Lodge (kiosk account)**.
Ticking the **Lodge** access role on a real person, so they can use the kiosk
and the lodge operations tools, does not make them a device and does not hide
the cancellation action, as long as they hold some other role too (an admin
bundle, a finance role, or a club-defined custom role). A person given *only*
the Lodge role and nothing else is indistinguishable from the kiosk account, and
is treated as one — their member page says so, in the same User Type field.

Two consequences of classifying by *whole account type*, recorded so neither is
a surprise. First, the reverse also holds: if an operator deliberately grants
the kiosk login an admin bundle or another privileged role, it stops being
classified as a device and becomes cancellable (and selectable when booking on
behalf of someone). That is the intended flip side of the rule, and an operator
handing the shared kiosk real admin access is a larger problem than either
consequence. Second, the account type shown on the member page is derived from
a member's access-role rows, while the cancellation rule also folds in the two
legacy `role` / finance columns; a record whose legacy column disagrees with its
rows could therefore show one thing and behave as another. Every write path
since the access-role migration derives the legacy column from the rows, so this
is not reachable in practice today — it is written down because the rule above
leans on the page's label and the gate agreeing.

**Both routes ask the same question** (#2391). The **Membership Cancellation**
panel in a member's own profile uses the rule above, exactly as the member page
does: an admin may start their own cancellation from their profile, an
organisation may start its own, and a relative who is also an admin appears in
the family list like anyone else. The self-service route adds two conditions,
and only two, because they are about being able to use your own profile at all:
the account must be **active** and must have **its own login**. A membership
with no login of its own — most family dependants — is therefore cancelled
either by a relative who includes them in a family request, or by an admin from
the member page; nothing is uncancellable. The lodge kiosk login and the
booking-request contact records are refused here as well, for the same reason as
above: they hold no membership.

A request you raise for your own membership needs no email confirmation — you
have just asked for it, so it is confirmed at creation and goes straight to the
review queue, exactly as an admin-raised request does. Only *other* adults with
their own login are emailed a confirmation link. That is what makes an
organisation's own cancellation work: an organisation account has no separate
person to confirm on its behalf, and nothing is left waiting on an email nobody
would answer.

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

An admin may raise a cancellation request against their own membership — from
the member page, or from the **Membership Cancellation** panel in their own
profile like any other member. They
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
- **A cancellation is refused while the member's Xero contact still has money
  owing** — see [Unpaid invoices block approval](#unpaid-invoices-block-approval)
  below. This matters most for organisation and school accounts, which are
  usually the invoice contact for their booking invoices rather than only their
  own membership.

## Unpaid Invoices Block Approval

Approving a cancellation archives the member's contact in Xero when **Archive
Xero contacts after cancellation approval** is switched on. An archived contact
drops out of Xero's pickers and can no longer have invoices, credit notes or
payments raised against it, so archiving one the club is still chasing money
from — or still owes money to — takes a live account out of circulation. The
approval is therefore **refused** while anything is outstanding (#2392).

### What counts as outstanding

An invoice blocks when Xero says it is **AUTHORISED or SUBMITTED with an amount
still due**. That is the same definition of "open" the finance dashboard ages,
so the club has one meaning of the word:

- **Drafts do not block.** A draft has never been issued and creates no
  obligation on anybody.
- **Submitted invoices do block.** They are issued and awaiting internal
  approval, and Xero already ages them as receivables.
- **Voided and deleted invoices never block.** They are cancelled documents
  owing nothing — and voiding is one of the ways to clear this refusal.
- **Paid invoices never block**, because Xero takes the amount due to zero and
  flips the status to PAID once payments and credit notes fully settle it.
- **A credit note that only partly offsets an invoice still blocks**, on
  whatever is left. The figure the reviewer is shown is the remaining balance,
  not the original total, because the remainder is what the accounts are still
  waiting for.
- **Bills block too.** If the club owes this contact money, archiving it is the
  same mistake in the other direction.

The member's own current-season subscription invoice is deliberately **not**
counted when the cancellation is about to credit it. Approval raises an
allocated credit note against an unpaid or overdue subscription invoice — that
is the [refund policy](#refund-policy) — so counting it would make the most
ordinary cancellation there is impossible to approve: the thing that clears the
invoice is the very approval being refused.

That exclusion covers the **current** season only, which is the same season the
approval credits. A club that raises next season's subscription invoices early
therefore leaves a cancelling member holding an unpaid invoice for a season the
cancellation does not credit, and the approval is refused on it. That is not a
deadlock — voiding it in Xero is right, since the member is leaving and will not
be billed for it — but at an early-renewal club it is a step to expect every
pre-season rather than an oddity.

Two rows that are always safe to act on but worth recognising:

- **An invoice with no number.** Xero leaves the number blank on plenty of
  bills. The queue names those by their Xero id and links them, because a Xero
  id is not something you can search for — follow the link rather than trying to
  find the row by hand.
- **A contact already archived in Xero.** The check does not read invoices on
  already-archived contacts, matching every other Xero read in the app. Approval
  archives nothing new in that case, so nothing changes that was not already
  true, but it does mean this is the one situation where open invoices are not
  reported before approval.

### Clearing the refusal

The refusal names each invoice and its balance, and there is always a way
forward. Any one of these works:

- Take the payment in Xero, or
- Raise a credit note in Xero and **allocate** it against the invoice, or
- Void the invoice in Xero — the right answer when nobody intends to collect it,
- or switch **Archive Xero contacts after cancellation approval** off, which is
  an honest escape hatch rather than a bypass: with it off, approval never
  archives the contact, so the accounts keep it and every invoice on it stays
  exactly as actionable as before.

### When Xero cannot be asked

If Xero is disconnected, rate limited, or simply unreachable, the check cannot
run — and **the approval is still refused**, deliberately. "We could not find
out" is not the same answer as "nothing is owing", and the two mistakes are not
equal: a refusal is temporary and costs nothing (the request stays in the queue
and approves as soon as Xero answers), while letting it through queues an
archive that runs later, quietly, against a contact the accounts still need.
During a Xero outage the archive would fail and sit in the outbox anyway, so
almost nothing is lost by waiting.

The reviewer is told which situation it is, because they need different actions
— and **every one of them also names the escape hatch**, because a refusal whose
only advice is "wait" is exactly the held-hostage cancellation this feature
exists to prevent:

- **Xero is not connected** — reconnect it from the admin Xero page. This one
  needs an admin to do something; it will not clear on its own.
- **Xero could not be reached** — try again in a few minutes.
- **Xero's API limit is in force** — try again once it resets. Xero's daily
  limit resets at midnight UTC, which is about midday in New Zealand, so this
  can be most of a working day away; the notice says so, so the reviewer can
  judge whether to wait or use the escape hatch.
- **Xero refused the request** — almost always a stored Xero contact that has
  since been merged or deleted there. Waiting will not fix this one: re-link the
  member to their Xero contact from their member page.
- **The contact has more open invoices than the check can list** — settle or
  void them in Xero, starting from the contact's own page. Waiting will not fix
  this one either.

In every case, switching **Archive Xero contacts after cancellation approval**
off clears the way: with it off no contact is archived, so the check is not
needed at all.

This check only runs when it can matter. If **Archive Xero contacts after
cancellation approval** is off, nothing is archived, so no check is made and a
Xero outage cannot hold up a single cancellation. If the member has no linked
Xero contact at all, there is no contact to archive, so again nothing is checked
— a club that does not use Xero never sees this refusal. The one exception is a
settings read that fails outright: "we could not find out whether archiving is
on" is not "archiving is off", so the check runs anyway and answers honestly.

### The archive checks again before it runs

Approval is not the last word, because the archive itself happens later, off the
outbox queue — sometimes much later, if Xero is disconnected when the
cancellation is approved. A cancellation approved while archiving was switched
**off** ran no check at all; if an admin switches archiving on afterwards, that
queued operation would archive the contact having never been checked.

So the same question is asked again, live, immediately before the archive runs.
If money is owing by then — or the check cannot be run — the archive is
**deferred** rather than performed: the operation is retried, so it completes by
itself once the invoice is paid, credited or voided, and until then it shows up
as a stuck Xero operation rather than quietly doing the wrong thing.

The refusal is raised at **approval**, not when the request is raised, and the
outstanding invoices are shown in the review queue beside each participant that
is **ready for review**. A member-raised request sits in *Awaiting confirmation*
until the member confirms their own cancellation, and blockers are not loaded
for a participant in that state — so the invoices appear once the request is
confirmed and ready to review, which is when they can be acted on anyway. A
request is never rejected for a debt that may well be settled by the time
somebody reviews it.

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
