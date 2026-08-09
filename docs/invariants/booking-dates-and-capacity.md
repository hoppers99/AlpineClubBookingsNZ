# Booking Dates And Capacity

Audience: Developer, Agent.

Prefixes defined in this file: **`INV-DATE`** — what a lodge night is, when a
stay starts and ends, how dates are stored, compared and rendered — and
**`INV-CAP`** — how many beds exist, who consumes them, and how beds are
allocated.

This file also hosts one rule from another prefix: `INV-LIFE-062`, the custodian
bed hold, re-homed here from `membership-lifecycle.md` by #2706 because it is a
capacity invariant end to end. IDs are location-independent and the index is
authoritative for ID → file, so it keeps its number and its prefix.

Read this file when you are changing anything that decides which NZ calendar day
a booking touches, who is present on a day, how many beds a lodge has, or which
bed a guest is placed in.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added, and one relative link path was re-pointed
(`TESTING.md` → `../TESTING.md`).

## The stay boundary: midday NZ to midday NZ (normative)

### INV-DATE-001

This subsection is the normative stay-boundary invariant (epic #2629). It is
stated once, here; write any new stay-boundary sentence elsewhere as a
reference to this subsection rather than a restatement, fold restatements you
find into references as their files are touched, and measure every future
change in this area against it. All
times in this invariant are New Zealand time (Pacific/Auckland). UTC is never
a semantic boundary in this subsection; it appears only as the storage
encoding described at the end (and once as a code-level aside on weekday
derivation).

### INV-DATE-002

- **Lodge night.** Night N is the period from midday NZ on date N to midday NZ
  on date N+1. The boundary is fixed at midday NZ by definition (D-M3): there
  is no configurable boundary, and no time-of-day value participates in the
  stay boundary or in presence. (The kiosk arrive/depart stamps
  `BookingGuest.arrivedAt` / `departedAt` are action audit timestamps, never
  presence inputs. `Booking.expectedArrivalTime` is not one either: since #2621
  it is display-only information for the hut leader — shown on the kiosk and on
  the lobby wall's arrivals board, inside the wall's name-privacy gate — and it
  is read by no boundary, no presence decision and no chore assignment. A member
  who wants to leave before their check-out morning chore talks to the hut
  leader; the system records no departure time and infers none.)

### INV-DATE-003

- **Stay.** A stay is the half-open date range `[checkIn, checkOut)` expanded
  to nights — the motel rule: a guest is in the lodge from midday NZ on their
  check-in date to midday NZ on their check-out date. The check-out date is a
  departure morning, never an occupied night, which is why back-to-back
  handovers and same-day turnover on one bed need no special case. When
  explicit `BookingGuestNight` rows exist they are the authoritative night set
  and the contiguous envelope is ignored.

### INV-DATE-004

- **Presence on an operational day D** — the answer to every human-facing "who
  is here today" question (rosters, kiosk, manifests): morning half
  (midnight to midday NZ) iff D−1 is one of the guest's nights; evening half
  (midday NZ to midnight) iff D is one of their nights; present iff either
  half holds. Derived labels, never independent data: *arriving* =
  evening-half only; *departing* = morning-half only ("leaves today"). Sparse
  multi-segment stays follow the same rule per segment with no exception
  (D-M4): nights {5, 8} give presence on {5, 6, 8, 9} and absence on the gap
  day 7.

### INV-DATE-005

- **Two models, two helper families**, both in
  `src/lib/booking-guest-stay-ranges.ts`. The **night model**
  (`isGuestActiveOnNight` / `getActiveGuestsForNight`) is canonical for
  capacity, availability, pricing, bed allocation, whole-lodge and
  member-night logic — every per-night resource question; under it the
  departure date is never occupied. The **operational-day model** is canonical
  for chore-roster eligibility, the kiosk, print manifests and day statuses —
  every human-facing "who is here today" question. Ownership is strict in both
  directions: an operational-day caller must not reach the night helpers, and
  a capacity caller must not reach the operational-day ones.
  **The operational-day helpers** (#2622) are
  `getGuestOperationalDayPresence` (both halves plus the derived labels),
  `isGuestOperationallyPresentOnDay`, `isGuestArrivingOnDay`,
  `isGuestDepartingOnDay` and `getOperationallyPresentGuestsForDay`. They
  implement the pure rule above, sparse segments included, and take a private
  key-based copy of the night predicate rather than refactoring the frozen
  night helpers. **Status of the code against this rule:** chore-roster
  eligibility is converted. There is one chore-eligibility query,
  `getOperationalRosterGuestsForDate` (`src/lib/roster-eligibility.ts`), read by
  both the admin roster service and the kiosk generate route; roster-confirm
  validation and both chore-cleanup paths read the same helpers (D-M6), and the
  arriving/departing labels are derived from the night set on the operational
  date. **The sparse fix applies per converted surface, not globally.**
  `getLodgeVisibleGuestsForDate` survives as a deprecated wrapper carrying the
  LEGACY lodge-date meaning unchanged: `includeDepartureDate: false` is the
  night model, and `includeDepartureDate: true` admits the guest's own nights
  plus the single morning after their FINAL listed night (or, for an
  envelope-only guest, the closed range `[stayStart, stayEnd]`). It is
  deliberately NOT `getOperationallyPresentGuestsForDay`: the lobby wall
  (fenced, below) derives its night counts by subtracting only the envelope end
  from that list, so per-segment presence there would count a sparse stay's gap
  morning as a phantom night and put guest names on a public screen. A source
  contract freezes both the legacy semantics and the wrapper's remaining caller
  list. #2631 converted the two kiosk read surfaces that used to call it
  (`api/lodge/week` and `api/lodge/guests/[date]`) onto the named operational-day
  helpers, so `lodge-display-state` — the lobby wall — is now its **only**
  caller, and a PERMANENT one rather than a pending migration: nobody is to
  "finish the job" by pointing it at the operational day, for the privacy reason
  above (issue #58). The same statement lives beside the code in
  `booking-guest-stay-ranges.ts`. No surface may grow a second call.

### INV-DATE-020

- **One place turns a stay into nights, and its envelope branch is half-open**
  (#2628). `BookingGuestNight` is the canonical night set;
  `BookingGuest.stayStart`/`stayEnd` is a DERIVED envelope whose `stayEnd` is the
  morning after the last night [INV-DATE-012]. They agree for a contiguous stay;
  for a sparse one the envelope silently fills the internal gaps, so an expander
  that reads it reports nights the guest is not there. Six sites expanded a stay
  independently and disagreed. The named helpers in
  `src/lib/booking-guest-stay-ranges.ts` are now the one definition and every
  read surface routes at them: `expandStayEnvelopeToNightKeys` (the raw
  half-open expansion), `getGuestBedNightKeys` (night set when the guest has
  one, else the envelope — the set form of `isGuestActiveOnNight`, and agreeing
  with it night for night), `getExplicitGuestBedNightKeys` (explicit rows only,
  `null` when the guest carries none, for the bed-allocation surfaces that
  place only listed nights), `getGuestDepartureMorningKeys` /
  `isGuestDepartureMorning` (one departure per SEGMENT, not one per stay),
  `getNextGuestBedNightAfter` / `isGuestReturningOnDay` (the bounds anything
  scoped to ONE segment needs), and `getEarliestCurrentBedNightDate`. Do not
  write another `eachDateOnlyInRange(guest.stayStart, guest.stayEnd)`;
  `guest-stay-expansion-census.test.ts` counts them per site, so a second copy
  inside an already-declared file fails too.
  **`expandStayEnvelopeToNightKeys` must stay half-open.** Both bed-allocation
  planners are fed ONE PSEUDO-GUEST PER NIGHT, each carrying
  `stayStart = night` and `stayEnd = night + 1`; an inclusive expansion gives
  every one of them a phantom second night and the planner claims the
  morning-after bed while its occupant is still in it — a double booking, on the
  automatic path, silently. `bed-allocation.test.ts` →
  "pseudo-guest envelope (#2628)" is the mutation probe for that and the reason
  the rule is written here rather than only in a comment. Two deliberate
  non-callers: the lifecycle's `getGuestNightDatesInRange` reads the explicit
  night rows and has NO envelope fallback (its output feeds both placement and
  the prune diff, so a fallback would place rows the next reconcile sweeps), and
  the planner's `guestStayNights` treats an explicitly EMPTY night list as "no
  demand" rather than falling back. A guard on whether a bed is still spoken for
  starts at LAST NIGHT, not today: night N runs to midday NZ on date N+1
  [INV-DATE-002], so `stayDate >= today` forgets this morning's occupant and
  lets an admin retire a bed somebody is lying in. That widening is for
  REFUSALS only — the partner-share sweeps DELETE rows and stay at
  `stayDate >= today`, because night D-1 is occupancy that has already happened
  and past lodge nights are history and stay untouched [INV-CAP-010]. A refusal
  built on this rule states only WHAT blocks, never the whole history: the bed
  guard names the first few dates and occupants and says "and more", because the
  delete branch has no date predicate at all and would otherwise put every night
  a bed has ever held into one error string and into the audit trail.

### INV-DATE-021

- **A guest's kiosk attendance is one CURRENT state per stay, and every rule
  keyed on "the end of the stay" has to be re-read per segment** (#2628).
  `BookingGuest.arrivedAt` / `departedAt` is a single pair of timestamps meaning
  "where is this person now", not a log of check-ins. A stay with a gap in it
  arrives and leaves once per SEGMENT, so three consequences are load-bearing and
  none of them may be dropped:
  - The kiosk's check-in and check-out buttons BOTH ride on server-derived flags
    (`canMarkArrived`, `canMarkDeparted`) computed where the guest's night rows
    are loaded, never on a rule re-derived in the page from `isArriving` and
    `departedAt`. Those two fields cannot see the night set, and the combination
    they produce on a return night — check-in hidden because a departure is
    recorded, check-out hidden because the night is not a departure morning —
    leaves a hut leader with no control at all on a night the guest is in the
    building.
  - Marking a RETURN arrival (`isGuestReturningOnDay`, which is false for every
    day of every contiguous stay) always marks arrived and CLEARS the superseded
    departure, rather than toggling. That is what keeps the next check-out
    recordable instead of un-recording the previous one, and it is why "Arrived"
    and the faded row read `arrivedAt && !departedAt` rather than `arrivedAt`.
  - The departure chore sweep is bounded by `getNextGuestBedNightAfter`, not by
    "every date after today". Unbounded was correct only while the endpoint
    accepted a single, final departure; on a sparse stay it silently deletes the
    suggested roster generated for a segment the guest is still booked for, and
    toggling the departure back off restores nothing.

### INV-DATE-006

- **The lobby wall is deliberately mixed and stays fenced** (issue #58): its
  guest-name privacy gate (sole-occupancy detection) uses NIGHT counts while
  its visibility rows are checkout-inclusive. It keeps its own code path
  (`src/lib/lodge-display-state.ts`) and is never unified onto either helper
  family — widening its night counts would put guest names on an
  unauthenticated public screen during back-to-back handovers.

### INV-DATE-007

- **A member departing lodge A and arriving at lodge B on the same date is
  legal**: the two presence windows abut at midday, so the member-night
  conflict rule (below) is satisfied by construction.

### INV-DATE-008

- **Zero-night bookings** (`checkIn == checkOut`) expand to zero nights and
  are present on no day. The shape is deliberately unrepresentable — every
  booking-creating route refuses it — and must stay that way rather than
  becoming an accidental day-visit feature.

### INV-DATE-009

- **Deliberately outside this invariant:**
  - `daysUntilDate` (`src/lib/policies/cancellation.ts:140-158`) and the
    refund tiers it feeds (`getRefundTier` and the refund calculators,
    `src/lib/policies/cancellation.ts:13-90`) measure time *until* a stay
    against an NZ-local-midnight countdown boundary, not nights within it.
    They are not governed by the midday rule; any change there is a money
    change requiring its own issue, its own owner decision, and per-tier
    evidence — never a side effect of work in this area. A twelve-hour shift in
    that boundary moves real bookings across a refund-tier threshold: the same
    cancellation refunds a different amount.
  - The completion cron / unpaid-finished-stays pair keeps its dual check-out
    boundary (#2029, below). Both operate on NZ date-only lodge nights and
    neither is a presence definition; their `<` / `<=` split brackets the
    check-out day deliberately and must not be "aligned" onto one boundary.
  - The custodian bed hold uses deliberate inclusive day semantics (its own
    section below [INV-LIFE-062]): an assignment's `endDate` is a covered day, not a
    departure morning.
  - The kiosk depart lookup matches only the exact departure date — a status
    action window, not a presence rule.
  - The group-join window closes once the stay's check-out date is reached
    (`hasGroupStayFullyEnded`, `src/lib/group-booking.ts:469-476`) — an
    action window on dates, settled by its own owner decision, not a presence
    rule.
  - Minimum-stay derives its weekday as the NZ weekday: `night.getUTCDay()`
    (`src/lib/policies/minimum-stay.ts:56`) is correct precisely because
    nights encode NZ calendar dates (see the storage note). Any future true
    time-of-day instant in this area would silently shift that weekday for
    hosts behind UTC.

### INV-DATE-010

- **Storage encoding, not semantics.** A stored lodge night is an NZ calendar
  date. The `@db.Date` columns pin that date to UTC midnight internally — an
  instant that renders as club midday in NZST (1pm during NZ daylight saving),
  either way the same NZ calendar day in every zone, so a CI runner in UTC and
  a club in NZ agree on the date ([`docs/TESTING.md`](../TESTING.md) pins the
  frozen test clock to an NZST instance of exactly this instant as evidence).
  The UTC-midnight pinning is an internal encoding of the NZ date and nothing
  more: it is NOT the midday boundary instant, NZ time is the semantic truth,
  and no rule may be derived from the UTC reading of these values.

## Date handling rules

### INV-DATE-011

- Lodge bookings use New Zealand date-only nights, not arbitrary timestamps,
  unless a feature explicitly requires time-of-day semantics (the stay-boundary
  invariant above governs what those nights mean).

### INV-DATE-012

- `BookingGuest.stayStart` and `BookingGuest.stayEnd` represent each guest's
  date-only occupancy inside the booking envelope.

### INV-DATE-013

- `@db.Date` columns (e.g. `Booking.checkIn`/`checkOut`,
  `BookingGuest.stayStart`/`stayEnd`, `HutLeaderAssignment.endDate`) store an NZ
  calendar date, encoded internally at UTC midnight (the storage-encoding note
  in the invariant above). Compare them only against date-only values
  (`getTodayDateOnly()` / `normalizeDateOnlyForTimeZone()` from
  `src/lib/date-only.ts`), never a raw `new Date()` or a local-midnight
  (`setHours(0,0,0,0)`) instant: under the `TZ=Pacific/Auckland` server pin the
  latter resolves to `(D-1)T12:00Z` and shifts the boundary by a day for the
  first ~13h of each NZ day (F8/F32, #1888).

### INV-DATE-019

- **When a server asks for "today", it asks the club's calendar.**
  `todayDateOnlyForTimeZone()` returns it as a `yyyy-MM-dd` string and
  `getTodayDateOnly()` as a date-only `Date`; both live in
  `src/lib/date-only.ts` and both work on the server and in the browser. Never
  `new Date().toISOString().slice(0, 10)` (or `.substring(0, 10)`, or
  `.split("T")[0]`) — that is the **UTC** day, which is still *yesterday* in New
  Zealand for roughly the first half of every NZ day. #2682 fixed fifteen sites
  that did this, including the `min` on two public lodge-night pickers and the
  default `asOfDate` cut-off on two finance windows;
  `src/lib/__tests__/nz-today-date-only.test.tsx` freezes the clock inside the
  divergence window and fails the build if the pattern comes back.

  Two exact boundaries on that rule, because both are easy to get wrong:

  - *Truncating an existing `@db.Date` value the same way is fine* — those are
    already pinned to UTC midnight and encode a calendar day, not an instant.
    **It is not fine for a `DateTime` column.** `createdAt`, `updatedAt` and
    friends are real instants, so `booking.createdAt.toISOString().slice(0, 10)`
    is the clock one hop removed and lands on the previous NZ day all morning.
    #2684's lint rule is where that whole class gets caught; until then it is a
    known trap, not a permitted pattern.
  - *The member booking calendar and the admin kiosk deliberately derive today
    from the BROWSER's calendar day* (`src/components/booking-calendar.tsx`,
    `src/app/(admin)/admin/book/page.tsx`, #2474 — see the next invariant), so
    "one way to ask" holds for server-side and club-facing derivations, not
    literally everywhere. Any comparison the SERVER then makes is still the club
    day.

  A date-only value compared against the raw clock is the same mistake in
  reverse: `parseDateOnly("<today NZ>")` is UTC midnight of that day, which is
  still in the *future* of `new Date()` until midday NZ, so a guard written
  `dob > new Date()` refuses today's NZ date — the very date its own picker
  offers. Compare date-only against date-only (`> getTodayDateOnly()`), which is
  what the date-of-birth guards do since #2682.

### INV-DATE-014

- **Client-side, a selected lodge night is an NZ date-only `yyyy-MM-dd` string
  carried end-to-end.** The booking calendar (`src/components/booking-calendar.tsx`),
  the member booking wizard, and the admin "book on behalf" kiosk
  (`src/app/(admin)/admin/book/page.tsx`) never hold a lodge night as a
  local-midnight `new Date(year, month, day)` (#2474). That construction is
  midnight in the BROWSER's zone, so the moment such a value reached an
  instant-based API (a club-pinned `Intl` formatter, a UTC serialiser, or
  DST-crossing day arithmetic) it named the day the browser sat on — off by one
  for a booker far enough from New Zealand. The value submitted, the club-pinned
  label displayed, the night count, and the hold deadline are all derived from
  the string via `parseDateOnly` / `addDaysDateOnly` / `countNightsDateOnly`,
  which encode the NZ calendar day internally at UTC midnight (the
  storage-encoding note in the stay-boundary invariant above: the instant that
  renders as club midday, the same calendar day in every zone).
  `formatCalendarDayOnly(year, monthIndex, day)` is the
  canonical encoder; the #2264 `localCalendarDayToDateOnly` bridge, which patched
  only the display half of this hazard while the fragile encoding lived on, is
  gone. `src/lib/__tests__/booking-calendar-timezone.test.tsx` pins the
  lodge-night identity across browsers behind, at, and ahead of NZ, on an NZ
  DST-transition night. (This is the CLIENT representation; server-side capacity
  date arithmetic keeps its own `@db.Date`/date-only helpers, above.)

### INV-DATE-015

- **Rendering** a date or a time is a separate invariant from storing or
  comparing one, and has its own single seam: `src/lib/nzst-date.ts`. Its six
  helpers — `formatNZDate` ("16 Apr 2026"), `formatNZDateTime`
  ("16 Apr 2026, 11:30 am"), `formatNZLongDate` ("16 April 2026"),
  `formatNZTime` ("11:30 am"), `formatNZMonthYear` ("April 2026") and
  `formatNZWeekdayDate` ("Thu, 16 Apr 2026") — each pin BOTH `APP_LOCALE` and
  `APP_TIME_ZONE`. A bare `toLocaleDateString()` / `toLocaleTimeString()` /
  `toLocaleString()` renders in the VIEWER's zone and locale, so an
  administrator abroad read a different lodge night than the one stored, and a
  lobby-display television reported its own local time (#2256, #2264). An
  `eslint` `no-restricted-syntax` rule over `src/**` now blocks all three calls;
  the documented exclusions are written out in `eslint.config.mjs`. Three files
  format NUMBERS with `Number.prototype.toLocaleString` (thousands separators)
  and are listed there with a narrowed rule that lifts only `toLocaleString`,
  keeping both date restrictions. The rule's selector is syntactic, so computed
  access (`d["toLocaleDateString"]()`) and detached-method aliasing escape it —
  an accepted limitation, not a gap anyone writes by accident. A screen whose
  format is legitimately none of the six — weekday-bearing boards, compact
  grids, the seconds-bearing audit log, an `en-CA` ISO extractor — declares a
  module-level
  `new Intl.DateTimeFormat(APP_LOCALE, { timeZone: APP_TIME_ZONE, … })` constant
  instead. That, not an `eslint-disable`, is the escape hatch, and there are no
  disables in the tree.

### INV-DATE-016

- `formatNZLongDate` is reserved for the MEMBER-FACING surfaces the owner asked
  to keep the long spelled-out month on (#2264): booking messages and the emails
  built from them, the lodge and hut-leader instruction "last updated" stamps,
  and the generated report cover. Admin and internal screens use the medium
  `formatNZDate`. `src/lib/__tests__/member-facing-long-dates.test.ts` pins the
  four call sites so a later "tidy every date onto formatNZDate" pass fails
  loudly rather than silently shortening what a member reads.

### INV-DATE-017

- Two check-out boundaries coexist by design (#2029; named as a deliberate
  non-presence exception by the stay-boundary invariant above). The completion
  cron flips
  PAID → COMPLETED only once `checkOut < todayNZ` — the entire NZ check-out day
  stays PAID and self-editable/extendable — whereas the admin "finished stay"
  attention queues (`unpaid-finished-stays.ts`) intentionally use
  `checkOut <= todayNZ`. The difference is deliberate and the two operate over
  DISJOINT status sets: the queues surface still-unsettled stays
  (`PAYMENT_PENDING`, or a settled status carrying an unpaid additional delta) on
  the check-out day itself for payment chasing, while completion is a next-day
  transition of PAID bookings. A booking is therefore never both counted as a
  finished-stay-needing-payment AND still PAID-completable under the same rule.

### INV-DATE-018

- Base Reports uses lodge nights, never booking creation time (#2368). Its
  selected From/To window is inclusive and overlaps the half-open booking stay
  `[checkIn, checkOut)` (the stay-boundary invariant above). Every
  non-occupancy figure uses one explicit positive
  cohort: `PENDING`, `PAYMENT_PENDING`, `CONFIRMED`, `PAID`,
  `AWAITING_REVIEW`, and `COMPLETED`, with the same lodge/deleted scope. Count
  bookings once per overlapped bucket. Count guest rows once when their own
  half-open `[stayStart, stayEnd)` envelope overlaps the selected range; sparse
  explicit guest-night rows do not override that envelope for this metric.
  Allocate all integer cents of `finalPriceCents` across the
  booking's complete stay before slicing the report range (100/3 = 34/33/33).
  This is **Booked revenue**, not cash. Net collected cash stays payment-derived
  (`Payment.amountCents` less refunds, with a captured addition already inside
  that amount; #2408), and outstanding additions remain separate (#2350). The
  #2408 guard is binding here too: a collected-addition claim without captured
  `ADDITIONAL` transaction evidence must not change cash arithmetic or leak
  transaction rows, but must log and expose an aggregate possible-understatement
  warning in the page, CSV, and PDF. All Reports money presentation preserves
  exact integer cents.
  Occupancy is the deliberate exception within the page: it stays limited to
  PAID/COMPLETED and continues to exclude custodian occupancy (#2286).

## Capacity and allocation

### INV-CAP-001

- Capacity is per lodge. A booking belongs to exactly one lodge
  (`Booking.lodgeId`); capacity is "beds available on date D at lodge L", and
  no code path may sum beds across lodges into a single club-wide number. Two
  bookings at different lodges never contend for the same beds. The one
  deliberate, documented exception is a reporting-layer occupancy denominator
  that intentionally aggregates active lodges; any such aggregate must be
  recorded in `docs/multi-lodge/lodge-scoping-contract.md` and labelled as
  cross-lodge in the surface that shows it. A single-lodge club is simply a
  club whose `Lodge` table has one active row — the same per-lodge rules apply
  with the lodge dimension hidden by the ADR-002 presentation rule.

### INV-CAP-002

- `lodgeId` is **`NOT NULL`** on the six entity tables (`LodgeRoom`, `Locker`,
  `Season`, `Booking`, `ChoreTemplate`, `HutLeaderAssignment`), enforced
  **without an outage** via a `default_lodge_id()` column default: an old
  (pre-lodge) colour's insert omits `lodgeId` and auto-fills the default lodge,
  so no null is written even mid-blue/green-cutover. `lodgeNullTolerantScope`
  is now a strict `{ lodgeId }`. Policy/settings tables keep a **nullable**
  `lodgeId` (null = club-wide default), scoped via `resolvePolicyRowsForLodge`.
  See `docs/multi-lodge/contract-release.md`.

### INV-CAP-003

- Each lodge's capacity resolves through `getLodgeCapacityStatus` (full
  scenario table in `docs/CAPACITY_MODEL.md`). When the Bed Allocation module
  is on with ≥1 active bed, the physical bed inventory is the placement set and
  the per-lodge `LodgeSettings.capacity` acts as a **maximum sleeping capacity
  ceiling**: the effective capacity is the lower of the two, so a lodge may
  have more beds installed than it is allowed to sleep (`capped_beds`). No
  capacity set — or one at/above the bed count — leaves the bed count as the
  figure (`configured_beds`); only an explicit capacity caps it, never an
  unconfigured fallback. When the module is off, or on with no active beds, the
  capacity is the per-lodge `LodgeSettings.capacity`; if that is unset the lodge
  resolves to capacity 0 (`unconfigured_lodge`). Since #1982 the DB is the sole
  runtime source — `club.json` is no longer a runtime capacity fallback; the
  default lodge's `LodgeSettings.capacity` is backfilled from the config bed
  total by the boot-time self-heal, and any lodge (default or additional) with
  neither configured beds nor a capacity is unbookable rather than overbookable
  until it is set up (the setup-readiness Club Config check warns on a
  default lodge left at 0).

### INV-CAP-004

- A booking consumes beds when it is capacity-holding. The implementation
  source of truth is `capacityHoldingBookingFilter()` in
  `src/lib/booking-status.ts`, which every occupancy/availability query uses
  (composed under `AND` with the per-lodge scope, since both are `OR`
  fragments). A booking holds capacity when either (a) its status is in
  `CAPACITY_HOLDING_BOOKING_STATUSES` (PAID, COMPLETED, CONFIRMED,
  AWAITING_REVIEW), or (b) it is PENDING **and** is the converted booking of a
  `BookingRequest` — i.e. an accepted-but-unpaid quote or a directly-approved
  request (issue #1254). Rule (b) refines #737: generic PENDING bookings
  (split-booking non-member children #738, member "only-if-my-guests-come"
  holds) have no `originBookingRequest` and stay non-holding and bumpable, but a
  quote-derived accepted booking keeps its beds until it is paid, expires, or is
  cancelled. Because #737's member-priority bumping only ever touched
  non-holding PENDING rows, an accepted-but-unpaid quote can no longer be bumped
  by a later member booking — this is the intended capacity-priority change.

### INV-CAP-005

- Split-booking guest portion always settles or is notified, never silently
  stranded (#1967). A split non-member child (#738) is auto-charged at its hold
  deadline to the member's card inherited from the parent payment. When the
  parent is genuinely settled without a saved card (Internet Banking, or already
  CONFIRMED/PAID/COMPLETED), `cron-confirm-pending.ts` instead mints a tokenised
  `/pay/<token>` PaymentLink (the #707 machinery) and emails it to the member —
  once per mint, deduped on the absence of an active (unexpired) PaymentLink for
  the child (`mintSplitGuestPaymentLinkIfAbsent`) — and fires an admin alert on
  **every** hold-extension run until the child settles. If the parent itself is
  unpaid (abandoned card), no link is minted or emailed (the guest portion never
  settles ahead of the member's own place) and the alert fires with
  parent-unpaid wording instead. Only genuine split children qualify: a #796
  group joiner also carries `parentBookingId` but always has a
  `GroupBookingJoin` row, which excludes it everywhere (cron, page, send route).
  At most one live token exists per booking (every mint revokes-then-creates
  under the per-lodge advisory lock; undelivered emails revoke their minted link
  by id so the next run re-mints), and the tokenised link and the saved-card
  auto-charge never both settle durably (the charge claim revokes links; the
  /pay intent path re-reads the link under the same lock; the on-demand path
  refuses when a saved card exists — though a link PaymentIntent minted just
  before the claim can still transiently coexist with the charge in flight).
  That residual in-flight window is narrowed and backstopped (#1992): a link
  PaymentIntent minted BEFORE the claim (client secret already
  in the member's browser) is best-effort cancelled on Stripe by the charge
  claim before it charges the saved card, and if the member's confirm still
  wins that race, `markBookingPaymentSucceeded` auto-refunds whichever DISTINCT
  capture arrives second on the already-PAID booking — durably
  (enqueue-then-execute, exactly the duplicate's captured amount, pinned to the
  duplicate's own transaction) with a loud admin alert — while a SAME-intent
  replay keeps its byte-identical `already_paid` outcome and at most one side
  of the pair can ever be refunded (adjudication under `lock(1)`). A capture
  whose money is already owned by the superseded-intent recovery machinery (a
  live `CANCEL_PAYMENT_INTENT` / `REFUND_SUPERSEDED_PAYMENT` operation, e.g.
  the succeeded-superseded-intent handoff) is never mistaken for the
  settlement side of such a pair: the real settlement's replay stays
  `already_paid` and that machinery's cron refunds the superseded capture. Money still
  stays integer cents and no beds are held for the child until it is actually
  paid. The same machinery backs the
  on-demand `POST /api/bookings/[id]/send-guest-payment-link` re-send
  affordance. A child can end PAID while its parent is unpaid or later
  cancelled — the parent-cancel sweep only cancels still-PENDING children — and
  there is deliberately no auto-cancel past check-in (owner policy decision).

### INV-CAP-006

- Bed-allocation eligibility (`BED_ALLOCATABLE_BOOKING_STATUSES`) is a status-
  only superset of capacity-holding; the `capacity-holding ⊆ bed-allocatable`
  invariant still holds because rule (b) only extends holding to PENDING, which
  is already bed-allocatable (locked by
  `booking-status-bed-allocation-ownership.test.ts`, #813).

### INV-CAP-007

- Auto-allocated stays are **room-continuous per booking** (issue #1677): the
  planner (`buildFirstFitBedAllocationPlan`) places a booking's whole party in
  ONE room for the ENTIRE stay — in free space first, and for capacity-holding
  bookings by displacing whole provisional stays (#1387 preserved) — falling
  back to the legacy per-night split only when no single room can host the
  stay; fallback bookings are reported in
  `BedAllocationPlan.roomContinuityFallbackBookingIds`. Displacement relocates
  or unallocates a provisional booking's ENTIRE visible stay (one destination
  room) and never night-splits it — whole-stay room claims (Phase 2) evict
  newest bookings first, while the per-night fallback (Phase 3) selects
  victims in room/bed sort order; an
  admin-approved allocation (#776 lock) on ANY night pins the whole booking
  against displacement, as does a stay extending beyond the reconcile load
  envelope. Existing allocation rows are never rewritten by planning — only
  provisional displacement moves rows — and re-planning a fully-allocated
  state is a no-op.

### INV-CAP-008

- **Allocation preferences are per lodge and advisory, never safety
  overrides (#2593):** the board and lifecycle resolve the same strict saved
  order for the booking's lodge. The canonical default is booking cohesion →
  stay continuity → requested room → direct-family cohesion; an explicitly
  saved empty list is valid deterministic neutral behavior. Every hard
  invariant (maximum feasible placement count within a candidate, school
  separation, adult coverage, cross-booking age mix, lodge isolation,
  custodian/exclusive holds, approved-row pins, and displacement safety) is
  scored or enforced ahead of those preferences. Preference values then
  compare the bounded feasible candidates lexicographically from top to bottom;
  disabling a value removes only that comparison. Family cohesion means guests
  sharing at least one family-group id **directly**; connected components,
  direct subsets, capacity-aware high-affinity room packing, and
  maximum-cardinality direct-edge pairings provide bounded candidates but do
  not turn transitive acquaintances into a scored family pair. The planner
  executes at most 24 matching-layout candidates per booking, alongside its
  whole-room, legacy, and displacement trials. This is a deterministic bounded
  heuristic, not a claim of global optimality across all bookings. A settings
  save never moves an existing row: it affects later board suggestions and
  later lifecycle reconciliation only. The board's visible suggestions are a
  preview, never a persistence payload: Run Auto Allocation takes global then
  the selected lodge lock, refuses an unknown or inactive selected lodge, and
  rebuilds the complete scoped plan on that transaction client before writing,
  so a bed/room deactivate, retype, lodge
  mismatch, allocation/approval change, or hard-predicate change committed
  after preview cannot receive a stale AUTO row.

### INV-CAP-009

- **Cross-booking age mix (#1768, owner-set):** a room-night containing minors
  from booking X must never also contain an adult from a DIFFERENT booking —
  planner-enforced in both placement directions on every path (whole-stay,
  per-night split, adult spread, displacement eviction/relocation), including
  against pre-existing `occupiedBedNights`; an occupant row with no booking
  attribution conservatively blocks minors (counted as an unknown adult) but
  not adults. Same-booking mixing is unrestricted, and minors-only ROOMS are
  allowed: the booking-level rule stays night-scoped (Phase 0
  `NO_BOOKING_ADULT` — a minor needs a same-booking adult on-site that night,
  not in the same room), so a large group's minors overflow into rooms of
  their own instead of being capped at one room per adult. SCHOOL-request
  bookings (`isSchoolGroup`, from the origin/held `BookingRequest.type`)
  prefer adults together and students separate. **A shared DOUBLE bed grants no
  composition exemption (#2656, owner-set):** each of its two occupants counts
  toward the room-night composition under that occupant's OWN booking key, so a
  double holding an adult of booking A and an adult of booking B blocks a third
  booking's minor from that room-night exactly as one adult alone would. The
  index behind the guard was already correct for this shape — it is maintained
  per `bookingGuestId:stayDate`, which is lossless, and no composition predicate
  reads the occupant view — and the #2656 occupant-view fix deliberately did not
  change it; the behaviour is now pinned by paired regression tests, including
  the positive control that the same minor IS placed with no unrelated adult
  present. The planner never rewrites
  persisted violations (manual/legacy rows) — the board surfaces them as
  `MINOR_ADULT_MIX` warnings; the manual board itself is warned, not blocked,
  **by design** (owner decision, 2026-07-11, closing the deferral from
  #1768/PR #1775): the invariant binds every automated placement path, while
  the manual board deliberately stays an admin-judgment escape hatch with the
  warning as its guard. Do not add a hard block without a fresh owner
  decision.

### INV-CAP-010

- **Double-bed shared occupancy (#1701):** a `DOUBLE` bed may hold two occupants
  on a night — one primary and one second occupant — when they are declared
  partners: two `ADULT` members holding a **CONFIRMED** `MemberPartnerLink`
  (#1742), the single-source `mayShareDoubleBed()` rule in
  `double-bed-sharing.ts`. A PENDING link grants nothing; both members must
  also still be ACTIVE adults at placement time. (#1744 swapped this signal in
  for the interim same-`FamilyGroup` rule, which wrongly permitted e.g. a
  parent and an adult child.) The precondition is enforced at placement time
  AND swept when it later breaks (#1756): **no future `isSecondOccupant`
  allocation may outlive its partner link or the active-adult precondition**.
  Dissolving a CONFIRMED link (`removeOwnPartnerLink` /
  `adminRemovePartnerLink`), deactivating a member (member edit, bulk update,
  or account-deletion anonymisation), or correcting an ADULT to a minor/N-A
  tier acquires `acquireFuturePartnerSharedAllocationLocks` and runs
  `sweepFuturePartnerSharedAllocationsWithLocksHeld`
  (`bed-allocation-lifecycle.ts`) in the SAME transaction as the breaking
  event: the pair's future (tonight onwards, NZ date-only) second-occupant
  rows are deleted back to the awaiting-allocation queue — never the primary,
  so the sweep cannot orphan anyone and needs no promotion pass — with a
  `BED_ALLOCATION_PARTNER_SHARE_SWEPT` audit row against BOTH bookings and a
  post-commit admin alert (`admin-partner-share-swept`, "Booking review
  required" preference). A dissolve sweeps only bed-nights whose two occupants
  are exactly the dissolved pair; deactivation/tier change sweeps any future
  shared bed-night involving the member on either side. Past lodge nights are
  history and stay untouched, and the sweep is idempotent (a second run finds
  nothing).

### INV-CAP-030

**Member merge is the fifth writer of this invariant, and needs its own,
validity-driven form (#2595).** Merge is not a pair-breaking event about one
pair — it COLLAPSES two identities. `planPartnerLinkMerge` keeps at most one
CONFIRMED partner for the surviving master, so merging a duplicate that
already had its own confirmed partner DROPS that link, and `applyMoves` then
re-points `BookingGuest.memberId` onto the master and leaves every bed
allocation exactly where it was — so the master and the duplicate's
ex-partner are left sharing a future DOUBLE with nothing behind it. Neither
#1756 scope fits: the pair scope knows only one pair (a merge can invalidate
several bed-nights against several counterparts), and the member scope would
also remove the master's OWN still-CONFIRMED share, which the merge did
nothing to invalidate. So merge runs
`sweepUnbackedFutureSharedDoublesWithLocksHeld`
(`bed-allocation-lifecycle.ts`) instead: for the `[master, loser]` scope it
re-derives each candidate future bed-night's actual two occupants and
re-asks the same single source of truth (`mayShareDoubleBedWith`, the
batched form of `mayShareDoubleBed`) whether they may still share, sweeping
ONLY the bed-nights that fail — again only the `isSecondOccupant` row, with
the same `BED_ALLOCATION_PARTNER_SHARE_SWEPT` audit against both bookings
(reason `members_merged`, `issue: 2595`) and the same post-commit admin
alert. A guest with no member on either side is unbacked by construction
(placement requires a member on both sides) and is swept without an
eligibility round-trip; a bed-night whose primary is missing is left to the
#1750 promotion pass rather than judged as a pair that does not exist. Being
validity-driven it is idempotent and vacuous on a merge that broke nothing.
Its lock prefix is DELIBERATELY narrower than its #1756 sibling's:
`acquireMemberMergePartnerSharedLodgeLocks` takes every affected lodge
capacity key in sorted order BEFORE any member-lifecycle key, and takes NO
global cohort `lock(1)` — a merge holds its keys for up to 120s and the global
key would reject every 5s-budget cohort writer in the club. What replaces it
is a wider lodge derivation (the members' future bed allocations UNION their
future guest-nights, so a lodge a placement could still land in is covered)
plus a run-time check: the sweep is handed the locked lodge set and refuses the
whole merge with a 409 rather than judge a bed-night outside it (see
docs/CONCURRENCY_AND_LOCKING.md -> "Merge joins the bed-allocation cohort").

### INV-CAP-031

Membership cancellation and archive need no sweep call: approval
is blocked while ANY future booking or member guest appearance exists, so a
cancellable member cannot occupy a future shared bed-night. Only an admin adds the second occupant on the board,
and only onto a bed whose primary already **holds capacity**. That check is
made at PLACEMENT time only and is not maintained afterwards, so it is a
strong default rather than a guarantee: `BED_ALLOCATABLE_BOOKING_STATUSES` is
a deliberate superset of the capacity-holding statuses, so a primary can later
stop holding capacity while keeping its rows, and displacement can then reach
it. Since #2656 the planner **represents** a shared double rather than
collapsing it — occupant identity is keyed `bedId:stayDate:bookingGuestId`,
distinct from the `bedId:stayDate` capacity key — so it never frees a
bed-night one of the pair still occupies, never treats a bed-night whose
occupants span two bookings as a SINGLE-BED displacement target, and counts an
emptied double as one freed bed. (The whole-stay room path is deliberately
different: it makes every occupant of a bed-night an eviction candidate and
gains the bed only once ALL of them are in the eviction set, so both bookings
on a shared double are displaced together or the room is not chosen — see
docs/CAPACITY_MODEL.md rule 3.) Auto-allocation never
creates a second occupant; every other bed type stays exactly one occupant per
night. DB-enforced without CHECK constraints:
`@@unique([bedId, stayDate, isSecondOccupant])` caps a bed-night at ≤2 rows and
a raw-SQL partial unique index (`WHERE "bedType" <> 'DOUBLE'`, recorded in
`prisma/partial-unique-indexes.tsv`) caps every non-DOUBLE bed at exactly one;
`BedAllocation.bedType` is a denormalized copy the partial index reads (a
partial index cannot join to `LodgeBed`). The **base** capacity figure is
unchanged — a shared double is still ONE bed of `activeBedCount` and each
occupant is a full person-night (pricing/settlement untouched) — but each
active DOUBLE adds one **partner-shared slot** of admission headroom above
it (#1745): reserved (only `checkCapacityForPartnerSharedAdmission` on the
admin-initiated partner flow may use it — every public/member/system path
reads the unchanged base `getLodgeCapacity`), bounded (≤ active DOUBLE
count per night, with the sharer's partner required to hold an ordinary
base-backed place — a sharer can never anchor another sharer — so a
feasible pairing always exists, modulo the documented #1668 forced-overbook
residual), and capped by an explicit `LodgeSettings.capacity`, which limits
*people*, so a `capped_beds` lodge gets no headroom (see
docs/CAPACITY_MODEL.md, "Partner-shared double-bed headroom"). Initiation
is admin-only (#1746): the `partnerSharedGuests` flags on the booking
modify routes are rejected for non-admin actors at BOTH route and service,
the edit panel's quick-add candidates are server-computed
(`listBookingPartnerSharingCandidates`), and the public wizard carries no
shared-slot affordance. A DOUBLE
holding a second occupant
cannot be retyped to a non-double until that occupant is removed. Whenever a
shared double loses its primary — a reviewed removal (#2594), a board move of
the primary onto another bed, or a cross-booking cancellation / reconcile prune
(#1750) — the surviving partner is **auto-promoted** to primary on the vacated
bed-night atomically with the removal on transactional paths. Single-row paths
write one `BED_ALLOCATION_PARTNER_PROMOTED` audit per promotion because the
partner may belong to a different booking (sharing eligibility is
member-level). **The lifecycle displacement apply path (#1387/#1677) promotes
too, since #2656** — it was the one removal path that did not, so displacing
the primary of a shared double left exactly the orphan this list says never
survives. It reads the rows it is about to move or delete BEFORE the write,
promotes the survivor on every bed-night that lost its primary, and clears
`isSecondOccupant` on a MOVE (a relocated row lands alone on a bed that was
free at plan start, so it is the primary there and must not carry a fresh
orphan to its destination). Two bulk paths batch that audit:
**range assignment** (#2251),
which can vacate up to 366
bed-nights, and **reviewed removal** (#2594), which can span a booking or the
board's 31-night lodge window. Each records **one batched
`BED_ALLOCATION_PARTNERS_PROMOTED`** entry instead, targeted at the booking
anchoring the operation when one exists and listing each promotion
(`{allocationId, bookingId, bookingGuestId, bedId, stayDate}`) up to
its 50-identity bound (the audit sanitiser's array limit),
with the exact `promotedCount` and a `promotionsTruncated` flag alongside — so
the promoted partner's own booking is still named per promotion, and the audit
rows written inside that transaction stay bounded independently of the range
length. Promotion is gated on
`isSecondOccupant` alone, never the denormalized `bedType` of the removed row or
the survivor: an AUTO-allocated row on a real DOUBLE carries the SINGLE default,
so trusting that type would strand the partner it needs to promote. The
bed-night is
therefore never left dead-ended behind the orphaned-second-occupant guard in
`resolveSecondOccupant`, and re-pairing follows the normal sharing rules (in
particular the promoted primary's booking must hold capacity before a new
partner may join). The reviewed-removal and board-move services self-wrap
their read + write + promote in a transaction, while the lifecycle prune
captures-before / flips-after on the caller's own client. Reconcile is
usually already inside a transaction, but a few callers
reconcile on the bare `prisma` singleton (e.g. `cron-complete-bookings`, the
confirm-pending-guests route); on those a crash between the delete and the flip
regresses to the pre-#1750 state — a recoverable orphaned second occupant,
visible on the board and cleared by the next successful reconcile or a manual
move, never a capacity or double-booking violation.

### INV-CAP-011

- Waitlisted and offered bookings do not consume capacity until confirmed.

### INV-CAP-012

- A waitlist offer reprices the booking at current season rates,
  membership-type policy, group discount, and promo validity at the moment the
  offer is issued; the offer email states the price the member will pay on
  confirmation. The creation-time price snapshot is not a price lock — an
  identical booking made directly on the offer day pays the same. If repricing
  fails, the offer proceeds at the stored snapshot rather than being blocked.

### INV-CAP-013

- A linked `Member` may be present on only one live booking per lodge night
  (night as defined by the stay-boundary invariant above, which also makes a
  same-date lodge-to-lodge move legal by construction). This person-night
  guard is separate from bed capacity: it checks draft,
  pending, confirmed/paid/completed, waitlist, offered, and admin-review
  bookings, but ignores cancelled, bumped, deleted, and expired draft rows.

### INV-CAP-014

- A member put on somebody ELSE's booking may take their own place off it, and
  only their own place. The rule is one shared server-side predicate
  (`evaluateGuestSelfRemoval`, `booking-guest-self-removal.ts`): not the
  booking's owner, the guest row is their own, the booking's status is one of
  the eight self-removable ones, the stay is still in the future (NZ date-only
  check-in strictly after today), and they are not the last guest. The
  authoritative gate is `removeBookingGuestInTransaction`, which imports the
  same status set and additionally refuses a quote-priced booking and a settled
  booking whose refund/credit election only the owner or an admin may make.
  Every surface that offers the action — the booking wizard's night-conflict
  card and the booking detail page's own card (#2250) — drives its visibility
  from that predicate rather than a client-side copy of it, so a member is never
  shown a control the service would refuse; where it says no, the action is
  hidden and the reason is stated instead. The booking detail page also passes
  `isQuotePriced` (one indexed `isQuotePricedBooking` lookup, run only when the
  action would otherwise be offered), so the quote-priced refusal is predicted
  rather than discovered on submit. The settled-booking refund/credit election
  stays server-only by design: predicting it needs the price delta of the
  removal, which is the full repricing pass inside the removal transaction, and
  a cheaper guess ("has a captured payment") would hide the action from members
  the service would allow. That refusal surfaces as the service's own
  plain-English 400, which the card shows verbatim.

### INV-CAP-015

- The 409 the person-night guard returns is read by whoever made the request,
  which may be a member adding somebody else as a guest. Its human-readable
  message is therefore composed only from what that requester already supplied —
  the member they tried to book and the nights they chose — plus the next step
  their own `canSelfRemove` / `isOwnBooking` / `isSelfGuest` / `canOpenBooking`
  flags allow. **The payload is scoped to match** (#2250): a conflict row carries
  `bookingId`, `bookingStatus`, `bookingOwnerName`, `bookingCheckIn`,
  `bookingCheckOut` and `guestId` only when the server marked this viewer
  `canOpenBooking` — the booking's own owner, an admin, or the conflicting guest
  themselves. An unentitled row carries nothing but the member the requester
  tried to book, that member's name, the intersection with the nights they chose,
  and the four viewer-aware booleans. The gate lives at the single assembly point
  in `findBookingMemberNightConflicts`, because every route that returns this
  body passes the array straight through; the copy layer
  (`describeBookingMemberNightConflictBooking`) gates independently and fails
  closed, so a row missing the detail says nothing rather than rendering
  `undefined`.

### INV-CAP-016

- The same 409 is produced by flows whose reader cannot change the dates (the
  admin booking-request approve / hold / send-quote routes and the booking
  modify routes), so the server-built message is flow-neutral. Only the booking
  wizard — the one surface whose reader is choosing the dates — renders the next
  step with `canChooseDifferentDates`, which is what adds "…or choose different
  dates" (#2250).

### INV-CAP-017

- The person-night guard is app-level enforcement by design (#1039 item 3): a
  database unique index cannot express it because liveness is booking-status
  dependent and spans `BookingGuest` to `Booking`, which a Postgres partial
  unique index cannot reference. It is race-free because every transaction that
  **creates or re-dates** a member-linked `BookingGuest`/`BookingGuestNight`
  footprint takes its per-lodge capacity lock before running
  `assertNoBookingMemberNightConflicts`, whose first authoritative action takes
  sorted per-member-night advisory locks across lodges (#1881). A writer that
  also moves booking status or money takes global `lock(1)` before those locks.
  The lodge-before-member ordering and the guard's self-lock are frozen by
  `review-findings-contracts.test.ts`. (`CONCURRENCY_AND_LOCKING.md` maps these
  locks alongside the per-member credit lock and the ordering discipline each
  follows.) Writes that do not change the member-night
  footprint — re-pricing, name-only guest edits, lodge arrive/depart timestamps,
  and anonymization that clears the member link — legitimately skip the guard, as
  does the non-member group-join path (`verifyAndCreateNonMemberJoin`, which
  writes only `memberId: null` guests and takes the lock but is a guard no-op).
  When an admin links a booking-request guest to a real member — or opens a
  request that already carries persisted linked members — the linking UI runs an
  **advisory-only** overlap pre-check (`findLinkedGuestMemberNightConflicts`,
  #1226) so any conflict surfaces before approve/hold. The panel computes it on
  load for pre-existing links and on every link/unlink, applying only the latest
  response per request so a slower earlier check can't overwrite a newer one
  (#1226 follow-up). It is non-authoritative — it never throws, blocks, or takes
  the advisory lock, and it excludes the request's own held booking — the
  transactional `assertNoBookingMemberNightConflicts` guard at approve/hold time
  remains the sole enforcer.

### INV-CAP-018

- A member holds at most one group-join roster row per group
  (`GroupBookingJoin` unique on groupBookingId + joinerMemberId, #1039
  item 2). The roster row is written inside the child booking's transaction:
  a duplicate live join aborts the whole transaction, and a row left by a
  cancelled or bumped join is reused on re-join. Non-member join requests
  carry a NULL member id and sit outside the constraint.

### INV-CAP-019

- Draft, pending, waitlist, payment-recovery, and review states must have
  expiry, retry, admin visibility, or repair paths.

### INV-CAP-020

- Linked provisional-child cancellation is guarded against the hold-resolution
  cron (#1881 residual): after a parent cancel, each candidate takes global
  `lock(1)` then its immutable lodge's per-lodge lock, is re-read, and is
  conditionally claimed only while still `PENDING`. A child the cron already
  confirmed or charged is never overwritten, and a lost claim runs none of the
  cancellation side effects.

### INV-CAP-021

- **Exclusive whole-lodge hold (ADR-001, #118):** a night overlapped by a
  capacity-holding booking with `Booking.wholeLodgeHold = true` admits no
  further capacity from any admission path — the night's `availableBeds` is
  hard-blocked at 0, never negative, so it cannot be bypassed by the admin
  over-capacity override (#1668). To non-admins the held lodge presents
  exactly as an ordinary full lodge (decision 6); only admin surfaces are told
  a hold is in effect. Full scenario table in `docs/CAPACITY_MODEL.md`,
  "Exclusive whole-lodge hold — a non-bypassable block".

### INV-CAP-022

- **A held booking owns no `BedAllocation` rows (ADR-001 §Bed allocation,
  #2285):** the group implicitly occupies every bed, so both **automatic**
  allocation paths skip it — the admin board excludes it from the
  awaiting-allocation set and the planner, and the lifecycle reconcile prunes
  its rows and never auto-places it (keyed on the flag, not status). Every
  planner additionally re-reads the bookings it is about to write rows for
  immediately before the write, so a hold, cancel or soft delete landing
  between planning and writing cannot be undone by a re-insert. The manual
  board path is guarded separately, at the single allocation-write chokepoint
  added by #2251 (stacked on #2285 and landing with it): every manual path —
  single-night board placement, the bulk multi-night drop and range assignment —
  goes through `assertGuestAndBedForAllocation`, which refuses a held booking, so
  a hand-placed row can no longer be created only to be swept by the next
  reconcile. The exclusive-hold toggle reconciles both directions (set prunes, release
  re-plans), and a school approval granting exclusivity prunes after stamping
  the hold; both record the removed rows in their audit entry so a mistaken
  hold can be undone by hand. Divergence guard:
  `src/lib/__tests__/held-booking-allocation-agreement.test.ts`.

### INV-CAP-023

- **A held booking's nights ARE occupied as far as both planners are concerned
  (ADR-001 amendment, #2285, resolved by #2317):** a whole-lodge hold's nights
  are synthesised into both bed-allocation planners as **unattributed,
  non-displaceable** occupancy — every active bed of that lodge, every held
  night — while the hold still owns no `BedAllocation` row anywhere. The rows
  carry a null booking and a null guest (#1768 "unknown occupant" shape,
  exactly like a custodian bed hold), which is what makes them unattributed (no
  name, no booking id, no age tier — a hold can begin life as a public school
  request) and non-displaceable (there is no row for a `MOVE` or `UNALLOCATE`
  to target). A tierless unknown occupant counts as an adult, so the
  cross-booking age-mix guard treats a held lodge's rooms conservatively.
  An officer-kept overlapping booking is therefore never auto-placed onto beds
  the held group is using: those guest-nights surface as `NO_BED_AVAILABLE` in
  the awaiting-allocation list, which is the visible form of a clash the
  officer has already been told about (#119/#177). Being unattributed is a
  property of the bed-NIGHT and not only of the row: a real `BedAllocation` row
  can legitimately share a held bed-night (decision 1 never refuses the
  overlapping booking), and planner occupancy is keyed `bedId:stayDate`, so the
  planner pins every null-booking bed-night as permanently occupied and
  evicting the co-located booking releases that booking's claim and never the
  hold's. **The blocking predicate is the capacity engine's own** —
  `wholeLodgeHold` AND `bookingHoldsCapacity` / `capacityHoldingBookingFilter()`
  over the same lodge, which is `getLodgeHeldNights`'s population — so a planner
  can never report a night as held that the engine would admit into, and a stale
  hold flag on a booking that stopped holding capacity blocks nothing in either
  place. (The one deliberate asymmetry is direction-safe: where the planner
  cannot resolve a lodge for a hold or a room it treats the night as held, which
  refuses a bed the engine would have admitted rather than the reverse. Both
  columns are NOT NULL, so this is a dead branch kept conservative.) Both
  writers re-read the live holds on the client that is about to write, so a hold
  committing between plan and write cannot be written over; every placement
  transaction this code **opens itself** takes the per-lodge advisory lock as
  its first statement, while a reconcile running inside a CALLER's transaction —
  or the lifecycle's common no-displacement path, which opens none — inherits
  that caller's lock discipline and relies on the re-read alone, exactly as the
  custodian exclusion does. **Manual placement is deliberately untouched:**
  ADR-001 decision 1 hands an overlap to the booking officer to resolve by hand,
  and a write-time refusal would remove that path. The officer's view of a hold
  is the board's banner plus the **Overlaps exclusive hold** chip on the
  clashing booking; the bed GRID does not mark held cells, and the banner is
  built from the board's booking load (which needs a guest row overlapping the
  window) rather than from the deliberately-unfiltered blocking query, so a hold
  with no guests entered yet blocks without appearing there. Source:
  `src/lib/exclusive-hold-occupancy.ts`; guards:
  `src/lib/__tests__/exclusive-hold-planner-occupancy.test.ts` and the
  whole-lodge entries in
  `src/lib/__tests__/custodian-write-path-contract.test.ts`.

### INV-CAP-024

- **The requested-room lock follows the approved rows, not the hold (#776,
  #2285):** setting an exclusive hold prunes the booking's approved allocations,
  so `isBookingBedAllocationLocked` goes false and the member's requested-room
  editor re-opens; the re-plan after a clear creates unapproved AUTO rows, so it
  stays open until an admin approves again. Intended: with no allocated beds
  there is nothing for the lock to protect.

### INV-CAP-025

- **Approving beds is always scoped, and the booking is a first-class scope
  (#2252):** `approveBedAllocations` stamps `approvedAt`/`approvedByMemberId`
  only where `approvedAt: null`, and refuses outright when NONE of its three
  selectors — `allocationIds`, a date `range`, or a `bookingId` — is given, so
  an unselected approval can never stamp every pending row in the database.
  `bookingId` is sufficient ON ITS OWN and only ever narrows when combined with
  the others; it exists because the in-booking panel has no safe alternative
  (`allocationIds` caps at 250 and a long stay can exceed it, and the `from`/`to`
  form approves every pending allocation of every booking in the window). A
  booking-scoped approval audits `BED_ALLOCATION_APPROVED` with
  `targetId` = the booking id, because the booking page's audit deep link
  searches `targetId` and never metadata. The booking selector honours the same
  ADR-003 lodge scope the range selector does, so the approve can never reach
  wider than the lodge-scoped read the officer was shown — an anomalous row of
  the booking in another lodge's room is neither displayed nor confirmed.

### INV-CAP-026

- **The requested-room lock is two-way, and nothing pretends otherwise
  (#776, #2252, #2594):** no un-approve action exists and none is invented, but
  two ordinary paths can take a booking's last approved row away and re-open the
  member's editor — a board MOVE re-drafts the row it updates (the upsert's
  update branch clears `approvedAt`/`approvedByMemberId`), and reviewed removal
  deletes it. The removal preview computes `reopenedBookings` from every approved
  row on each affected booking, never only the 31-night page on screen, and the
  shared dialog names that consequence before apply. Member requested-room
  writes take global `lock(1)`, lock and re-read the booking row, then use a
  guarded update whose predicate still says no approved allocation exists; an
  approval or removal that wins first therefore changes the authoritative answer
  rather than being crossed by a stale room-request write.
  The same three paths (single-night/drag placements, `source: "AUTO"`
  suggestions, and move re-drafts) are why draft rows persist under #2251's
  auto-approve, and why a confirmation affordance stays meaningful.

### INV-CAP-027

- **Existing allocation moves preserve their lodge nights, require review, and
  commit atomically (#2366, #2595):** an existing-chip drag or **Move to bed**
  menu choice selects a destination bed only. The hovered column is
  presentation input, never a target date, and both pointer and keyboard paths
  open the same confirmation dialog before any write. The reviewed request is
  an exclusive typed shape: anchor allocation, destination bed,
  `ALLOCATION_NIGHT` or `BOOKING_GUEST` scope, and `v1:<sha256>` preview digest.
  The unchanged legacy `{ allocationIds, bedId }` request remains capped at the
  31-night board limit for older callers; the board no longer uses it for an
  existing-chip move.

  Night scope resolves the anchor only. Person scope resolves every existing
  row for that guest on that booking, including sparse/off-screen nights, up to
  366; it creates no missing guest-night or allocation. Preview needs
  `bookings:view`, writes nothing, and separates changed/noop rows while showing
  approval re-draft, shared-double promotions, and every hard refusal. The
  digest binds the full selected and relevant occupant sets plus booking,
  guest-night, consent, member/age, partner-link, destination, custodian-hold,
  whole-lodge-hold and derived feasibility state. Counterpart identities never
  enter the response.

  Apply needs `bookings:edit` and takes global `lock(1)` -> the complete sorted
  source/destination/booking/occupant lodge union -> sorted member-lifecycle ->
  sorted member-partner-link -> deterministic allocation-row locks. It re-reads
  and re-digests before one guarded `UPDATE ... FROM (VALUES ...)` statement
  (up to 366 rows, explicit 30-second transaction and 10-second acquisition
  budgets). Cancellation uses the same global key, so a move can never resurrect
  a pruned row. Changed rows keep their original NZ dates, become unapproved
  `MANUAL` drafts, and commit with any partner promotions and bounded causal
  audits. Unchanged rows are digest-bound but excluded from feasibility,
  promotion, write, re-draft, and audit. An all-noop confirmation succeeds with
  explicit feedback and no audit. Any stale fact, conflict, or guarded-count
  mismatch returns/refuses atomically; a stale digest carries a refreshed
  preview and requires confirmation again. Bucket-to-board placement keeps its
  separate per-night partial-conflict contract.

### INV-CAP-028

- **Destructive allocation removal is preview-bound and never replans
  (#2594):** every UI entry point uses
  `POST`/`PUT /api/admin/bed-allocation/allocations/removal`; the old direct
  `DELETE /api/admin/bed-allocation/allocations/[id]` route is retired. Preview
  needs `bookings:view`, writes nothing, and accepts exactly one of four scopes:
  one anchored allocation, one guest on one booking, one whole booking, or one
  lodge's half-open visible window of at most 31 nights. Guest and booking scope
  include off-screen rows by design; window scope never crosses its lodge or
  visible dates. Category selection is a non-empty subset of three mutually
  exclusive classifications: unapproved `AUTO`, unapproved `MANUAL`, and any
  approved row regardless of source.

  The `v1:<sha256>` preview digest includes canonical scope, sorted categories,
  every matching row's mutable identity, every approved row on the affected
  bookings, and every causal shared-double sibling. Apply needs `bookings:edit`,
  resolves the immutable booking lodge plus the reviewed anchor lodge, then
  takes global `lock(1)` → sorted lodge locks → sorted allocation-row locks
  before an authoritative re-preview. ID- and bed-night-expanded queries use
  sorted 10,000-value chunks under that same transaction, below PostgreSQL's
  bind-parameter ceiling without weakening all-or-nothing rollback. A matching or causal row in any third
  lodge is refused without mutation. If an aggregate booking/person preview's
  opening row disappeared, the refreshed preview re-anchors to the lowest-id
  matching survivor so a subsequent reviewed apply is reachable.
  A missing/moved anchor, changed category membership, new approval, promotion
  change, or any other digest drift returns 409 with a refreshed preview and
  writes nothing. A matching apply deletes the complete reviewed set, promotes
  any stranded shared-double second occupants, and writes one bounded operation
  audit plus one bounded promotion audit in the same transaction. It never calls
  board or lifecycle auto-allocation: no replacement row appears until an admin
  explicitly places it or runs auto-allocation later.

### INV-CAP-029

- **A range assignment writes all or nothing, and records itself once (#2251):**
  `assignBedRange` scans, writes and audits inside one transaction. If any
  requested night is blocked, NOTHING is written and the caller receives a
  per-night refusal in one of three categories that are never merged —
  `BED_TAKEN` (a clash; a provisional occupant counts, so nothing is silently
  overwritten), `GUEST_NOT_BOOKED` (a bad request, never a silent skip, and it
  includes a gap night of a non-contiguous stay, #713), and `EXCLUSIVE_HOLD` —
  which here means **the guest's OWN booking** holds the lodge (ADR-001's
  short-circuit, scoped to the held booking's own guests). Another booking's
  overlapping hold is surfaced on the board (`overlapsExclusiveHold`), not
  refused here: no allocation path in the domain hard-blocks on it, and this one
  must not be the exception. A partial result exists only when a human sends the
  explicit `nights` list they were shown — the server writes exactly that set or
  refuses it with a fresh report, never a set it re-derived. Every attempt that
  COMPLETES — applied or refused — produces exactly ONE
  `BED_ALLOCATION_RANGE_SET` audit entry against the booking id, committed in the
  same transaction as the rows; an attempt that THROWS (unknown guest/bed,
  cancelled booking, deactivated bed, over-cap range, lost write race) rolls back
  and records nothing, because nothing happened. That entry records shape, not
  people: night counts and runs per category plus the involved booking ids, with
  the occupying guests' names carried only in the API response to the admin who
  asked. The only other row the transaction may write is the single batched
  `BED_ALLOCATION_PARTNERS_PROMOTED` entry when the move stranded partners on
  shared doubles (see the sharing invariant above), so **both the statement count
  and the audit-row count are fixed whatever the night count**. Proceeding past
  `GUEST_NOT_BOOKED` nights additionally requires an explicit on-screen
  confirmation naming how many nights are not part of the guest's booking (never
  "outside the stay" — a GAP night of a non-contiguous stay is inside the span and
  still refused, #713) and how many
  will be written, so a partial result is never one click from a warning. The
  31-night `MAX_BED_ALLOCATION_RANGE_NIGHTS` bounds
  the board's READ window, not this write: lodge capacity is the active bed
  count and never reads `BedAllocation` rows. Placement paths nevertheless take
  the destination lodge's capacity lock because custodian holds share the bed
  inventory (#2286); reviewed existing-allocation moves take their complete
  sorted lodge/member/row topology before an authoritative re-read. The separate write bound
  (`MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS`, 366) exists only to keep one
  transaction finite, and is **refused at, never silently truncated to** — as is
  every board window the admin types.

### INV-LIFE-062

A `HutLeaderAssignment` may additionally hold ONE bed (`bedId`), which makes it
a **custodian occupancy** (#2286). The invariants:

- **Optional and inert by default.** `bedId = null` is a role only and has zero
  capacity effect — the pre-#2286 behaviour, and what every
  `hut-leader-auto-assign` cron row is. Only a bed-holding assignment reaches a
  capacity or allocation consumer.
- **Inclusive night semantics.** The hold covers the night of every date from
  `startDate` to `endDate` **inclusive**, never the half-open booking envelope.
  The bed is bookable again for the night after `endDate`. (This is the
  custodian exception the stay-boundary invariant in "Booking Dates And
  Capacity" names deliberately: an assignment's `endDate` is a covered day,
  not a departure morning.)
- **Counted as an occupant, never as a smaller lodge.** The capacity engines add
  the per-night custodian **count** to `occupiedBeds` rather than reducing
  `lodgeCapacity`, so `occupiedBeds + availableBeds === lodgeCapacity` still
  holds on every night. It is a count, never a boolean: two custodians handing
  over on different beds subtract two.
- **No booking, no allocation row, no guest.** A custodian is not a
  `BookingGuest`, so they are structurally absent from the chore roster, the
  booking rows and the display occupancy counts. They may still make an ordinary
  booking of their own anywhere, including at the same lodge, and capacity then
  correctly counts both their held bed and their booked bed.
- **Two assignments may never hold the SAME bed on an overlapping night.** The
  one-day handover overlap assignments already permit is allowed only on
  different beds; the same-bed case is refused at create and update.
- **A whole-lodge hold and a custodian never contend.** The hold reserves the
  *bookable* lodge; the custodian's bed sits outside that pool. Neither refuses
  the other, and the ADR-001 held-night pin is unchanged.
- **Exclusion is enforced in application code, never by a database constraint**
  (owner decision 28 Jul 2026, option (a)). Two things make that safe, and both
  are required:
  1. **Every** `BedAllocation` write path that places a guest on a bed re-reads
     the live holds **on the same client, immediately before the write**, and
     refuses or drops what would land on one: the manual funnel
     `allocateBedNight`, the range assign's `CUSTODIAN_HOLD` classification,
     `runAutoBedAllocation`'s in-transaction re-filter, and the lifecycle
     reconcile's write-time re-filter (`dropRowsOnCustodianHeldBedNights`). A
     read at plan time alone is NOT enough — a reconcile is routinely called
     post-commit, so a hold committed between the plan and the write would
     otherwise be written over.
  2. Every placement transaction this code **opens itself** takes the per-lodge
     advisory lock (`acquireLodgeCapacityLock`) as its first statement, sorted
     when it can span several lodges, so that re-read and the write serialise
     against the hold writer, which takes the same key. A reconcile running
     inside a CALLER's transaction inherits that caller's lock discipline
     instead of adding a key to an ordering it does not control; its write-time
     re-filter still runs on that client.

  `custodian-write-path-contract.test.ts` fails CI when a new write
  path appears undeclared, and `CUSTODIAN_BED_CONFLICT` on the allocation board
  surfaces any row that got through anyway.
- **A held bed cannot be deactivated or deleted**, nor can its room, while the
  hold exists (`onDelete: Restrict` is the FK backstop behind the app guards).
- **Minor privacy.** A minor-age custodian is never individually named on the
  lobby display at any name-display granularity; the slot shows the role word
  alone.
