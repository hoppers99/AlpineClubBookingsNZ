# Booking Requests

Audience: Operator

## What it is

A three-tab console for the requests that need an officer's decision before they
become (or change) a booking:

- **Approvals** — new bookings flagged for review (for example minors booked
  without an adult).
- **Changes** — change requests on bookings whose dates are locked (same-day or
  past nights).
- **Public Requests** — booking enquiries from non-members and school groups,
  which you price, quote, and approve.

Find it at **Admin → Bookings & Beds → Booking Requests**
(`/admin/booking-requests`). When any of these queues has pending items it also
appears under **Admin → Needs Attention → Booking Requests**.

> The two older routes **`/admin/booking-approvals`** and
> **`/admin/booking-change-requests`** are redirects: they open this page on the
> **Approvals** and **Changes** tabs respectively. They have no separate screen,
> so they are documented here.

Money is integer cents (shown as dollars); dates are NZ date-only lodge nights.
Every approve/reject/decline flow asks whether to email the member, and records
your choice in the audit log — except on a booking that has **No emails**
switched on ([Bookings](bookings.md#turn-off-all-emails-for-one-booking)), where
nothing can be sent either way, so the dialog says so instead of asking. On a
silenced booking a **reject** emails the member nothing at all: the cancellation
notice that normally always goes out is withheld too, and the withheld messages
are listed on the booking for you to relay.

## When you'd use it

- A booking is held for review and a member is waiting to hear if it is
  approved.
- A member asks to change a booking whose dates are already locked.
- A non-member or school submits a request through the public form and you need
  to price it, send a quote, and turn it into a booking.

## Step-by-step

### Approvals — decide a flagged booking

1. Open **Booking Requests**; the **Approvals** tab is selected by default.
   Filter by **Pending**, **Approved**, **Rejected**, or **All**.

   ![Booking Requests, Approvals tab: a pending review card for a member with Approve and Reject and cancel buttons](../images/admin/admin-booking-requests.png)

2. Each card shows the member, the dates, status, total, and guests, plus the
   member's reason for booking (for example "Club committee trip, approved
   verbally by President"). Use **view booking** to open the full booking.
3. In **Admin notes**, explain your decision (required to reject, optional to
   approve).
4. Click **Approve** or **Reject and cancel**. Choose whether to email the
   member in the dialog. A rejection always sends the member the standard
   cancellation notice.

### Changes — acknowledge a locked-period change request

1. Switch to the **Changes** tab. Filter by **Requested**, **Approved**,
   **Rejected**, or **All**.

   ![Booking Requests, Changes tab: a locked-period change request with Admin notes and an Acknowledge as approved button](../images/admin/admin-booking-requests-changes.png)

2. Read the request summary and reason, then use **Open booking** to make the
   actual edit on the booking page — approving here only *acknowledges* the
   review; it does not change the booking automatically.
3. Optionally paste the **Linked booking modification id** from the booking's
   audit trail so the request and the change are linked, then click
   **Acknowledge as approved** or **Reject**.

### Public Requests — price, quote, and approve a non-member request

1. Switch to the **Public Requests** tab. A badge shows how many verified
   requests are waiting in the **Queue**. Filter by any request status (Queue,
   Awaiting verification, Verified, Priced, Quoted, Quote sent, and so on).

   ![Booking Requests, Public Requests tab: the status filter row and the flow explainer for non-member requests](../images/admin/admin-booking-requests-public.png)

   (The screenshot predates the **Guest request form link** field described
   next, so that field is not in it; recapture is tracked in #2429.)

   At the top of the tab is **Guest request form link (unlisted)** with a
   **Copy** button. That is the URL of the guest request form
   (`/booking-requests`), and this is the only place in the app that shows it:
   the form is **deliberately unlisted** — no page a visitor can browse to
   links to it, and it is excluded from search engines via a route-level
   `noindex` (`robots.txt` deliberately does *not* disallow it, so crawlers can
   fetch the page and see the noindex rather than merely listing the bare URL).
   The only other path in is the **Book these dates again** button on a
   tokenised payment link the club itself emailed a past requester, so it
   reaches nobody the club has not already dealt with. Send the link to a guest
   the club has agreed to host, and to nobody else. The field is available to
   view-only admins too, since sharing the link is not a booking write. Whether
   the club hosts non-members at all is the club's own policy; the public
   website never states or implies that a non-member can simply book (#2421).

2. Open a **Verified** request. Set the **Pricing mode** (Overall total or Per
   guest-night) and enter the price, then **Save quote** and **Send quote** to
   email the requester a quote link.
3. When the requester accepts (or for a priced general request), click
   **Approve & send payment link** (general) or **Approve & invoice school**
   (school groups) to convert it into a booking. Use **Decline** with an
   optional reason to turn it down.

#### Member whole-lodge requests

A signed-in member can ask to book the **whole lodge** for their party. These
requests appear in the same **Public Requests** queue with a **Member** and a
**Whole lodge requested** badge. Approving one holds the whole lodge for the
group. Before you approve you set:

- **Headcount to book and price** — confirm the real number with the member; the
  member's figure is only an estimate.
- **Total price override (optional)** — a manual total. It is required when no
  season covers the dates (there is no separate quote step on this path), and it
  always wins over every other pricing method.

If the covering season has a **flat whole-lodge night rate** set (see
[Fees](fees.md)), you also get a **How to price this whole-lodge booking**
choice on that one approval:

- **Price per guest** (the default) — each guest at the season rate, as usual.
- **Price as whole lodge** — the season's flat rate per night for the whole
  building, regardless of headcount. The panel shows the total; a stay that
  crosses a season boundary is charged each night at that night's season rate.

The choice is yours per approval — it is never automatic. A total price override
still overrides whichever method you pick. Then click **Approve & hold the whole
lodge**.

**If you link a guest row to a real member account** (#2309). A request's guest
list is free-text names, but you can attach a place to an actual member so it
prices at member rates. With the **Add another member as a guest** module on,
that link is now recorded and the member is told:

- Holding beds for the quote, and approving the request, both put a note against
  the guest row naming **you** as the officer who placed them, and email the
  member to say they are on a lodge booking created from a booking request. You
  cannot turn that email off; the booking's **No emails** switch is the only
  thing that withholds it, and a withheld send is listed on the booking's
  withheld-emails banner.
- **Nobody is asked first on this path**, whatever the club's ask-first setting
  says. A booking request is the club placing somebody, not a member asking a
  favour, so no bed is held pending an answer.
- **If you change who is on a place between the quote and the approval**, both
  people are told — the new person that they are on it, the person you replaced
  that they are not. That matters because the guest row keeps its identity so
  pre-assigned beds survive, which means a swap looks like an ordinary edit and
  would otherwise be silent.
- **These members cannot take themselves off.** A booking priced by hand refuses
  guest changes from a member's account, so the email tells them to contact the
  club and names the real remedies — you cancel the booking, or re-quote the
  request without them. Expect the call.

With the module off, none of this happens and a linked guest row behaves exactly
as it did before.

## Settings reference

This is a work queue. The controls per tab:

Each tab keeps **Reset** visible beside its status choices. Reset restores that
tab's default queue, while preserving the tab itself, any focused booking or
request id, and unrelated URL context. A focused Approvals or Changes record
therefore keeps its **All** context rather than disappearing from view.

| Tab | Filters | Key actions |
| --- | --- | --- |
| Approvals | Pending (default), Approved, Rejected, All | Approve; Reject and cancel (Admin notes required to reject) |
| Changes | Requested (default), Approved, Rejected, All | Acknowledge as approved; Reject; optional linked modification id |
| Public Requests | Queue (default), Awaiting verification, Verified, Priced, Quoted, Quote sent, Query, Modify, Accepted, Approved, Declined, Cancelled, Converted, All | Save quote; Send quote; Approve & send payment link / Approve & invoice school; Decline; Hold slots (school) |

Notes and constraints:

- Prices are entered in dollars and stored as integer cents; dates are NZ
  date-only nights.
- School group requests add per-tier guest counts and a soft group-size cap
  that warns you to confirm a club member is staying with the group.
- Verified public requests only appear on this tab — never under Approvals, the
  Bookings list, or the Waitlist.
- If any of a request's saved details cannot be read back (an old or imported
  row with a missing surname, say), the request still appears in the list —
  including under **All** — under a **Saved details need attention** note. One
  unreadable row never hides the rest of the queue. The note names only what
  actually failed: the guest list (names and age groups are then shown as they
  were saved, so treat them as a rough record), the member links (none are
  shown), or the saved quote (its options and totals are not shown). On a
  request that is still open, Save quote, Send quote, Hold slots and Approve
  are turned off, and the server refuses all four plus pricing even if
  something calls them directly, so it cannot become a booking. There is no
  screen for repairing the saved data: check what the group wants with the
  requester, then **Decline** the request so they can submit again, or ask
  support to repair the stored row. On an already-converted or finalised
  request nothing is blocked — the note is there so you know the details it
  shows are not confirmed (#2342).
- If your admin role is view-only for bookings, a notice explains you can view
  but not approve, reject, price, hold, or convert requests.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Reject is blocked | You left **Admin notes** empty | Add a note explaining the decision, then reject |
| A change I "approved" did not change the booking | Approving here only acknowledges the review | Open the booking and apply the change on the booking page |
| A new public request is not on the Approvals tab | Public requests live only on the Public Requests tab | Switch to **Public Requests** and check the **Queue** filter |
| Approve fails with a capacity message | The lodge is full for one or more nights | The dialog lists the full dates; free capacity or adjust the request |
| Cannot price/approve anything | Your role is view-only for bookings | Ask a full admin for bookings edit access |
| A request says **Saved details need attention** and its buttons are greyed out | Some of its saved data could not be read back, so it cannot be quoted, priced, held, or approved | Confirm what the group wants with the requester, then **Decline** so they can submit again — or ask support to repair the stored row. There is no guest-edit screen |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Bookings](bookings.md), [Book on Behalf](book.md),
  [Booking Policies](booking-policies.md), [Payments](payments.md).
- Reference: the
  [booking lifecycle](../STATE_MACHINES.md#booking-lifecycle), the
  [booking modification lifecycle](../STATE_MACHINES.md#booking-modification-lifecycle),
  and the
  [public booking request quote lifecycle](../STATE_MACHINES.md#public-booking-request-quote-lifecycle).
