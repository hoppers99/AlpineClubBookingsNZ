# ADR-001: Lodge Entity and Foreign-Key Scoping Model

## Status

Proposed. Open questions below need an owner decision before phase 2
(schema and migration) starts.

## Context

AlpineClubBookingsNZ has no `Lodge` model. Rooms, beds, lockers, seasons and
rates, cancellation policy, minimum-stay policy, booking periods, chores,
and several settings tables are club-wide singletons or globally-unique
per-entity tables:

- `LodgeRoom`, `Locker`: per-entity, but `name` is globally unique (no
  property scope).
- `Season` / `SeasonRate`: per-entity, keyed only by date range and
  `[seasonId, ageTier, isMember]`. No property dimension is possible today.
- `CancellationPolicy`, `MinimumStayPolicy`, `BookingPeriod`: per-entity
  rows forming one club-wide policy table each.
- `LodgeSettings`, `BedAllocationSettings`, `BookingDefaults`,
  `BookingRequestSettings`: true singletons (`id @default("default")`).
- `EmailMessageSetting`: singleton; carries lodge-identity fields
  (`lodgeName`, `doorCode`, `lodgeTravelNote`).
- `ChoreTemplate`: club-wide; roster generation pulls all templates for a
  date with no property filter.
- Capacity (`src/lib/lodge-capacity.ts`, `src/lib/capacity.ts`) is a single
  scalar: the sum of all active `LodgeBed` rows, or a `LodgeSettings`
  override.
- Pricing (`src/lib/policies/pricing.ts`) resolves a rate from a flat
  `SeasonRateData[]` array with no property key.
- The `LODGE` access role (`src/lib/access-roles.ts`) is flat and club-wide;
  it does not express "staff at lodge A but not lodge B."

The club operates two physical lodge properties today, with a plausible
third. Members should be able to book at more than one lodge, with the
option to restrict specific members or lodges later. Bed counts, bookings,
seasons, pricing, promo codes, lockers, and chores all need to become
lodge-aware. Membership, core authentication, and Xero/finance are expected
to stay shared across lodges.

## Decision

Add a `Lodge` model and thread `lodgeId` through the models above, rather
than duplicating the app per lodge or encoding lodges as a hardcoded enum.
This keeps the change proportional to two lodges today while not requiring
a second migration if a third is added later.

### New model

