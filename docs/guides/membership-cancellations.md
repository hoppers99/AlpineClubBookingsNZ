# Cancellation Requests

Audience: Operator

## What it is

The review queue for members leaving the club: **membership cancellation
requests** (approve or reject per person, with a member-email choice) and
**member archive requests** (approve or reject, with a two-admin rule). Find it at
**Admin → Members → Cancellation Requests** (`/admin/membership-cancellations`).
It also appears under **Needs Attention** while requests are pending.

The member-facing wording and the Xero contact-group handling behind these
requests are edited on a separate **Membership Cancellation** settings page —
covered in [its own section below](#cancellation-copy-and-xero-settings).

Cancellations are a **membership** permission area: membership view to read the
queues, membership **edit** to approve or reject. Paid subscriptions are never
refunded here; unpaid or overdue subscription invoices are cleared with an
allocated Xero credit note.

## When you'd use it

- A member has requested to cancel their membership and you need to review it.
- You need to cancel a membership on a member's behalf — for example someone
  who rang the club, or a member with no login of their own (most family
  dependants). Open their member page and use **Request Cancellation**: the
  request is confirmed on their behalf and lands in the queue below for a
  normal approval decision. This works for anyone who holds a membership,
  including a member who is also an admin and including a school or
  organisation account; you no longer have to strip an admin's access first.
  See [who can be cancelled](../CANCELLATIONS.md#who-can-be-cancelled) for the
  two record types that are not offered the action, and for the two rules that
  govern approving a cancellation for an account with admin access.
- An admin has requested to archive a member and a *different* admin must approve.
- You are auditing completed, rejected, or withdrawn lifecycle requests.

## Step-by-step

### Review the queues

1. Go to **Admin → Members → Cancellation Requests**. The page shows an **Archive
   Review Queue** and a **Cancellation Review Queue**, with a status filter (Open,
   Completed, Rejected, Withdrawn, All) and a **Refresh** button.

   ![Cancellation Requests page: the status filter, the Archive Review Queue, and the Cancellation Review Queue](../images/admin/admin-membership-cancellations.png)

### Approve or reject a cancellation

1. In the **Cancellation Review Queue**, open a request and its participants. A
   participant can be approved once its status is *Ready for review* and the
   member has confirmed; if bookings are outstanding, or the member's Xero
   contact still has money owing, an amber notice lists them and says what to do
   — resolve those first. Each invoice in that notice is a link into Xero, and
   the notice also links straight to the Membership Cancellation settings page
   if the club would rather not archive Xero contacts at all. See
   [unpaid invoices block approval](../CANCELLATIONS.md#unpaid-invoices-block-approval)
   for what counts as owing and the ways to clear it.
2. Add an optional **Admin note** (sent to the member and the audit log). The blue
   notice reminds you: paid subscriptions are not refunded; unpaid/overdue
   subscription invoices are cleared with an allocated Xero credit note.
3. Click **Approve** or **Reject**. A dialog asks whether to email the member —
   the request is processed either way and your choice is recorded in the audit
   log.
4. After an approval, an amber notice may appear listing **family links that
   were cleared**. Cancelling a member removes their parent links and any link
   pointing at them, so if the cancelled member sat in the middle of a family —
   someone's child *and* someone's parent — their own dependants are now left
   with no parent link recorded. They are deliberately not moved up to a
   grandparent: who is responsible for a member is a real-world fact, not
   something the system should decide for you. Link them under another parent if
   that is right for the family. The same notice lists anyone who was receiving
   club email at the cancelled member's address. Their email now goes to their
   own recorded address — which is often a COPY of the cancelled member's, and
   may be a placeholder that receives nothing, so check it. Both lists are also written
   to the audit log, so nothing is lost if you navigate away.

The same amber notice appears after approving an **archive** — archiving runs the
identical family-link sweep — and approving an **account deletion request** does
the same clean-up, additionally stopping club email being sent to the anonymised
address.

### Approve or reject an archive

1. In the **Archive Review Queue**, add an optional **Review note**, then click
   **Approve Archive** or **Reject**. If *you* raised the archive request, you
   cannot review it — a different admin must (this is enforced on the server too).

### Cancellation copy and Xero settings

The member-facing cancellation wording and Xero handling live on a separate
settings page — **Membership Cancellation** — reached from **Admin →
Notifications & Email** (`/admin/membership-cancellation`). It has no direct
sidebar entry and writes **membership** settings even though it sits under
Notifications.

![Membership Cancellation settings: the cancellation warning, rejoin process, Xero cancelled contact groups, and archive-on-approval controls](../images/admin/admin-membership-cancellation.png)

There you can edit:

- **Cancellation warning** — the text shown to a member starting a cancellation.
- **Rejoin process** — the text explaining how a cancelled member can rejoin.
- **Xero cancelled contact groups** — the Xero contact groups that represent
  cancelled members (each a Group ID + optional Group name; **Add Group** /
  remove).
- **Archive Xero contacts after cancellation approval** — whether approving a
  cancellation also archives the member's Xero contact. While this is on,
  approval is refused for anyone whose Xero contact still has money owing, and
  refused too if Xero cannot be asked; with it off no contact is archived, so
  that check is not made at all.

Click **Save Cancellation Settings**. These settings are audited and do not call
Xero on save.

## Settings reference

The review queue itself has no persistent settings — only per-review inputs.

| Control | What it does | Notes / constraints |
| --- | --- | --- |
| Status filter | Open / Completed / Rejected / Withdrawn / All | Default is Open |
| Admin note / Review note | Note sent to the member and the audit log | Up to 1000 characters |
| Notify choice (approve/reject) | Whether the member is emailed | Processed either way; recorded in the audit log |
| Approve Archive | Archives the member | Two-admin rule: the requester cannot approve |

Settings on the **Membership Cancellation** page: Cancellation warning (text),
Rejoin process (text), Xero cancelled contact groups (Group ID + name rows;
empty-ID rows are dropped on save), and Archive Xero contacts after cancellation
approval (checkbox).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Everything is read-only ("… can view membership cancellations but cannot approve or reject them") | Your admin role has membership view but not edit | Ask a full admin for membership edit access |
| A participant can't be approved | Bookings are outstanding, or the member has not confirmed their own inclusion (member-raised requests only — an admin-raised one is already confirmed) | Resolve the listed bookings; wait for the member to confirm their request |
| **Approve** says Xero still shows money owing, and names the invoices | Approving archives the member's Xero contact, and an archived contact cannot be invoiced, credited or paid — so the club would be archiving an account it still needs. Most often an organisation or school account, which is usually the billing contact for its booking invoices. Drafts, voided and paid invoices are ignored; a part-allocated credit note leaves the remainder, which still counts | The amber notice beside the participant lists them, each one a link into Xero — including bills and any invoice Xero never numbered, which are linked to the contact instead. Open each and do one of: take the payment, raise a credit note and **allocate** it against the invoice, or **void** the invoice if nobody intends to collect it. Then approve again. The member's own *current*-season subscription invoice is never the cause — the cancellation credits that one itself — but a *next*-season invoice at a club that bills early is not credited and does count; void it. If the club does not want Xero contacts archived at all, use the **Open Membership Cancellation settings** link in that same notice and switch **Archive Xero contacts after cancellation approval** off; that lifts the check entirely, because the contact is then left alone |
| **Approve** says Xero is not connected, so its unpaid invoices could not be checked | Approving would archive the member's Xero contact, and the club's Xero authorisation is missing or no longer valid, so the check could not run. An unknown answer is treated as "there may be money owing", never as "nothing owing" | Reconnect Xero from **Admin → Xero**, then approve again. If the club is not using Xero archiving, switch **Archive Xero contacts after cancellation approval** off instead — with it off no contact is archived, so the check is not needed. This one will not clear by itself |
| **Approve** says Xero could not be reached, or that its API limit has been reached | Same check, but a temporary failure rather than a broken connection | Wait a few minutes and approve again. Nothing is lost — the request stays in the queue, and during a Xero outage the contact archive would have failed anyway. The API limit is the slower one: Xero's daily limit resets at midnight UTC, about midday here, so if the cancellation cannot wait that long, switch **Archive Xero contacts after cancellation approval** off instead |
| **Approve** says Xero refused the request for this member's contact | The Xero contact stored against the member no longer exists there — usually merged into another contact, or deleted. Waiting will not fix it, because the request itself is the problem | Open the member's page and re-link them to the right Xero contact, then approve again. Or switch **Archive Xero contacts after cancellation approval** off, since with it off there is no contact to archive and no check to run |
| **Approve** says the contact has more open invoices than the check can list | Genuinely unusual — a contact carrying hundreds of open invoices. The check reads a bounded number of them, so rather than report a partial answer as "nothing owing", it says it could not tell | Open the contact in Xero and settle or void what is outstanding, then approve again. Or switch **Archive Xero contacts after cancellation approval** off |
| A refusal ends "The review queue below could not be reloaded either, so it may be out of date" | Two things went wrong at once: the approval was refused, and the automatic refresh that follows a refusal also failed — usually a dropped connection or a restart between the two | Treat the list on screen as stale. Press the refresh button beside the status filter, or reload the page, before acting on anything below. The refusal itself still stands and its reason is the first part of the same message |
| A member's page shows no **Request Cancellation** action | Their membership is already cancelled or archived, or is not active. Otherwise the record is not an account holder at all — the lodge kiosk account, or a booking-request contact (a public booking request's guest contact, or a school request's owner contact or teacher record). For a person, having no login does *not* hide it, and neither does holding admin access | Check the member's status first. If they are active and it is still missing, look at their **User Type**: "Lodge (kiosk account)" is the shared device login and has no membership — a real person who needs the kiosk should hold another role too — and a record created by a booking request is a contact, not a member |
| **Approve** on a cancellation says only a Full Admin can do it | The member holds a privileged access role (any admin, finance, lodge, or custom role), and only a Full Admin may approve a cancellation for such an account | Ask a full admin to approve it |
| **Approve** says this is the last Full Admin account | Approving would disable the login of the club's only remaining active Full Admin, leaving nobody able to administer the club | Give another active account Full Admin access first, then approve. This applies to an admin cancelling their own membership too — appoint your successor first |
| An admin cannot approve the cancellation they raised themselves | Cancellation approval always needs a different admin, including when an admin has raised it against their own membership | Ask another admin to review it |
| **Approve** says the admin who raised the request is no longer on file | That admin's record has since been deleted, so the club can no longer show the approval was a second pair of eyes | Reject the request and raise a new one; it can then be approved normally |
| Approve/Reject is disabled on an archive | You raised it — the two-admin rule needs a different reviewer | Ask another admin to review it |
| A refund didn't happen on cancellation | Paid subscriptions are not refunded; unpaid/overdue invoices are cleared with a credit note | This is by policy — see [`CANCELLATIONS.md`](../CANCELLATIONS.md#refund-policy) |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Members](members.md), [Subscriptions](subscriptions.md),
  [Refunds & Credits](refund-requests.md), [Deletion Requests](deletion-requests.md).
- Reference: the
  [membership cancellation, archive, and delete lifecycle](../STATE_MACHINES.md#membership-cancellation-archive-and-delete-lifecycle)
  and [refund and credit lifecycle](../STATE_MACHINES.md#refund-and-credit-lifecycle),
  the [refund policy](../CANCELLATIONS.md#refund-policy) and
  [GST treatment](../CANCELLATIONS.md#gst-treatment) in `CANCELLATIONS.md`, and
  the [Membership Cancellation Settings](../../CONFIGURATION.md#membership-cancellation-settings)
  reference.
