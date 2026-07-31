# Bookings Setup

Audience: Operator

## What it is

A small hub that gathers the booking-related setup pages you revisit less often
than the daily booking queues. It links to two places: **Rooms & Beds** (the bed
inventory) and **Booking Messages** (member-facing booking copy), and carries one
settings card of its own: **Member guests** (the member-guest consent policy,
#2307). Find it at **Admin → Setup & Configuration → Bookings Setup**
(`/admin/bookings-setup`).

Which cards you see depends on your permissions and the active modules — the
Rooms & Beds card follows the `bedAllocation` module.

## When you'd use it

- You are setting up (or adjusting) the lodge's rooms and beds.
- You want to edit the wording members see during booking and payment.
- You are configuring the **Member guests** policy — whether the other member is
  asked first, how long a consent request waits, and whether members can find
  each other by name.
- You are looking for the less-frequent booking configuration pages in one
  place.

## Step-by-step

### Open the hub and pick a card

1. Go to **Admin → Setup & Configuration → Bookings Setup**.

   ![Bookings Setup hub: two cards — Rooms & Beds and Booking Messages](../images/admin/admin-bookings-setup.png)

2. Choose a card:
   - **Rooms & Beds** (`/admin/rooms-beds`) — configure lodge rooms, active
     beds, and the bed-allocation inventory. (When the `bedAllocation` module is
     on, a lodge's capacity is its active bed count.)
   - **Booking Messages** (`/admin/booking-messages`) — edit the member-facing
     booking, payment, cancellation, and group-booking copy. See the
     [Booking Messages](booking-messages.md) guide.

### The Member guests card (#2307)

Below the hub cards sits the **Member guests** settings card. It controls the
"+ Add Member Guest" feature (the `memberGuests` module):

1. **Does the other member have to agree first?** — *Ask them first* (the
   default: the member is emailed and a bed is held until they answer) or *Just
   tell them* (the guest is added straight away and the member is emailed to say
   so; they can still take themselves off).
2. **How long to wait for an answer** — 1 to 60 days (default 7). After this the
   request lapses on its own, the bed is released, and the person who made the
   booking is told. A request never outlives the stay: it always lapses at least
   a day before check-in.
3. **Finding the other member** — two privacy toggles, both off by default.
   *Let members search by name* makes your membership list browsable to any
   member; *Include under-18s in name search* extends that to children. Each
   carries its warning on the card. Per owner decision D-18 these two settings
   **never travel in club config transfer**; the module switch, the ask-first
   choice and the waiting period do.

The card stays editable while the `memberGuests` module is off — a banner says
nothing is in use yet, so you can configure the policy first and then turn the
module on under **Admin → Modules**. With bookings *view* access (not edit) the
card renders read-only with a banner saying so; there is never a Save button
that would be refused.

## Settings reference

Apart from the Member guests card, this page is a launcher, not a settings
screen.

| Card | Goes to | What it configures | Gating |
| --- | --- | --- | --- |
| Rooms & Beds | `/admin/rooms-beds` | Lodge rooms, active beds, bed-allocation inventory | Follows the `bedAllocation` module |
| Booking Messages | `/admin/booking-messages` | Member-facing booking/payment/cancellation/group copy | Support permission area |
| Member guests (card on this page) | — | Ask-first vs tell, consent waiting period, name-search privacy toggles | Bookings permission area (view = read-only) |

If no cards are available, the page shows "No setup pages are available for your
current permissions."

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "No setup pages are available for your current permissions" | Your role lacks access to both linked pages | Ask a full admin for the relevant access |
| The Rooms & Beds card is missing | The `bedAllocation` module is off | Enable it under **Admin → Setup → Modules** — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Booking Messages](booking-messages.md),
  [Bed Allocation](bed-allocation.md), [Bookings](bookings.md).
- Reference: [lodge settings](../../CONFIGURATION.md#lodge-settings) and the
  [capacity model](../CAPACITY_MODEL.md#two-distinct-quantities).