```
model Lodge {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

Kept intentionally thin at this stage (identity plus active flag). Address,
contact, and door-code fields already exist elsewhere (`EmailMessageSetting`,
`LodgeInstruction`) and move onto `Lodge` or a per-lodge settings table in
phase 2, not invented fresh here.

### Scoping changes

- Add `lodgeId` (FK to `Lodge`) to: `LodgeRoom`, `Locker`, `Season`,
  `Booking`, `CancellationPolicy`, `BookingPeriod`, `MinimumStayPolicy`,
  `ChoreTemplate`.
  - `Booking.lodgeId` is added directly rather than derived only through
    `requestedRoomId`, since capacity and availability queries need to
    filter by lodge without a join on every call.
  - `LodgeBed` and `BedAllocation` stay scoped indirectly through
    `LodgeRoom`/`Booking`; no direct FK needed.
  - `SeasonRate` inherits lodge scope through its parent `Season`.
- Convert `LodgeSettings`, `BedAllocationSettings`, `BookingDefaults`,
  `BookingRequestSettings` from singleton rows (`id: "default"`) to
  per-lodge rows keyed by `lodgeId`.
- Move the lodge-identity fields (`lodgeName`, `doorCode`,
  `lodgeTravelNote`) off `EmailMessageSetting` and onto `Lodge` or a
  per-lodge settings table.
- Re-scope global uniqueness to `[lodgeId, ...]`: `LodgeRoom.name`,
  `Locker.name`, `CancellationPolicy.daysBeforeStay`. `SeasonRate` keeps its
  existing `[seasonId, ageTier, isMember]` uniqueness, since `seasonId`
  already carries the lodge scope transitively.
- Xero/finance mappings (`XeroAccountMapping`, `XeroItemCodeMapping`) stay
  club-wide. They key off age tier, season type, and membership status, not
  property, and splitting them is additive later (Xero tracking categories)
  if per-lodge P&L reporting is ever needed. This matches the existing
  preference for one shared operational Xero connection recorded in
  `docs/finance-dashboard/decisions/ADR-005-single-operational-xero-connection.md`.

### Migration sequencing

Staged to stay deployable under the blue-green rollout documented in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, not as one migration:

1. Add the `Lodge` table; seed exactly one row for the club's current
   (single) lodge.
2. Add each `lodgeId` column as nullable; backfill every existing row to
   the seeded lodge.
3. Enforce `NOT NULL` and add the re-scoped unique constraints in a
   follow-up migration once backfill is confirmed complete.
4. Convert the singleton settings tables to per-lodge rows in the same
   backfill pass, keeping the existing `"default"` row's values as the
   seeded lodge's row.

### Capacity and pricing (signature change only, not the full rewrite)

This ADR fixes the data model these functions read from; the service-layer
rewrite itself (`getLodgeCapacity`, `checkCapacity`, `getAvailability`,
`findRateForNight`, `calculateBookingPrice`, and the booking-creation
advisory lock moving from club-wide to per-lodge) is phase 3 work and gets
its own review pass given the money- and capacity-critical invariants in
`docs/DOMAIN_INVARIANTS.md`.

## Consequences

### Positive

- One consistent scoping mechanism (`lodgeId` FK) rather than per-table
  special cases.
- Works for two lodges today without a second migration if a third is
  added.
- Xero/finance, membership, and core auth stay untouched, limiting blast
  radius to booking/lodge-operations code.
- Existing single-lodge behavior is preserved by construction: after
  backfill, a deployment with exactly one `Lodge` row behaves exactly as
  today.

### Negative

- Every capacity, pricing, and availability call site needs a `lodgeId`
  parameter added — a real, non-mechanical rewrite of money- and
  booking-critical code, not just a schema change.
- Five singleton tables need real migration work (not just a new nullable
  column) to become per-lodge.
- Uniqueness constraint changes (`LodgeRoom.name`, `Locker.name`,
  `CancellationPolicy.daysBeforeStay`) touch existing data and need
  verification that no cross-lodge name collisions exist before the
  constraint is added.

## Open Questions

These need an owner decision before phase 2 starts. Recommendations are
included but not assumed.

1. **Can one booking span more than one lodge?** Recommendation: no — pin
   `Booking.lodgeId` to exactly one lodge. Model any case where a family or
   group needs both lodges as linked bookings through the existing
   `GroupBooking` parent/child mechanism, not as a single multi-lodge
   booking.
2. **Member booking eligibility.** Should every active member be able to
   book every lodge by default, with an optional admin-configured
   restriction, or should eligibility default-deny until explicitly
   granted? Recommendation: default-open, matching today's zero-friction
   booking, with an optional per-member or per-membership-type allowlist
   for the case of a lodge reserved for part of the club.
3. **Do cancellation policy, minimum-stay policy, and booking periods
   actually need to vary per lodge**, or can they stay club-wide (no
   `lodgeId`) to reduce scope? Recommendation: confirm with the treasurer/
   committee whether real policy differences across lodges are anticipated;
   if not, drop `lodgeId` from these three tables and keep them club-wide.
4. **Promo code scope.** Should promo codes default to club-wide
   (redeemable at any lodge) with an optional lodge restriction? Recommendation: yes, same
   pattern as member eligibility (#2), added in phase 6.
5. **Staff (`LODGE` role) access scoping.** Should staff access move to a
   per-lodge junction (e.g. "hut leader at lodge A only") in the same phase
   as member eligibility, or can it stay a flat club-wide role for now and
   be scoped later if it becomes an operational problem? Recommendation:
   scope it in phase 4 alongside member eligibility, since the same
   `MemberLodgeRole`-shaped junction table likely serves both.
