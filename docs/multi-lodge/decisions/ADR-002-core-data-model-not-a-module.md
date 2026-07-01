# ADR-002: Multi-Lodge Is a Core Data Model Change, Not a Module

## Status

Proposed

## Context

AlpineClubBookingsNZ has an Admin Modules system (`ClubModuleSettings`,
`src/config/modules.ts`, `src/config/feature-routes.ts`) used for optional
features such as kiosk, chores, bed allocation, and the finance dashboard.
Modules work by boolean flags that gate route families: when a module is
off, its routes return 404 through the proxy/module gates and its UI is
hidden. Modules are presentation and route-level switches over a shared
core data model.

Multi-lodge support is a different shape. It adds a dimension (`lodgeId`)
to core booking data — bookings, rooms, capacity, seasons, pricing — that
every booking read/write must respect. A route-prefix toggle cannot express
"this booking belongs to lodge A"; there is no meaningful state where the
multi-lodge data model is "off" once bookings carry a lodge.

## Decision

Implement multi-lodge as a core schema and service-layer change, not a
module:

- The `Lodge` table always exists and always has at least one active row.
  Fresh installs seed one lodge; the migration backfills existing
  deployments to one lodge (ADR-001).
- All lodge-scoped reads and writes require a `lodgeId` unconditionally.
  There is no "module off" code path in capacity, pricing, or booking
  logic — single-lodge clubs are simply clubs whose `Lodge` table has one
  row.
- **Single-lodge presentation rule:** when exactly one active lodge
  exists, the UI must look and behave as it does today — no lodge selector
  in the booking flow, no lodge picker on admin pages, no lodge column in
  lists. The lodge dimension appears in the UI only when a second active
  lodge is added. This keeps the public project's out-of-box experience
  unchanged for single-lodge clubs, which are the common case.
- The admin page for managing lodges (creating a second lodge, renaming,
  deactivating) lives under admin setup as core functionality, not behind
  a module flag.
- Existing modules that touch lodge-scoped data (kiosk, chores, bed
  allocation, lockers) keep their module flags exactly as today. The flags
  remain club-wide switches; whether a club has one lodge or three, the
  chores module is on or off for the whole club. Per-lodge module state is
  out of scope until a real need is identified.

## Consequences

### Positive

- No dual code paths: capacity, pricing, and booking logic have one shape,
  always lodge-scoped, which is simpler to test and keeps the invariant
  surface small.
- Single-lodge clubs (including upstream and every existing fork) see no
  behaviour change and no new configuration burden.
- The presentation rule gives a natural rollout gate: the schema and
  service changes can merge and soak in production while the club still
  has one lodge, before a second lodge is ever created.
- Module semantics stay clean: modules keep meaning "optional feature",
  not "data dimension".

### Negative

- Every lodge-scoped service function takes a mandatory `lodgeId` even in
  single-lodge deployments — slightly more ceremony at call sites for
  clubs that never add a second lodge.
- The single-lodge presentation rule adds a conditional to member and
  admin UI ("show the selector only when active lodge count > 1") that
  needs its own test coverage.
- Downstream forks with schema customisations must take a real migration,
  not opt out via a module flag.
