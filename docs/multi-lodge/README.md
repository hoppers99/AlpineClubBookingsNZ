# Multi-Lodge Support

This directory tracks the design and delivery of multi-lodge support for
AlpineClubBookingsNZ: the ability for the club to operate more than one
physical lodge property (rooms, beds, capacity, pricing, chores, lockers)
under one club, membership, and finance backend.

The club currently operates two lodges, with a plausible future third. The
data model targets an arbitrary number of lodges rather than hardcoding two,
since the FK/scoping shape is the same either way.

## Current State

There is no `Lodge` model today. Rooms, beds, seasons/rates, cancellation and
minimum-stay policy, booking periods, chores, and several settings tables
(`LodgeSettings`, `BedAllocationSettings`, `BookingDefaults`,
`BookingRequestSettings`) are implicit club-wide singletons. Capacity is a
single scalar derived by summing all active beds; pricing is one rate table
keyed by season and age tier with no property dimension. See
[ADR-001](decisions/ADR-001-lodge-entity-and-scoping-model.md) for the full
inventory.

Membership, authentication (other than the `LODGE` staff access role),
Xero/finance integration, and payments are expected to remain club-wide and
are out of scope for lodge-scoping unless a specific need is identified.

## Delivery Plan

Work is sequenced so schema/service-layer changes land and prove out before
UI is retrofitted, and so the highest-risk piece (capacity and booking
transactions) gets isolated review rather than being bundled with lower-risk
work.

1. **Design** (this directory). Resolve the open questions in ADR-001. No
   app logic changes.
2. **Schema and migration.** Add `Lodge`, add `lodgeId` FKs, convert the
   singleton settings tables to per-lodge rows, re-scope unique constraints.
   Staged as additive-nullable -> backfill -> enforce-NOT-NULL migrations per
   `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.
3. **Capacity, pricing, and booking-transaction core.** Thread `lodgeId`
   through `getLodgeCapacity`/`checkCapacity`/`getAvailability` and
   `findRateForNight`/`calculateBookingPrice`; move the booking-creation
   advisory lock from club-wide to per-lodge. Highest risk; needs its own
   focused review and staging soak before merge.
4. **Staff access and member booking eligibility.** Lodge-scoped staff
   access (who can use which lodge's kiosk/roster tools) and member booking
   eligibility (which members can book which lodges).
5. **Chores and roster**, scoped per lodge.
6. **Promo codes**, optional per-lodge scope.
7. **Admin UI retrofit**: rooms/beds, seasons, lockers, cancellation/
   minimum-stay/period policy, bed allocation, module settings — add a lodge
   selector pattern once and apply it across these pages.
8. **Member UI**: lodge selection step in the booking flow, navigation,
   copy.
9. **Regression and staging validation** throughout, with a dedicated final
   pass seeding two (and a third) lodges and confirming cross-lodge
   isolation end to end.

Each numbered phase is expected to be one or more separate PRs, not one
large change.

## ADRs

- [ADR-001: Lodge entity and foreign-key scoping model](decisions/ADR-001-lodge-entity-and-scoping-model.md)

## Maintenance Rules

- Do not add a `lodgeId` column or a new lodge-scoped table ad hoc; follow
  the entity shape and migration sequencing in ADR-001, or update the ADR
  first if the approach changes.
- Keep Xero/finance mappings club-wide unless a follow-up ADR records a
  decision to split them, consistent with the existing preference for one
  shared operational Xero connection
  (`docs/finance-dashboard/decisions/ADR-005-single-operational-xero-connection.md`).
  Money stays in integer cents and booking dates stay NZ date-only
  regardless of lodge scoping.
- Update this README and the relevant ADR in the same PR as any change to
  the lodge data model or delivery plan.
