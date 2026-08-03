# Production Upgrade Runbook

This runbook takes an existing production deployment from a `v0.9.0`-era release
up to `v0.10.0` on the supported blue/green deploy path. It is written for the
operator of a private deployment fork whose production database still predates
the July migration wave, and it is deliberately generic: substitute your own
values for placeholders such as `<owner>` (GitHub owner) and
`https://your-domain.example` (your public domain).

It is a High-risk procedure against live club data. **The owner drives or
approves each step.** Do not run any step against production without the owner
present for the window. Read this whole document, complete the staging
rehearsal, then work top to bottom during the production window and fill in the
[Production execution record](#8-production-execution-record) as you go.

## 0. Scope and companion documents

- Version target: `v0.9.0`-era → `v0.10.0`. Confirm the exact
  tags/commit SHAs before you start (see [§1 pre-flight](#1-pre-flight)).
- Read alongside:
  - `docs/UPGRADING.md` — the fork-facing tag-to-tag upgrade guide and the
    v0.10.0 release notes (the source of truth for the two
    destructive/behaviour changes; published with the release).
  - `docs/BLUE_GREEN_MIGRATION_POLICY.md` — the migration compatibility contract
    and the deploy gate this runbook relies on.
  - `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` — the per-migration safety ledger the
    gate reads.
  - `DEPLOYMENT.md` — the supported blue/green deploy path and health endpoints.
  - `docs/MAINTENANCE.md` → "Quarterly Backup Restore Drill" — the restore-test
    tooling used in pre-flight.

### What does not change

The upgrade path does not alter the money or booking invariants: money stays in
integer cents end to end, and booking dates stay NZ date-only lodge nights. No
migration in the `v0.9.0 → v0.10.0` set rescales, rounds, or re-times either.
Reconciliation totals before and after the upgrade must match to the cent
(see the [§3 spot-check](#3-post-upgrade-checklist)).

---

## 1. Pre-flight

Complete every item below **before** touching the deploy. None of these steps
writes to production; the SQL is read-only.

### 1.1 Verified, restore-tested database backup (with S3 durability confirmed)

A backup you have never restored is a hope, not a backup.

1. Confirm backup **durability first**. Historically, an S3-less host wrote
   `pg_dump` artifacts to a RAM `tmpfs` that every redeploy wiped, while the
   backup job still reported daily SUCCESS — see issue **#1361**
   (`S3-less backups report daily SUCCESS while dumps sit on RAM tmpfs wiped
   every deploy; defaults ship backups OFF`). Before you rely on any backup for
   this upgrade, open **Admin → Integrations → Database Backups**
   (`/admin/backups`, #2095) and verify that the S3 destination is configured
   ("S3 durable"), that the last successful backup is recent, and that no
   "re-enter credentials" banner is showing — then confirm the latest artifact
   actually landed in durable S3 storage (not a tmpfs path that the deploy will
   erase).
2. Take a fresh backup immediately before the window, or confirm the most
   recent durable S3 artifact is the one you will restore from.
3. **Restore-test it** with `scripts/backup-restore-drill.sh --from-dump`
   (see `docs/MAINTENANCE.md` → "Quarterly Backup Restore Drill"). Fetch the
   `.sql.gz` object with read-only S3 credentials **from a workstation, never
   the production host**, then run the drill against a throwaway Postgres 16
   container. The drill proves the dump restores, that Prisma migrations run
   forward on the restored data, and that the money-in-integer-cents sentinels
   hold. Record `Result: PASS` and the backup object id before proceeding.

> A backup that has not been restore-tested does not satisfy this step. The
> induction-item-results deletion in [§2](#2-migrate) is **not reversible** by
> the deploy — this backup is the only recovery path for it. Do not proceed
> without a PASS.

### 1.2 Predict the module-flip: `ClubModuleSettings.updatedByMemberId`

Migration `20260627120000_core_module_defaults_off` switches seven capability
modules **off** for any deployment whose singleton `ClubModuleSettings` row was
never admin-saved. Its `UPDATE` is gated on
`WHERE "id" = 'default' AND "updatedByMemberId" IS NULL`, so
`updatedByMemberId` predicts whether the flip will hit you.

Run this read-only SELECT against production before the window and capture the
output:

```sql
SELECT
  "updatedByMemberId",
  "kiosk",
  "chores",
  "financeDashboard",
  "waitlist",
  "xeroIntegration",
  "bedAllocation",
  "internetBankingPayments"
FROM "ClubModuleSettings"
WHERE "id" = 'default';
```

Interpretation:

- **`updatedByMemberId` IS NULL** → the migration will set all seven of
  `kiosk`, `chores`, `financeDashboard`, `waitlist`, `xeroIntegration`,
  `bedAllocation`, and `internetBankingPayments` to `false`. **Write down which
  of these seven are currently `true`** — you will re-enable exactly those in
  Admin > Modules in [§3](#3-post-upgrade-checklist).
- **`updatedByMemberId` IS NOT NULL** → the row was admin-saved; the migration
  leaves it untouched and no module flips. No post-upgrade re-enable is needed
  for this reason (still confirm the toggles in [§3](#3-post-upgrade-checklist)).

### 1.3 List in-flight inductions whose item results will be deleted

Migration `20260702100000_induction_workflow_types` **deletes**
`MemberInductionItemResult` rows and **NULLs** `selfAssessedAt` /
`selfAssessmentJson` for every `MemberInduction` in status `DRAFT` or
`IN_PROGRESS`. Completed historical inductions are preserved; only in-flight
per-item and self-assessment state is retired. **This deletion is not
reversible** except from the [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed)
backup.

Run this read-only SELECT before the window and capture the output. Consider
completing or exporting any listed induction first if its per-item detail
matters:

```sql
SELECT
  mi."id",
  mi."memberId",
  mi."kind",
  mi."status",
  mi."createdAt",
  COUNT(r."id") AS item_results_to_delete
FROM "MemberInduction" mi
LEFT JOIN "MemberInductionItemResult" r
  ON r."inductionId" = mi."id"
WHERE mi."status" IN ('DRAFT', 'IN_PROGRESS')
GROUP BY mi."id", mi."memberId", mi."kind", mi."status", mi."createdAt"
ORDER BY mi."memberId";
```

A non-empty result means item results and self-assessment state for those
inductions will be gone after [§2](#2-migrate). An empty result means nothing is
lost. Either way, record the count in the execution record.

### 1.4 Capture the current version/tag

Record the currently deployed release tag and commit SHA (the "from" version),
and the target `v0.10.0` tag and its resolved `origin/main` SHA (the "to"
version). The deploy script snapshots the resolved `origin/main` commit and
selects the matching GHCR image tags, so pin exactly which commit you are
deploying and note it in the execution record for rollback reasoning.

### 1.5 Confirm the staging dress rehearsal is recorded

Do not run production until the [§7 staging rehearsal record](#7-staging-rehearsal-record)
shows a PASS with a date. The rehearsal runs the same wave migrations against a
staging copy of live data; it is the evidence that the migrate step behaves on
your data shape.

---

## 2. Migrate

Migrate via the supported blue/green deploy path. Run from the production host:

```bash
./scripts/run-production-blue-green-deploy.sh
```

The script re-enters itself with `--internal-blue-green-deploy` and runs a
20-step engine (`scripts/run-production-blue-green-deploy.sh`). The steps that
matter for this upgrade:

- **Step 12/20 — "Validating Prisma schema against committed migrations".**
  This runs `validate_pending_migrations_blue_green_safe`, which calls
  `scripts/validate-blue-green-migrations.sh` against every pending migration.
  This is the gate. It must pass green (see [§2.1](#21-the-validator-gate-is-expected-green)).
- **Step 13/20 — "Running Prisma migrations".** `prisma migrate deploy` runs
  through the `migrate` service, applying the pending migrations to the shared
  Postgres **while the old color can still be serving traffic**.
- **Step 14/20 / Step 15/20 — starts the new (target) web color and refreshes
  the cron leader on the new release, both before cutover.**
- **Step 16/20 — "Warming the new release and verifying its page cache before
  cutover".** The #2566 gate: it renders every eligible public page on the new
  colour, proves the page cache was populated, and REFUSES the cutover on any
  critical-page failure. Still fully reversible — no traffic has moved. It also
  lengthens the migrate-to-cutover window by the time it takes (bounded by
  `DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS`, 240s by default), which matters for
  [§2.2](#22-agetier-not_applicable--deploy-in-a-quiet-window).
- **Step 17/20 — "Switching Caddy upstream to target web service".** This is
  the **cutover**: Caddy is repointed to the new color, external/internal health
  is verified, then the previous color's connections are drained. Everything
  before this step is reversible by aborting; see [§4](#4-rollback-plan).

### 2.1 The validator gate is expected green

`main` ledgers **all** pending `v0.9.0 → v0.10.0` migrations in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, including the two that a hot-table /
trigger scan flags:

- `20260702180000_add_two_factor_session_challenge` (FK to `Member`), and
- `20260704100000_defer_booking_guest_stay_range_triggers` (trigger swap on
  `Booking` / `BookingGuest`).

The validator's hot-table regex covers `CREATE`/`DROP TRIGGER` and
`CREATE CONSTRAINT TRIGGER`, and CI's `migration-drift` job runs
`scripts/check-migration-safety-coverage.sh` on every PR so a regex-matching
migration cannot merge without a ledger row. So step 12 is **expected to pass**.

**If step 12 fails at "missing ... entry for blue/green migration safety
review":** stop. Do **not** reach for `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` —
that flag only bypasses the *potentially-breaking-SQL* warning
(`found_breaking`); it does **not** bypass a missing/malformed ledger entry
(`found_failure`), and it additionally requires a non-empty
`BLUE_GREEN_MIGRATION_OVERRIDE_REASON`. A missing-entry failure on a clean
`v0.10.0` checkout means your migration tree or ledger has drifted from
`origin/main` — reconcile the checkout against the release tag rather than
editing the ledger on the host. The gate fails **safe**: the old color keeps
serving and no schema change has been applied.

### 2.2 AgeTier `NOT_APPLICABLE` — deploy in a quiet window

The `v0.10.0` set includes the #1440 AgeTier work. The backfill migration
`20260707000100_backfill_org_age_tier_not_applicable` is ledgered
`old_code_compatible=no`. Its ledger row states:

> Single UPDATE flipping ADULT organisation-type members (legacy SCHOOL role or
> ORG access role) to the new NOT_APPLICABLE AgeTier value; touches only those
> rows (typically a handful per club) with brief row locks and no DDL. CAUTION:
> pre-#1440 Prisma clients cannot deserialize NOT_APPLICABLE, so old-color reads
> of the flipped rows (admin members list, that member's detail, school flows)
> can error between migrate and cutover — deploy in a quiet window and cut over
> promptly, or defer this migration until the old color drains (the UPDATE is
> idempotent and safe to run late).

The owner ratified the deploy strategy (owner decision record, 2026-07-07, on
epic #1438):

> **Quiet window**: ship both #1440 migrations normally, deploy at low traffic,
> cut over promptly (per the BLUE_GREEN_MIGRATION_SAFETY.tsv row; the
> defer-the-backfill option remains documented as the operator fallback).

and the Wave-4 operator reminder:

> #1440's migrations follow the ratified quiet-window plan — deploy at low
> traffic and cut over promptly (or defer
> `20260707000100_backfill_org_age_tier_not_applicable` until the old color
> drains; it is idempotent).

**Operator action for `v0.10.0`:** schedule this production window at **low
member-admin traffic**, and minimise the gap between step 13 (migrate) and step
17 (cutover) so the window where the old color could read a flipped
`NOT_APPLICABLE` row is as short as possible. If you cannot deploy in a quiet
window, the documented fallback is to defer only
`20260707000100_backfill_org_age_tier_not_applicable` until the old color has
fully drained onto the new runtime, then run that single migration late — it is
idempotent and safe to run once the new code is serving all traffic.

### 2.3 Verify the migrate step

Step 13 runs `verify_prisma_migration_status`; confirm the engine reports the
database is up to date and that the new color passes `/api/health/ready` before
cutover. Then let the warm-up gate (step 16) pass and step 17 perform the cutover.

### 2.4 Windowed migration deploy sequence

Use this instead of the normal blue/green flow whenever any pending migration is
declared `old_code_compatible=windowed` in the safety ledger. It applies to
`20260803010000_contract_subscription_lockout_drop_enabled` (#2543 / #2561).

**Why the normal flow does not work here.** Blue/green relies on the old colour
continuing to serve while the new schema is applied. This migration drops a column
the old colour's Prisma client still names, so the instant migrate commits, the old
colour raises on every read of `MembershipLockoutSettings` — and because the
booking gates resolve the club's lockout policy through that read, that is every
booking write path, not just the admin screen. There is no version of this deploy
where both colours work at once. The honest answer is a short outage you control,
rather than an outage the members discover.

**The sequence. Do not reorder it — each step exists because the next one is
irreversible without it.**

1. **Build and validate the new images first.** Finish and verify the build
   *before* touching the database. A build that fails after the column is dropped
   leaves you with no working release to start.
2. **Take a fresh backup, and verify it restores.** Immediately before migrating,
   not merely before the deploy. For an ordinary migration the rollback boundary is
   the cutover; for this one it is the migrate step, so this backup is the last
   point you can return to unconditionally. Follow
   [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed).
3. **Put the site into maintenance mode / remove user traffic.** Members must not
   be mid-booking when the schema moves.
4. **Stop the old app AND the background workers.** Both read this settings row.
   Leaving the workers running produces the same errors with nobody watching, and
   fills the logs with failures that look like the migration went wrong.
5. **Migrate.** Run with `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` and a
   `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` that names this window — the validator
   refuses the deploy otherwise, and refuses it regardless if the `rollback.sql`
   is missing.
6. **Start the new release**, confirm `/api/health/ready`, then take the site out
   of maintenance mode.

Keep steps 5-6 as short as the plan allows. The three statements are metadata-only
on a single-row table, so the migration itself is quick; the window is dominated by
stopping and starting the application.

**The warm-up gate (step 16) runs inside this window too**, and it adds the time it
takes to render every public page — bounded by `DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS`
(240s by default). Budget for it rather than switching it off: in a window where the
old colour is already broken, "does the new release actually serve its public pages?"
is the most valuable question you can ask before opening the site again, and the
answer arrives while members are still held out. If the window is genuinely too tight,
lower the timeout and the concurrency rather than disabling the gate.

**Rollback path.** Two options, in order of preference:

- **Forward.** If the new release starts, finish the deploy. This is almost always
  right: the schema is already migrated and the data is intact.
- **`rollback.sql`.** If the new release cannot start, run
  `prisma/migrations/20260803010000_contract_subscription_lockout_drop_enabled/rollback.sql`
  by hand as the migration role, then redeploy the previous release's images. It
  recreates `enabled` from `mode` (`NO_BLOCK` → false, `HARD_BLOCK` and
  `NON_MEMBER_PRICING` → true) and returns `mode` to nullable-without-default. Both
  directions were rehearsed against a production-shaped database
  ([§7.1](#71-windowed-migration-rehearsal-20260803010000_contract_subscription_lockout_drop_enabled)).
  Note that `_prisma_migrations` still records the migration as applied, so rolling
  *forward* afterwards means deleting that row or re-applying `migration.sql` by
  hand.
- **Restore the backup** only if the data itself is wrong, not merely the schema.

---

## 3. Post-upgrade checklist

Work these after a successful cutover.

### 3.1 Re-enable modules in Admin > Modules

If [§1.2](#12-predict-the-module-flip-clubmodulesettingsupdatedbymemberid)
predicted a flip (`updatedByMemberId` was NULL), the following seven toggles
were reset to **off** by `20260627120000_core_module_defaults_off`. Re-enable
in **Admin > Modules** exactly those that were `true` before the upgrade
(from your [§1.2](#12-predict-the-module-flip-clubmodulesettingsupdatedbymemberid)
capture), after confirming provider/setup readiness for each:

1. `kiosk`
2. `chores`
3. `financeDashboard`
4. `waitlist`
5. `xeroIntegration`
6. `bedAllocation`
7. `internetBankingPayments`

Saving the module page stamps `updatedByMemberId`, so this reset is a one-time
event, not a recurring one.

### 3.2 Historical access-role/membership cleanup window

The temporary access-role and membership-type cleanup rehearsal applied only to
forks that deployed an intermediate `main` during the 2026-06-28 .. 2026-06-30
window. That fork migration window is closed, and the disposable-data rehearsal
note has been retired from the living documentation set. A fork upgrading from
a `v0.9.0`-era tag straight to `v0.10.0` does not need this check.

### 3.3 Spot-check money and integrations

- Open the **Xero reconciliation report** and confirm it reconciles; totals must
  match the cent. Money is integer cents — no rounding or rescale is introduced
  by this upgrade, so pre- and post-upgrade totals should agree exactly.
- Spot-check a handful of recent **bookings** and their **payments**: prices,
  captured amounts, and refunds/credits should read identically to before the
  upgrade.

### 3.4 Manual E2E-critical journeys

Drive each critical journey by hand against the live site
(`https://your-domain.example`):

1. **Login**, including **2FA** (the two-factor challenge/session tables ship in
   this release — confirm a 2FA-enrolled member can complete a challenge).
2. **Book** a lodge night (dates render as the expected NZ date-only nights).
3. **Pay** for a booking end to end.
4. **Admin approve** a booking/application.

Any failure here is a signal to consider [§4 rollback](#4-rollback-plan).

### 3.5 Fork automation note: removed `POST /api/bookings/cancel`

The body-based `POST /api/bookings/cancel` route has been removed. If any fork
automation, script, or integration still calls that endpoint, it will now 404 —
repoint it to the current cancellation surface before relying on the upgraded
deployment.

---

## 4. Rollback plan

Rollback follows `docs/BLUE_GREEN_MIGRATION_POLICY.md`. The policy's whole point
is that migrations preserve old-code/new-schema compatibility until the previous
color drains, which makes the rollback boundary the **cutover (step 17)**.

That boundary holds only while every pending migration really is old-code
compatible. It does **not** hold for a migration the ledger declares
`old_code_compatible=windowed`: once its migrate step commits, the old color is
already broken, so the boundary moves back to **step 13 (migrate)** and the
recovery paths are forward to cutover, the migration's own `rollback.sql`, or the
verified backup.

**The ledger now holds a real `windowed` row**, and it is not the only migration in
that class. Check for both:

- `20260803010000_contract_subscription_lockout_drop_enabled` (#2543 / #2561) is
  declared `old_code_compatible=windowed`. It drops `MembershipLockoutSettings.enabled`,
  so the previous release's Prisma client raises on every read of that model the
  moment migrate commits — which means every booking write path on the old colour,
  not just the admin panel. It ships a tested `rollback.sql` and requires the
  maintenance-window sequence in [§2.4](#24-windowed-migration-deploy-sequence).
- **`v0.10.0` has one migration in that class too**, declared before the value
  existed. `20260707000100_backfill_org_age_tier_not_applicable` is
  `old_code_compatible=no`, and its `lock_impact_plan` states plainly that
  "old-color reads of the flipped rows … can error between migrate and cutover"
  (quoted in full at [§2.2](#22-agetier-not_applicable--deploy-in-a-quiet-window)).

So do **not** check the ledger for a `windowed` row alone: check for a `windowed`
row **or** any `yes`/`no` row whose `lock_impact_plan` carries an old-code caveat
(`OLD-CODE CAVEAT`, `RESIDUAL WINDOW`, `CAUTION`, "until cutover", "idle or
routed"). `docs/BLUE_GREEN_MIGRATION_POLICY.md` → "Historical note" gives the
class rule and a starting-point filter.

### Before cutover (up to and including step 13/14/15/16)

The **old color is still serving traffic**. The rest of this set is
expand-shaped and old-code-compatible, so if the new color fails to come up
healthy, or the warm-up gate refuses, or you abort before step 17, you can stop the deploy and leave the old
color serving the already-migrated (backward-compatible) schema. This is a
blocked upgrade, not an outage. No traffic ever reached the new color.

**Except once step 13 has applied `20260707000100`.** From that point the old
color is reading `NOT_APPLICABLE` rows its Prisma client cannot deserialize, so
aborting leaves the admin members list, those members' detail pages and the
school flows erroring with no cutover coming — a blocked upgrade *and* a partial
outage. If the new color fails its health check after that migration has
committed, go **forward** to cutover if the new color can be made healthy;
otherwise restore from the pre-migrate backup. This is why [§2.2](#22-agetier-not_applicable--deploy-in-a-quiet-window)
offers the fallback of deferring that single migration until the old color has
fully drained: taking it keeps the whole window inside the ordinary
abort-is-safe boundary.

### After cutover (step 17 onward)

Traffic is on the new color. To fall back you re-point Caddy to the previous
color (the engine restores the previous upstream file on a failed reload; a
deliberate rollback is the same operation in reverse) while the old color
containers are still present. Because the schema is expand-only and
old-code-compatible, the previous color can serve against the migrated database —
with the same `20260707000100` exception: the flipped `NOT_APPLICABLE` rows stay
flipped, so a rolled-back old color still errors on the admin members list, those
members' detail pages and the school flows. Re-pointing Caddy restores every
other surface; treat those as still-down until you go forward again or un-flip the
rows as an owner-approved data operation (see below).

### What is NOT reversible by rollback

- **The induction item-results deletion** from
  `20260702100000_induction_workflow_types` is a hard `DELETE` (plus NULLed
  self-assessment fields). Re-pointing Caddy does **not** bring those rows back.
  The [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed)
  restore-tested backup is the **only** recovery path for that data.
- The `20260627120000` module-flip and the `20260707000100` AgeTier backfill are
  data changes, not schema removals; they are re-doable/idempotent rather than
  auto-reversed. Re-enable modules via Admin > Modules ([§3.1](#31-re-enable-modules-in-admin--modules)).
  Treat any need to un-flip AgeTier rows as an owner-approved data operation.

If a rollback becomes necessary, capture evidence, re-point to the old color to
restore service, and escalate to the owner before any data-repair action.

---

## 5. Invariant reminders

- Money stays in **integer cents** everywhere; this upgrade introduces no
  rescaling or rounding. Reconciliation totals must be cent-identical before and
  after.
- Booking dates stay **NZ date-only lodge nights**; no migration re-times or
  re-zones them.
- The blue/green gate stays idempotent and fails safe; external provider calls
  stay outside long database transactions.

---

## 6. Sign-off gate

- [ ] [§1](#1-pre-flight) pre-flight complete: restore-tested backup PASS, S3
      durability confirmed (#1361), module-flip prediction captured, in-flight
      inductions listed, from/to versions pinned, staging rehearsal recorded.
- [ ] [§2](#2-migrate) migrate: validator gate green (step 12), migrations
      applied (step 13), AgeTier quiet-window observed, warm-up gate green (step
      16), cutover clean (step 17).
- [ ] [§3](#3-post-upgrade-checklist) post-upgrade: modules re-enabled,
      access-role audit run if applicable, money/Xero spot-check clean, all four
      critical journeys pass, fork automation repointed off the removed cancel
      route.
- [ ] Owner present for the window and signs off the
      [execution record](#8-production-execution-record).

---

## 7. Staging rehearsal record

The private deployment fork's **staging** environment has already run the July
wave migrations against a **live-DB snapshot** — that run is the dress
rehearsal for this upgrade. This is asserted **per the 2026-07-06 audit /
issue #1364**. The owner confirms the concrete date and outcome below before the
production window opens.

| Field | Value |
| --- | --- |
| Rehearsal environment | Private fork staging (live-DB snapshot) |
| Wave migrations applied | `v0.9.0`-era → `v0.10.0` set (all pending) |
| Rehearsal date | _<owner to confirm — YYYY-MM-DD>_ |
| Result (PASS/FAIL) | _<owner to confirm — must be PASS before production>_ |
| Notable findings / deviations | _<owner to confirm>_ |
| Confirmed by | _<owner>_ |

> A recorded PASS here is a precondition for [§2](#2-migrate). If the rehearsal
> has not been recorded, do not run production.

### 7.1 Windowed migration rehearsal: `20260803010000_contract_subscription_lockout_drop_enabled`

The repo's first `old_code_compatible=windowed` migration (#2543 / #2561) was
rehearsed both ways before merge, as the owner directive requires. Recorded here
because a windowed migration's rollback path is only a plan until somebody has run
it.

**Environment.** Throwaway PostgreSQL 16.14 container. The **full migration
history** applied to an empty database, then the demo seed, giving a
production-shaped dataset: 35 members, 19 bookings (every status), 40 booking
guests, 13 payments, 8 member subscriptions. The contract migration was held back,
so the starting point was the state the **expand** migration leaves:
`enabled BOOLEAN NOT NULL DEFAULT true` plus a nullable `mode` with no default.

That intermediate state is **not** a deployed release, and it matters where the
distinction lands. Both migrations ship in this one release, so the release actually
running in production has `enabled` and **no `mode` column and no
`SubscriptionLockoutMode` type at all**. The intermediate is nonetheless the correct
pre-state for the four cycles below, because it is exactly what
`prisma migrate deploy` finds when it reaches the contract migration — the expand
migration having just run ahead of it in the same command. Where the previously
deployed schema *is* the thing under test — the previous release's own client — it is
used instead, in "The windowed claim" below.

**Four deploy → rollback cycles**, one per pre-state a real club can hold. Each
applied `prisma migrate deploy`, asserted the post-state, then ran `rollback.sql`
and asserted the restored shape. 24 assertions, all PASS:

| Pre-state (previous release) | After migrate | After `rollback.sql` |
| --- | --- | --- |
| `enabled=false, mode=NULL` — club that deliberately switched the lockout OFF | `mode=NO_BLOCK` | `enabled=false` |
| `enabled=true, mode=NULL` — club that never opened the panel | `mode=HARD_BLOCK` | `enabled=true` |
| `enabled=true, mode=NON_MEMBER_PRICING` — mode already chosen | `mode=NON_MEMBER_PRICING` (not reset) | `enabled=true` |
| `enabled=true, mode=NO_BLOCK` — chosen mode disagrees with the stale boolean | `mode=NO_BLOCK` (chosen mode wins) | `enabled=false` |

Every cycle also confirmed `mode` became `NOT NULL` with
`DEFAULT 'HARD_BLOCK'::"SubscriptionLockoutMode"`, the `enabled` column count went
to zero, and the row's other settings were untouched
(`financialYearEndMonthOverride = 7`, `updatedAt = 2026-05-05 09:00:00` —
unchanged, because this is a schema migration and not an admin edit).

**App-level reads on the migrated schema** (new Prisma client, through the
functions every booking gate uses, on the club that had switched the lockout off):

```
raw row mode            = NO_BLOCK
raw row has 'enabled'   = false
loadMembershipLockout   = mode=NO_BLOCK yearEnd=7 textFallback=true
resolveSubscriptionMode = NO_BLOCK
peekSubscriptionMode    = NO_BLOCK
enforcementActive       = false
APP READ OK
```

**The windowed claim was verified, not assumed — and re-verified against the right
client.** The first pass used a client generated from the expand-only intermediate
schema, which names **both** `enabled` and `mode`. That exercises the dropped column,
but it is not the client an operator rolls back to. So the check was re-run with a
client generated from the previously deployed schema itself
(`git show origin/main:prisma/schema.prisma`), which names `enabled` and **does not
name `mode` anywhere**. Same throwaway container, migrations applied, one
`MembershipLockoutSettings` row (`mode = NO_BLOCK`, `financialYearEndMonthOverride = 7`,
`updatedAt = 2026-05-05 09:00:00`):

- against the **migrated** schema both a read and a write fail, which is what makes
  this migration `windowed` rather than `yes`:
  ```
  === previous-release client against the MIGRATED schema (mode NOT NULL, enabled dropped) ===
  READ FAILED:  [P2022] The column `MembershipLockoutSettings.enabled` does not exist in the current database.
  WRITE FAILED: [P2022] The column `MembershipLockoutSettings.enabled` does not exist in the current database.
  ```
- after `rollback.sql`, the same client reads *and writes* normally:
  ```
  === previous-release client against the ROLLED-BACK schema ===
  READ OK: {"id":"default","enabled":false,"financialYearEndMonthOverride":7,
            "textFallbackEnabled":true,"useFeeScheduleItemCodes":false,
            "updatedByMemberId":null,"createdAt":"2026-05-05T09:00:00.000Z",
            "updatedAt":"2026-05-05T09:00:00.000Z"}
  WRITE OK: enabled -> true
  ```
  Note what the read does **not** contain: `mode`. The previous release's client never
  names the column, which is why leaving it in place is safe — and why `rollback.sql`
  deliberately does not drop it, since after the backfill it is the only record of
  each club's policy.
- the restored column is byte-identical to the one `20260626120000` created,
  `enabled BOOLEAN NOT NULL DEFAULT true`, and the row's other values are untouched.
- the leftovers are exactly the two inert extras, measured rather than assumed.
  `prisma migrate diff` from the rolled-back database to the previous release's
  datamodel reports:
  ```
  ALTER TABLE "MembershipLockoutSettings" DROP COLUMN "mode";
  DROP TYPE "SubscriptionLockoutMode";
  ```
  That is the intended end state, not drift to chase, and `rollback.sql` says so where
  an operator will read it. (Measured before `main`'s unrelated #2553 hold-expiry
  migration was merged into this branch; that migration is additive and does not touch
  `MembershipLockoutSettings`, so the two leftovers above remain the complete list.)

**Backfill correctness** is additionally pinned by
`prisma/migration-verification/20260803010000_contract_subscription_lockout_drop_enabled.ts`,
executed against the same real PostgreSQL by
`src/lib/__tests__/data-migration-verification.realdb.test.ts`: 5 pre-states and
4 mutants, all detected — the inverted `CASE`, an unconditional `HARD_BLOCK`, a
dropped `WHERE "mode" IS NULL`, and leaving `mode` nullable — plus the runner's own
"migration not applied at all" mutant and its requirement that at least one mutant
be caught by a row **mismatch** rather than a raised error.

| Field | Value |
| --- | --- |
| Rehearsal environment | Throwaway PostgreSQL 16.14, full migration history + demo seed |
| Migration | `20260803010000_contract_subscription_lockout_drop_enabled` |
| Rehearsal date | 2026-08-03 |
| Result | **PASS** — 4/4 deploy+rollback cycles, 24/24 assertions, 55/55 fixture assertions |
| Notable findings | One, in the evidence rather than the migration. The first client check was generated from the expand-only intermediate schema, which is not a deployed release; re-run with the previously deployed schema's own client it fails on the migrated shape and reads *and writes* after `rollback.sql`, so the conclusion is unchanged and now rests on the right client. |
| Rehearsed by | Lane implementation session (pre-merge, on PR #2560) |

> This rehearsal used a demo-seeded database, not a production snapshot. Before the
> production window, re-run the same two steps (migrate, then `rollback.sql`)
> against a **restored copy of the production backup** — the settings row's real
> value is the one thing a seed cannot supply.

---

## 8. Production execution record

Fill this in live during the production window.

| Field | Value |
| --- | --- |
| Execution date | _<YYYY-MM-DD>_ |
| Operator | _<name>_ |
| Owner present | _<name>_ |
| From version (tag / SHA) | _<...>_ |
| To version (tag / SHA) | _<v0.10.0 / SHA>_ |
| Backup object id (restore-tested) | _<...>_ |
| S3 durability confirmed (#1361) | _<yes/no>_ |
| Module-flip predicted (updatedByMemberId NULL?) | _<yes/no + toggles to re-enable>_ |
| In-flight inductions affected (count) | _<...>_ |
| Validator gate result (step 12) | _<green / details>_ |
| AgeTier plan (quiet window / deferred backfill) | _<...>_ |
| Cutover time (step 17) | _<HH:MM TZ>_ |
| Modules re-enabled | _<list>_ |
| Access-role audit run / result | _<n/a or PASS>_ |
| Money + Xero spot-check | _<clean / notes>_ |
| Critical journeys (login+2FA / book / pay / approve) | _<pass/fail each>_ |
| Post-checklist sign-off (owner) | _<name + time>_ |
