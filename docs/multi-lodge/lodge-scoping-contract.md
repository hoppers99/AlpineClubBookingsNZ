# Lodge Scoping Contract

This contract records which data is lodge-scoped, which stays club-wide,
and the rules service code must follow. Update this file before changing
the scoping of any model, the same way `finance-dashboard/data-contracts.md`
is updated before metric definitions change.

## Lodge-Scoped Models

These carry a required `lodgeId` after phase 2 (see ADR-001 for migration
sequencing):

| Model | Scoping | Notes |
| --- | --- | --- |
| `LodgeRoom` | direct `lodgeId` | `name` unique per lodge, not globally |
| `LodgeBed` | via `LodgeRoom` | no direct FK |
| `BedAllocation` | via room/booking | no direct FK |
| `Locker` | direct `lodgeId` | `name` unique per lodge; lockers gain a lodge link for the first time |
| `Season` | direct `lodgeId` | lodges may have different season windows |
| `SeasonRate` | via `Season` | keeps `[seasonId, ageTier, isMember]` uniqueness |
| `Booking` | direct `lodgeId` | denormalised for capacity/availability query performance; always matches the room's lodge when a room is assigned |
| `BookingGuest` / `BookingGuestNight` | via `Booking` | no direct FK |
| `GroupBooking` | via organiser `Booking` | one group = one lodge (ADR-001 open question 1) |
| `ChoreTemplate` | direct `lodgeId` | roster generation filters by lodge |
| `LodgeSettings` | per-lodge row | converted from singleton |
| `BedAllocationSettings` | per-lodge row | converted from singleton |
| `BookingDefaults` | per-lodge row | converted from singleton |
| `BookingRequestSettings` | per-lodge row | converted from singleton |
| Lodge identity fields (`lodgeName`, `doorCode`, `lodgeTravelNote`) | move to `Lodge` / per-lodge settings | currently on the `EmailMessageSetting` singleton |

## Club-Wide Defaults With Per-Lodge Overrides

`CancellationPolicy`, `MinimumStayPolicy`, and `BookingPeriod` gain a
nullable `lodgeId` (ADR-001 resolved question 3). Resolution rule: rows
with null `lodgeId` are the club-wide defaults; if any rows exist for a
lodge, that lodge uses its rows instead of — never merged with — the
club-wide set for that policy type. Service code resolves a lodge's
policy through one shared helper so the replace-not-merge rule cannot
drift between the three policy types.

## Optional Lodge Restrictions

- `PromoCode`: restricted via a `PromoCodeLodge` junction table (phase 6),
  because a promo may apply at several lodges but not all. No junction
  rows = redeemable at every lodge.
- Member booking eligibility and lodge-operational staff access share a
  junction table (working name `MemberLodgeAccess`, phase 4). Eligibility
  is default-open: no restriction rows means a member can book every
  active lodge. Staff scoping binds hut-leader assignments, kiosk
  devices, and PIN sessions to one lodge. `ADMIN` access is club-wide and
  never lodge-filtered.

## Club-Wide Models (No Lodge Dimension)

These intentionally stay club-wide. Do not add `lodgeId` to them without a
new ADR:

- Membership: `Member`, `MemberAccessRole`, `MembershipType`, family
  groups, applications, subscriptions, lifecycle requests.
- Payments: `Payment`, `PaymentTransaction`, `PaymentRefund`, Stripe
  references. Payments attach to bookings; the booking carries the lodge.
- Xero and finance: all `Xero*` models, `FinanceSnapshot`,
  `FinanceReportCategory*`, item/account mappings. One club-wide ledger and
  one operational Xero connection, consistent with
  `finance-dashboard/decisions/ADR-005-single-operational-xero-connection.md`.
- Email, notifications, audit log, webhooks, cron state, page content,
  media, committee, module settings (`ClubModuleSettings` stays one row).

## Service Rules

- Capacity is per lodge: "beds available on date D at lodge L". No code
  path may sum beds across lodges into one number.
- A booking's guests, nights, bed allocations, and requested room must all
  belong to `booking.lodgeId`. Enforce in service logic; add DB constraints
  where practical.
- Pricing lookups (`findRateForNight`, `calculateBookingPrice`) operate on
  the seasons of exactly one lodge. Callers pass lodge-filtered season
  data; the pure calculation functions stay lodge-agnostic.
- The booking-creation capacity check locks per lodge, not club-wide.
  Two bookings at different lodges must not contend.
- Roster/chore generation for a date runs per lodge and only sees that
  lodge's templates and staying guests.
- Money stays in integer cents and booking dates stay NZ date-only,
  unchanged by lodge scoping.

## Presentation Rule

When exactly one active lodge exists, member and admin UI must not show
lodge selectors, lodge columns, or lodge names in flows where they would
be redundant (ADR-002). APIs still require and return `lodgeId`; the rule
is presentation-only.

The `multiLodge` Admin Module flag gates only the lodge-management
configuration routes (ADR-002). Runtime booking, capacity, and pricing
logic must never branch on the flag — lodge count and `lodgeId` are the
only lodge signals service code reads.
