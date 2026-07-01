# Multi-Lodge Implementation Plan

Phased delivery plan for multi-lodge support. Each phase is one or more
PRs; no phase bundles schema, money-path logic, and UI in a single change.
Risk labels follow the `AGENTS.md` risk gate: every High/Critical item
needs owner approval before merge regardless of CI state.

Phases 0–1 are prerequisites for everything else. Phases 4, 5, and 6 are
independent of each other once phase 3 lands and can proceed in any order.

## Phase 0 — Decisions (this directory)

Resolve ADR-001 open questions with the owner:

1. one booking = one lodge (recommended: yes)
2. member booking eligibility model (recommended: default-open with
   optional restriction)
3. whether cancellation/minimum-stay/booking-period policies vary per
   lodge (needs committee input)
4. promo code lodge scope (recommended: club-wide default, optional
   restriction)
5. staff `LODGE`-role scoping (recommended: per-lodge junction in phase 4)

Accept or amend ADR-001 and ADR-002. No code.

**Risk: Low (docs only).**

## Phase 1 — Lodge entity and admin management

- Add the `Lodge` model, seeded with one row (migration 1 of the ADR-001
  sequence).
- Add the `multiLodge` Admin Module flag (default OFF) per ADR-002:
  `ClubModuleSettings.multiLodge`, a `MODULE_DEFINITIONS` entry, and
  `feature-routes.ts` rules gating the lodge-management route family.
  The flag gates configuration only; runtime booking logic never reads
  it.
- Lodge-management admin page (module-gated) to view/rename the lodge
  and, later, add a second one. The module flag is the rollout gate: it
  stays off in real deployments until phase 3 is complete and soaked, so
  no deployment enters multi-lodge state early. Disabling the module is
  rejected while more than one active lodge exists.
- Move lodge identity fields (`lodgeName`, `doorCode`, `lodgeTravelNote`)
  from `EmailMessageSetting` onto the lodge, with a compatibility read
  path until phase 8 finishes the email-template updates.

**Risk: Medium (schema + migration, but additive and single-lodge
behaviour preserved).**

## Phase 2 — lodgeId scoping migrations

Per ADR-001 sequencing, across several PRs:

- Nullable `lodgeId` columns on `LodgeRoom`, `Locker`, `Season`,
  `Booking`, `ChoreTemplate` (+ policy tables if phase 0 decides they
  vary per lodge); backfill to the seeded lodge.
- Convert singleton settings tables (`LodgeSettings`,
  `BedAllocationSettings`, `BookingDefaults`, `BookingRequestSettings`)
  to per-lodge rows.
- Enforce NOT NULL and re-scoped unique constraints
  (`[lodgeId, name]` on rooms and lockers) after backfill verification.
- Run `npm run db:check-drift` against a shadow database for every
  migration PR; verify each step against
  `BLUE_GREEN_MIGRATION_POLICY.md`.

**Risk: High (schema/migrations on booking-critical tables). Owner
approval required.**

## Phase 3 — Capacity, pricing, and booking-transaction core

The critical phase. Thread `lodgeId` through:

- `src/lib/lodge-capacity.ts` (`getLodgeCapacity` becomes per-lodge bed
  sum; retire or per-lodge the `LodgeSettings.capacity` override —
  decide during implementation).
- `src/lib/capacity.ts` (`getAvailability`, `checkCapacity`,
  `checkCapacityForGuestRanges`, `getMonthAvailability`) — every booking
  overlap query gains a lodge filter.
- `src/lib/policies/pricing.ts` callers — season loading gains a lodge
  filter; the pure calculation functions keep their current signatures.
- Booking creation/modification transactions — the capacity advisory
  lock becomes per-lodge; verify no cross-lodge contention and no
  regression in the double-booking protection.
- Availability/quote/booking API routes accept and validate `lodgeId`
  (defaulting to the sole lodge while one exists, so existing clients
  keep working).

