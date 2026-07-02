# Multi-Lodge Implementation Plan

Phased delivery plan for multi-lodge support. Each phase is one or more
PRs; no phase bundles schema, money-path logic, and UI in a single change.
Risk labels follow the `AGENTS.md` risk gate: every High/Critical item
needs owner approval before merge regardless of CI state.

Phases 0–1 are prerequisites for everything else. Phases 4, 5, and 6 are
independent of each other once phase 3 lands and can proceed in any order.

## Phase 0 — Decisions (complete, 2026-07-02)

All five ADR-001 open questions are resolved and recorded in ADR-001
"Resolved Questions": one booking = one lodge; eligibility default-open
with optional restriction; policies club-wide with per-lodge overrides
(replace, not merge); promos club-wide with a multi-lodge restriction
junction; lodge-operational staff scoped per lodge while `ADMIN` stays
club-wide.

**Risk: Low (docs only). Done.**

## Phase 1 — Lodge entity and admin management (delivered 2026-07-02)

Delivered on `feature/multi-lodge-support`. The lodge identity fields were
copied (not moved) from `EmailMessageSetting`: lodge edits write-through to
the singleton while exactly one active lodge exists
(`syncSoleActiveLodgeIdentity` in `src/lib/lodges.ts`), and the
`EmailMessageSetting` columns are removed in phase 8 once email templates
read per-booking lodge context.

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

**Progress:** the expand release (nullable `lodgeId` columns, Booking FK
added NOT VALID then validated, backfill to the sole lodge, ledger
entries, and all runtime writers stamping `lodgeId` via
`getDefaultLodgeId`) is delivered on `feature/multi-lodge-support`
(2026-07-02). Outstanding: the contract release below (NOT NULL +
re-scoped uniqueness) after the expand release deploys.

Per ADR-001 sequencing, across several PRs:

- Nullable `lodgeId` columns on `LodgeRoom`, `Locker`, `Season`,
  `Booking`, `ChoreTemplate`; backfill to the seeded lodge, then enforce
  NOT NULL per the ADR-001 sequencing.
- Nullable `lodgeId` on `CancellationPolicy`, `MinimumStayPolicy`, and
  `BookingPeriod` (permanently nullable — the club-wide-with-override
  pattern), with a partial unique index preserving today's uniqueness on
  the club-wide (null) partition.
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

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02).
Notable implementation decisions beyond the plan text:

- Capacity fallback: the club-config bed total and the `LodgeSettings`
  capacity override apply to the default lodge only; an additional lodge
  with no configured beds resolves to capacity 0 (`unconfigured_lodge`)
  so it can never be overbooked before setup.
- Overlap queries tolerate null `lodgeId` rows (written by a draining old
  colour during the expand deploy) by counting them against every lodge —
  exact while one lodge exists, conservative afterwards, dead once the
  contract release enforces NOT NULL.
- The advisory lock is `pg_advisory_xact_lock(hashtextextended(lodgeId, 0))`
  via the shared `acquireLodgeCapacityLock` helper; the draft-cleanup cron
  locks every affected lodge in sorted order and re-scans under the locks.
- Policy resolution (`CancellationPolicy`, `MinimumStayPolicy`,
  `BookingPeriod`) goes through `resolvePolicyRowsForLodge` implementing
  the replace-not-merge override rule over the whole policy type.

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

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02).
Implementation decisions beyond the plan text:

- `MemberLodgeAccess` carries a `kind` enum: `BOOKING_RESTRICTION` rows
  mean the member may book only the listed lodges (no rows =
  default-open); `STAFF` rows bind a kiosk account to its lodge.
- Admin bookings on behalf of a member bypass the booking restriction
  deliberately — the restriction is admin-configured policy and the
  on-behalf flow is the audited override path.
- Group-join bookings need no eligibility check: the joiner is a
  freshly created non-login member, default-open by construction.
