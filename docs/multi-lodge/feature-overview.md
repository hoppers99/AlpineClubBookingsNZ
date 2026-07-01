# Multi-Lodge Feature Overview

What multi-lodge support does and how it behaves for each kind of user.
This is the intent document: if implementation and this description
diverge, one of them is wrong and the PR should say which. Decision
rationale lives in the ADRs; delivery sequencing lives in
`implementation-plan.md`.

## Purpose

Some clubs operate more than one lodge — two today for the club driving
this work, three for others in the community. Each lodge is a separate
building with its own rooms, beds, bed count, door code, travel
directions, chores, and possibly its own season dates and nightly rates.
Members belong to one club and hold one membership, but stay at
different lodges at different times.

Today the software assumes exactly one lodge. Multi-lodge support makes
the lodge a first-class concept so that one deployment can run several
lodges without splitting the club's membership, finances, or admin
across separate installations.

## What a Lodge Is

A lodge is a bookable property with:

- its own rooms, beds, and lockers (names unique within the lodge, so
  both lodges can have a "Bunkroom 1")
- its own nightly capacity, derived from its own beds
- its own seasons and rates when needed (a road-end lodge and a
  ski-in lodge may price differently)
- its own chore list and roster
- its own door code, travel notes, and arrival instructions
- optionally its own cancellation, minimum-stay, and booking-period
  rules, when the club decides a lodge needs them (otherwise club-wide
  rules apply everywhere)

Everything else — members, families, membership types, applications,
payments, credits, promo codes (unless deliberately restricted), the
Xero connection, email, committee, and reporting — belongs to the club,
not to a lodge.

## Experience by User

### Clubs with one lodge

Nothing changes. The `multiLodge` module ships disabled; the club's
single lodge exists in the data model but never appears in the UI. No
selector, no lodge names in emails or screens, no new admin pages. This
is the permanent default for upstream and every single-lodge fork, not
a transition state.

### Members (once a second lodge exists)

- Booking starts by choosing a lodge, then dates. Availability
  calendars, quotes, and prices are for that lodge only.
- A booking belongs to exactly one lodge. Booking both lodges for the
  same trip means two bookings (the existing group-booking linking can
  tie them together).
- Confirmation and pre-arrival emails carry the right lodge's name,
  travel notes, and door code.
- If the committee restricts a lodge (for example, one lodge is
  reserved for a section of the club), ineligible members simply do not
  see it offered. By default every member can book every lodge.
- Cancellation and refund rules are the club's, unless the lodge they
  booked has its own published rules — whatever applies is what the
  booking flow displays.

### Admins

- A new Lodges page (visible only with the `multiLodge` module enabled)
  manages lodge identity: name, active state, door code, travel notes.
- Rooms/beds, lockers, seasons/rates, chores, and bed allocation are
  managed per lodge — the existing pages gain a lodge context selector
  when more than one active lodge exists, and look exactly as they do
  today otherwise.
- Booking lists, search, and dashboards can filter by lodge; admins
  always see all lodges' data. There is no per-lodge admin role.
- Policy pages keep editing the club-wide rules by default, with an
  explicit "this lodge has its own rules" override path per lodge.
- Promo codes gain an optional restriction to selected lodges. An
  unrestricted promo works everywhere, including at lodges created
  later.

### Hut leaders and kiosks

- A hut-leader assignment is for one lodge. Their PIN, roster, chore
  sign-off, and guest lists are that lodge's only.
- A kiosk device belongs to one lodge and shows only that lodge's
  arrivals, departures, and roster.

### Treasurer / finance

- One Xero connection, one ledger, one finance dashboard, unchanged.
  Bookings carry their lodge, so per-lodge revenue reporting is possible
  later (for example via Xero tracking categories), but nothing splits
  by default and no finance workflow changes.

## What Deliberately Does Not Change

- Membership, applications, families, subscriptions — club-wide.
- Payments and refunds — attached to bookings; money handling,
  integer-cent amounts, and Stripe flows are untouched.
- The Xero integration and its single operational connection.
- Module flags remain club-wide (chores are on or off for the club, not
  per lodge).
- Waitlist, group bookings, credits, and cancellation flows keep their
  behaviour — they gain lodge awareness, not new rules.

## Worked Examples

1. **Same weekend, both lodges.** The Smith family books Lodge A for
   Saturday; the club's school group fills Lodge B the same night.
   Lodge B being full has no effect on Lodge A's availability, and vice
   versa. Each booking prices from its own lodge's season rates.
2. **Lodge-specific promo.** The committee creates SPRING25 restricted
   to Lodge B to lift shoulder-season occupancy. It applies on Lodge B
   bookings and is rejected (with a clear message) on Lodge A bookings.
3. **Policy override.** Lodge B is remote and expensive to service, so
   the committee gives it a 14-day cancellation tier set. Lodge A keeps
   the club-wide 7-day rules. A member cancelling sees the rules for
   the lodge they booked.
4. **Hut leader.** Sam is hut leader at Lodge A this week. Sam's PIN
   works on Lodge A's kiosk, shows Lodge A's roster and guests, and
   does nothing at Lodge B.

## Boundaries and Non-Goals

- No per-lodge admin accounts or per-lodge module settings.
- No single booking spanning multiple lodges.
- No per-lodge Xero connections or ledgers.
- No cross-lodge waitlist (a waitlist entry is for the lodge that was
  full; offering an alternative lodge is a possible future enhancement,
  not part of this work).
- Lodge count is unbounded in the data model, but the UI is designed
  for the realistic case of two to a handful of lodges, not dozens.