Test-first: extend the capacity/booking test suites with two-lodge
fixtures before changing logic. Cross-lodge isolation (a full lodge A
never blocks a booking at lodge B, and vice versa) is the headline
regression risk.

**Risk: Critical (money and booking capacity). Owner approval and staging
soak required before the phase-1 "second lodge" guard is lifted.**

## Phase 4 — Access scoping and booking eligibility

- New junction table (working name `MemberLodgeAccess`) expressing
  per-lodge grants, used for both staff access and member booking
  eligibility per the phase 0 decisions.
- Lodge-scoped staff access: kiosk/roster tools and hut-leader PIN
  sessions bind to a lodge (`HutLeaderAssignment` gains `lodgeId`; the
  kiosk device declares its lodge).
- Member booking eligibility enforcement in the booking service (not
  UI-only), default-open per the expected phase 0 decision.

**Risk: High (auth boundaries). Owner approval required.**

## Phase 5 — Chores and roster

- `ChoreTemplate.lodgeId` filtering in roster generation and the chore
  allocator; roster pages and print views take lodge context from the
  kiosk/staff session's lodge.

**Risk: Medium.**

## Phase 6 — Promo codes

- Nullable `PromoCode.lodgeId` (null = club-wide); validation and
  redemption checks compare against the booking's lodge; admin promo UI
  gains the optional lodge restriction.

**Risk: Medium-High (touches redemption/allocation money paths).**

## Phase 7 — Admin UI retrofit

- Build the lodge-picker pattern once (a context selector honouring the
  ADR-002 single-lodge presentation rule) and apply it to: rooms/beds,
  lockers, seasons, bed allocation, chores, booking policies (if
  lodge-scoped), lodge settings.
- Admin booking list/search/detail gain lodge filters and columns (again
  hidden while one lodge exists).

**Risk: Medium (UI over already-guarded APIs).**

## Phase 8 — Member UI and communications

- Booking flow lodge selection step (shown only with >1 active lodge),
  carried through availability, quote, and creation calls.
- Booking confirmations, pre-arrival/door-code emails, and kiosk screens
  use the booking's lodge for name, travel note, and door code.
- Copy sweep for hardcoded "the lodge" strings.

**Risk: Medium.**

## Phase 9 — Validation, soak, and enabling multi-lodge

- Staging seeded with two, then three, lodges; full end-to-end pass per
  `test-plan.md` (booking, payment, modification, cancellation, waitlist,
  group booking, roster, kiosk at each lodge; cross-lodge isolation
  checks).
- Enable the `multiLodge` module in the real deployment and create the
  second lodge.
- Update `docs/ARCHITECTURE.md`, `docs/DOMAIN_INVARIANTS.md`,
  `docs/END_TO_END_TEST_MATRIX.md`, `docs/UX_FLOW_MAP.md`,
  `CONFIGURATION.md`, and `README.md` to describe the lodge dimension
  (these are also updated incrementally in earlier phases as behaviour
  actually changes).

**Risk: High gate review; the change itself is mostly test/docs.**

## Standing Rules for Every Phase

- Follow `agents/CODEX_WORKFLOW.md`: one branch per issue-scoped change,
  tests with the change, validation results in the PR body, merge
  commits only.
- Single-lodge behaviour must be preserved at every merge point — each
  phase lands with the club still operating exactly as today until
  phase 9 deliberately enables the second lodge.
- Update this plan, the scoping contract, and the affected core docs in
  the same PR when reality diverges from the plan.
- Nothing in this work touches live providers; all validation uses local
  or staging environments per `AGENTS.md`.

## Upstream Contribution

This work happens on a public fork with the intent to offer it upstream.
Keep commits free of club-specific data (lodge names, door codes, network
details, registry hosts); those belong in deployment configuration, not
the repository. Phase boundaries above are chosen so upstream can review
and adopt the work as a sequence of coherent PRs rather than one bulk
drop.