- Hut-leader PINs match only assignments at the kiosk's bound lodge
  (or legacy null-lodge assignments until the contract release).
- `ADMIN` access remains club-wide; nothing admin-facing reads the
  grant table for authorization.

- New junction table (working name `MemberLodgeAccess`) expressing
  per-lodge grants, used for both staff access and member booking
  eligibility per the phase 0 decisions.
- Lodge-scoped staff access: kiosk/roster tools and hut-leader PIN
  sessions bind to a lodge (`HutLeaderAssignment` gains `lodgeId`; the
  kiosk device declares its lodge). `ADMIN` access stays club-wide and is
  never lodge-filtered — the scoping applies to lodge operations, not
  back-end administration.
- Member booking eligibility enforcement in the booking service (not
  UI-only), default-open: no restriction rows means every active member
  can book every active lodge.

**Risk: High (auth boundaries). Owner approval required.**

## Phase 5 — Chores and roster

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02).
Kiosk requests resolve their lodge via `resolveKioskLodgeId` (PIN
assignment's lodge; STAFF grant for lodge/admin accounts; the member's
active booking for staying guests; session-login hut leaders resolve
via their own assignment). Roster generation, chore templates,
guest lists, and arrival/departure mutations are scoped to that lodge
with null-tolerant filters; cross-lodge mutations are rejected.

- `ChoreTemplate.lodgeId` filtering in roster generation and the chore
  allocator; roster pages and print views take lodge context from the
  kiosk/staff session's lodge.

**Risk: Medium.**

## Phase 6 — Promo codes

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02).
`PromoCodeLodge` junction added (no rows = every lodge); validation and
redemption check the booking's lodge; admin promo routes accept
`lodgeIds` replace-set style and serialize them.

- `PromoCodeLodge` junction table (no rows = redeemable at every lodge;
  rows = redeemable only at those lodges, supporting "two of three"
  restrictions); validation and redemption checks compare against the
  booking's lodge; admin promo UI gains the optional multi-select lodge
  restriction.

**Risk: Medium-High (touches redemption/allocation money paths).**

## Phase 7 — Admin UI retrofit

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02) for
the configuration pages: rooms/beds, seasons, lockers, chores (shared
`LodgeSelect` context selector; lists filter per lodge with null-tolerant
scoping and creates stamp the selected lodge), the hut-leader assignment
form (lodge picker plus a lodge column, with the assignment-overlap check
now scoped per lodge so each lodge can have its own leader), the promo
editor (`lodgeIds` multi-select restriction), and a member Lodge Access
card on the admin member detail page (booking restriction + staff grants
over the phase-4 API). Season overlap validation also became per-lodge
(lodges may run different season windows). Every control honours the
ADR-002 presentation rule via `LodgeSelect`, which renders nothing with
fewer than two lodges. Deliberately deferred: the admin booking
list/search/detail lodge filters and columns, the bed-allocation board's
lodge context, and a booking-policy per-lodge override editor — these
land with the phase-8 booking-flow threading, and the plan bullets below
stay open until they do. Room/locker names stay globally unique until the
phase-2 contract release re-scopes the constraints.

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

## Future Enhancements (post phase 9)

Recorded so they are not lost; each needs its own scoping when picked
up.

- **Cross-lodge waitlist offers.** When a member hits a full lodge, the
  booking flow (and later the waitlist offer email) can surface
  availability at another lodge for the same dates — "Lodge A is full,
  but Lodge B has 4 beds that night." The waitlist entry itself stays
  bound to the requested lodge; this is an offer/suggestion layer on
  top, respecting member eligibility and each lodge's own pricing.
  Depends on phases 3 (per-lodge availability), 4 (eligibility), and 8
  (booking-flow lodge context) all being stable.
- **Per-lodge revenue reporting** via Xero tracking categories or a
  lodge dimension on finance snapshots (kept club-wide by ADR-001; a
  future ADR would record any change).

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
