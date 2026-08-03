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
19-step engine (`scripts/run-production-blue-green-deploy.sh`). The steps that
matter for this upgrade:

- **Step 12/19 — "Validating Prisma schema against committed migrations".**
  This runs `validate_pending_migrations_blue_green_safe`, which calls
  `scripts/validate-blue-green-migrations.sh` against every pending migration.
  This is the gate. It must pass green (see [§2.1](#21-the-validator-gate-is-expected-green)).
- **Step 13/19 — "Running Prisma migrations".** `prisma migrate deploy` runs
  through the `migrate` service, applying the pending migrations to the shared
  Postgres **while the old color can still be serving traffic**.
- **Step 14/19 / Step 15/19 — starts the new (target) web color and refreshes
  the cron leader on the new release, both before cutover.**
- **Step 16/19 — "Switching Caddy upstream to target web service".** This is
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
16 (cutover) so the window where the old color could read a flipped
`NOT_APPLICABLE` row is as short as possible. If you cannot deploy in a quiet
window, the documented fallback is to defer only
`20260707000100_backfill_org_age_tier_not_applicable` until the old color has
fully drained onto the new runtime, then run that single migration late — it is
idempotent and safe to run once the new code is serving all traffic.

### 2.3 Verify the migrate step

Step 13 runs `verify_prisma_migration_status`; confirm the engine reports the
database is up to date and that the new color passes `/api/health/ready` before
cutover. Then let step 16 perform the cutover.

### 2.4 Windowed migration deploy sequence

Use this instead of the normal blue/green flow whenever any pending migration is
declared `old_code_compatible=windowed` in the safety ledger. Two migrations are
in that class:

- `20260803010000_contract_subscription_lockout_drop_enabled` (#2543 / #2561) —
  covered immediately below;
- `20260803030000_contract_drop_family_group_member_role` (#2520) — covered in
  [§2.4.1](#241-2520-drop-familygroupmemberrole).

**If both are pending, they share ONE window.** `prisma migrate deploy` applies
both in the same command — you do not stop and start the application twice. Work
the checks in [§2.4.1](#241-2520-drop-familygroupmemberrole) as well as the ones
here, and name both migrations in the override reason.

**And when both are pending, §2.4.1's ordering governs the combined window**, not
the ordering in the list immediately below. The two differ in one place: this list
takes the backup at step 2, before traffic is removed; §2.4.1 takes it at step 7,
*after* the app and every worker have stopped and no old connection remains. The
later position is strictly safer — the snapshot is a quiet point, with no writes
landing between the backup and the migration — and it is the order the owner
directed for #2520 (3 Aug 2026). Nothing else about this list changes, and it stands
as written for a window carrying only `20260803010000`.

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

#### 2.4.1 #2520: drop `FamilyGroupMember.role`

`20260803030000_contract_drop_family_group_member_role` is the second `windowed`
migration. It is one statement — `ALTER TABLE "FamilyGroupMember" DROP COLUMN
"role"` — with no backfill and no DML of any kind.

**Owner authorisation.** The original plan was two releases: deploy the runtime
removal (PR #2565), soak seven days, then drop. The owner superseded that on
3 Aug 2026: the drop ships now, as part of the Tokoroa cutover, behind an accepted
maintenance window. No further owner approval is required to run it, provided this
sequence is followed.

**Why the normal flow does not work here.** The runtime removal was never deployed
on its own, so the release currently in production is the last tagged one, whose
Prisma client names the column freely. Measured against `v0.13.2`'s own
`prisma/schema.prisma` (`role String @default("MEMBER")`, no `@ignore`):

- `listOneStepPartnerCandidates` and the one-step path of `requestPartnerLink`
  put `role: "ADMIN"` in the **WHERE clause**, so they name the column directly —
  and the member profile page renders the first of those;
- every unnarrowed `find`/`create`/`update`/`upsert`/`delete` on the join table
  names every scalar in its `SELECT` or implicit `RETURNING`;
- a static `@default("MEMBER")` is materialised **client-side** as a bind
  parameter, so the column appears in the column list of every insert that client
  emits, even one that sets no role and narrows itself with `select`;
- an `include:` on the join table (admin family groups) and an explicit
  `role: true` (`GET /api/member/onboarding`) name it too.

So the moment the DROP commits, the previous release raises Postgres 42703 /
Prisma P2022 across the whole family surface: member profile, admin family groups,
member onboarding, family join/invite/removal, member merge, Xero member import
and nomination. There is no ordering that keeps both versions working.

**The sequence, in the owner's order. Do not reorder it.**

1. **Build, publish and verify the complete replacement image** — before the live
   site goes down. A build that fails after the column is dropped leaves no
   working release to start.
2. **Confirm the image carries both halves**: the no-role runtime code and this
   migration. Inside the built image:
   ```bash
   # the migration is present
   ls prisma/migrations/20260803030000_contract_drop_family_group_member_role/
   # and the runtime cannot name the column: no `role` in the client's scalar enum
   node -e "const {Prisma}=require('@prisma/client');console.log(Object.keys(Prisma.FamilyGroupMemberScalarFieldEnum).join(','))"
   # expect: id,familyGroupId,memberId,joinedAt
   ```
3. **Announce or enable maintenance mode** and remove public traffic from the
   existing application.
4. **Stop all Tokoroa web processes.**
5. **Stop every background worker, scheduler, cron runner, queue consumer** and
   anything else that can reach the shared database. Leaving them up produces the
   same errors with nobody watching, and fills the logs with failures that look
   like the migration went wrong.
6. **Verify nothing old is still connected.** No application process, and no
   database connection capable of issuing application queries, may remain:
   ```sql
   SELECT pid, usename, application_name, client_addr, state,
          left(query, 80) AS query
   FROM pg_stat_activity
   WHERE datname = current_database()
     AND pid <> pg_backend_pid();
   ```
   Expect only your own admin session. Anything else is a process step 4 or 5
   missed — go back and stop it rather than migrating around it.
7. **Take and verify a fresh database backup**, immediately before migrating, not
   merely before the deploy. For an ordinary migration you can abort up to the
   cutover; for this one the point of no return is the migrate step, so this backup
   is the last unconditional way back. Follow
   [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed).
8. **Record the pre-migration checks.** Paste the output into
   [§8](#8-production-execution-record) — after step 9 these values cannot be
   recovered from the database.
   ```sql
   -- (a) row count
   SELECT COUNT(*) AS family_group_member_rows FROM "FamilyGroupMember";

   -- (b) distinct role values and their counts (expect mostly 'MEMBER'; 'ADMIN'
   --     and 'LEAD' are the other two labels that ever existed)
   SELECT "role", COUNT(*) AS rows
   FROM "FamilyGroupMember"
   GROUP BY "role"
   ORDER BY rows DESC;

   -- (c) the column exists, and in the shape the rollback script restores
   SELECT column_name, data_type, is_nullable, column_default
   FROM information_schema.columns
   WHERE table_name = 'FamilyGroupMember' AND column_name = 'role';
   -- expect: role | text | NO | 'MEMBER'::text
   ```
   ```bash
   # (d) the replacement runtime cannot reference the column. Run inside the
   #     replacement image built at step 1 — this is the same assertion CI pins in
   #     src/lib/__tests__/family-group-role-retirement.test.ts.
   node -e "const {Prisma}=require('@prisma/client');const s=Object.keys(Prisma.FamilyGroupMemberScalarFieldEnum);if(s.includes('role'))throw new Error('ABORT: replacement client still names role');console.log('replacement runtime cannot name role:',s.join(','))"
   ```
   **Also recommended, and the only way to restore the exact labels later:** dump
   them per row before they are destroyed. `rollback.sql` has a commented restore
   step that reads this file back.
   ```
   \copy (SELECT "id", "role" FROM "FamilyGroupMember" ORDER BY "id") TO 'family-group-member-role-YYYYMMDD.csv' CSV HEADER
   ```
9. **Apply the migration** with the breaking-migration override and a specific
   recorded reason:
   ```bash
   ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 \
   BLUE_GREEN_MIGRATION_OVERRIDE_REASON="#2520 windowed maintenance window <DATE>: public traffic removed, web and all workers stopped, no old connections, fresh verified backup taken, pre-migration checks recorded" \
   npx prisma migrate deploy
   ```
   The validator refuses the deploy without both variables — and refuses it
   regardless if `rollback.sql` is missing beside the migration.
10. **Verify the migrate step.** The column is gone and the history is right:
    ```sql
    -- expect zero rows
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'FamilyGroupMember' AND column_name = 'role';

    -- expect exactly one applied row, no rolled-back marker
    SELECT migration_name, finished_at, applied_steps_count, rolled_back_at
    FROM "_prisma_migrations"
    WHERE migration_name = '20260803030000_contract_drop_family_group_member_role';

    -- and the rest of the table is untouched
    SELECT COUNT(*) FROM "FamilyGroupMember";  -- matches step 8(a)
    ```
11. **Start the replacement web application and replacement workers only.** Never
    the old images — see the rollback boundary below.
12. **Smoke-test**, in this order:
    - sign-in;
    - viewing an existing family group (member side and **Admin → Family
      Groups**);
    - creating or updating family-group membership, where safely testable;
    - family requests and approvals (join / invite / removal);
    - member merge, and the other affected administration paths;
    - ordinary member and admin page operation, including the **member profile
      page** — that is where the old code's `role: "ADMIN"` read lived, so it is
      the most direct check that the replacement runtime does not repeat it;
    - worker and scheduled-job startup.
13. **Check the logs** — application, worker, Prisma and PostgreSQL — for
    missing-column, unknown-field or family-lifecycle errors. Grep for `42703`,
    `P2022`, `does not exist` and `Unknown field`.
14. **Restore public traffic** only after every check above passes.

Keep the interval between step 4 and step 11 as short as practical. The migration
itself is one metadata-only statement on a small cold table — PostgreSQL marks the
attribute dropped and performs no table rewrite — so the window is dominated by
stopping and starting the application.

**Rollback boundary — read before you start.** Once the DROP commits:

- **Do not restart the old application version, and do not route traffic back to
  it.** Its client names a column that no longer exists; it will fail across the
  family surface, and re-pointing Caddy does not fix that.
- A rollback to the old version requires **first** either running
  `prisma/migrations/20260803030000_contract_drop_family_group_member_role/rollback.sql`
  by hand as the migration role, **or** restoring the verified step 7 backup.
- `rollback.sql` recreates the column as `TEXT NOT NULL DEFAULT 'MEMBER'` —
  byte-identical to the shape
  `20260407120000_add_family_group_member_join_table` created and exactly what the
  previous release's client expects — and the constant default repopulates every
  existing row in that one statement.
- **The per-row values are not restored by script** and cannot be: PostgreSQL
  cannot un-drop a column. Every row comes back as `'MEMBER'`. That is the safe
  compatibility value (it is the column's own default, so it is the *actual* value
  of every row inserted since the runtime removal, and it is the least-privileged
  of the three labels that ever existed), but it is not free: on a rolled-back
  release predating #2284 nobody holds `ADMIN`, so the one-step partner
  declaration finds no candidates and returns its 403 for a no-login target.
  Everything else about family groups is unaffected, because nothing else reads
  the value. Fail-closed, and the ordinary consent round-trip still works. For the
  exact labels, use the step 8 `\copy` dump with the commented restore step in
  `rollback.sql`, or the backup.
- After a `rollback.sql`, `_prisma_migrations` still records the migration as
  applied, so rolling *forward* later means deleting that row or re-applying
  `migration.sql` by hand.

If the replacement application fails after the migration and cannot be corrected
promptly, choose one of exactly two paths: **roll forward** by fixing and starting
the replacement runtime, or **run the verified schema rollback / restore the
backup before restarting the previous version.** There is no third option in which
the old version runs against the migrated schema.

Both directions were rehearsed against a production-shaped database before merge
([§7.2](#72-windowed-migration-rehearsal-20260803030000_contract_drop_family_group_member_role)).

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
color drains, which makes the rollback boundary the **cutover (step 16)**.

That boundary holds only while every pending migration really is old-code
compatible. It does **not** hold for a migration the ledger declares
`old_code_compatible=windowed`: once its migrate step commits, the old color is
already broken, so the boundary moves back to **step 13 (migrate)** and the
recovery paths are forward to cutover, the migration's own `rollback.sql`, or the
verified backup.

**The ledger now holds two real `windowed` rows**, and they are not the only
migrations in that class. Check for all three:

- `20260803010000_contract_subscription_lockout_drop_enabled` (#2543 / #2561) is
  declared `old_code_compatible=windowed`. It drops `MembershipLockoutSettings.enabled`,
  so the previous release's Prisma client raises on every read of that model the
  moment migrate commits — which means every booking write path on the old colour,
  not just the admin panel. It ships a tested `rollback.sql` and requires the
  maintenance-window sequence in [§2.4](#24-windowed-migration-deploy-sequence).
- `20260803030000_contract_drop_family_group_member_role` (#2520) is declared
  `old_code_compatible=windowed` too. It drops `FamilyGroupMember.role`, which the
  previous release's client names in ordinary projections, in insert column lists
  **and** in a `WHERE` clause (`role: "ADMIN"`), so the moment migrate commits the
  old version fails across the whole family surface — including the member profile
  page. It ships a tested `rollback.sql` and its own ordered sequence at
  [§2.4.1](#241-2520-drop-familygroupmemberrole). If both windowed migrations are
  pending they share **one** window.
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

### Before cutover (up to and including step 13/14/15)

**This subsection describes the ORDINARY blue/green deploy.** It does not apply to
a release carrying a `windowed` migration: there the old colour is deliberately
stopped before migrate, so there is no "old colour still serving" state to fall
back into. Use [§2.4](#24-windowed-migration-deploy-sequence) and, for #2520,
[§2.4.1](#241-2520-drop-familygroupmemberrole) instead.

The **old color is still serving traffic**. The rest of this set is
expand-shaped and old-code-compatible, so if the new color fails to come up
healthy, or you abort before step 16, you can stop the deploy and leave the old
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

### After cutover (step 16 onward)

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
- **The `FamilyGroupMember.role` values dropped by `20260803030000`** are gone for
  good: PostgreSQL cannot un-drop a column, and `rollback.sql` can only recreate
  the column and refill it with the safe `'MEMBER'` default. Recovering the actual
  labels needs either the per-row `\copy` dump the pre-migration checks take
  ([§2.4.1](#241-2520-drop-familygroupmemberrole) step 8) or the
  [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed)
  backup. Nothing reads those labels — that is why the drop is safe — so this is a
  record-keeping loss, not a behavioural one, with the single fail-closed exception
  named in §2.4.1's rollback boundary.

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
      applied (step 13), AgeTier quiet-window observed, cutover clean (step 16).
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

### 7.2 Windowed migration rehearsal: `20260803030000_contract_drop_family_group_member_role`

The repo's second `old_code_compatible=windowed` migration (#2520) was rehearsed
both ways before merge. Recorded here for the same reason as §7.1: a windowed
migration's rollback path is only a plan until somebody has run it.

**Environment.** Throwaway PostgreSQL 16.14 container (`postgres:16`, Debian
16.14-1). The **full migration history** applied to an empty database with the drop
migration held back, so the starting point is exactly what `prisma migrate deploy`
finds when it reaches it. Four `FamilyGroupMember` rows across two family groups,
covering **every label that ever existed** plus the shape that matters most: one row
inserted *without naming the column*, so it took `'MEMBER'` from the database
default — the post-#2565 insert shape. `FamilyGroup.billingMembershipId` pointed at
one of the rows, because member-merge re-points that pointer and a `DROP COLUMN`
must not disturb it.

**Pre-migration checks** — the same four the window prescribes at
[§2.4.1](#241-2520-drop-familygroupmemberrole) step 8, run here to prove the queries
are right before an operator depends on them:

```
 family_group_member_rows        role  | rows      column_name | data_type | is_nullable | column_default
--------------------------      --------+------     -------------+-----------+-------------+----------------
                        4        MEMBER |    2      role        | text      | NO          | 'MEMBER'::text
                                 ADMIN  |    1
                                 LEAD   |    1
```

The per-row `\copy` dump produced `id,role` for all four rows. The column's measured
shape is **`text | NO | 'MEMBER'::text`**, which is what `rollback.sql` claims to
restore and what `20260407120000_add_family_group_member_join_table` created.

**The `windowed` claim was verified, not assumed, against the right client.** A
Prisma client was generated from **`v0.13.2`'s own `prisma/schema.prisma`** — the
last tagged release, which is what production runs when this lands because the
runtime half was never deployed separately. That client's scalars are
`id,familyGroupId,memberId,role,joinedAt`. Three call shapes were exercised, one per
mechanism the ledger row names:

| Old-client call | Pre-migration | After migrate | After `rollback.sql` |
| --- | --- | --- | --- |
| unnarrowed `findMany` (names every scalar in the `SELECT`) | OK, 4 rows | **FAILED `[P2022]`** | OK, 4 rows |
| `where: { memberId, role: "ADMIN" }` (the one-step partner read) | OK, 1 row | **FAILED `[P2022]`** | OK, **0 rows** |
| `create` setting **no** role, narrowed to `select: { id: true }` | OK | **FAILED `[P2022]`** | OK |

```
=== previous-release (v0.13.2) client against the MIGRATED schema (role dropped) ===
old client scalars: id,familyGroupId,memberId,role,joinedAt
READ   FAILED: [P2022] The column `FamilyGroupMember.role` does not exist in the current database.
FILTER FAILED: [P2022] The column `FamilyGroupMember.role` does not exist in the current database.
WRITE  FAILED: [P2022] The column `role of relation FamilyGroupMember` does not exist in the current database.
```

The **write** result is the one worth reading twice: that call sets no role and
narrows itself with `select`, and it still fails — because a static
`@default("MEMBER")` is materialised client-side as a bind parameter, so the column
is in the `INSERT` column list regardless. That is the claim in the ledger row that
would have been easiest to get wrong, and it is measured here rather than reasoned
about.

**After migrate.** The column is gone, the four surviving scalars are
`id, familyGroupId, memberId, joinedAt`, `_prisma_migrations` records the migration
**once** with `applied_steps_count = 1` and no rolled-back marker, all **4 rows
survive**, and `FamilyGroup.billingMembershipId` still points where it did.
`prisma migrate diff` from the migrated database to this branch's
`prisma/schema.prisma` reports **"No difference detected"** — the schema-field
removal and the migration agree, which is what the CI drift gate checks.

**The replacement runtime cannot name the column**, asserted three ways:

- the generated client's `FamilyGroupMemberScalarFieldEnum` is exactly
  `id,familyGroupId,memberId,joinedAt`;
- of the 66 `FamilyGroupMember*` type blocks in the generated
  `index.d.ts`, **none** names `role`;
- an unnarrowed `findMany` on the **replacement** client against the **migrated**
  database returns rows normally.

The exact enforcement is worth stating precisely, because the shorthand overstates
it and the difference is why the old delegate-scan guards could be retired:

| Call shape naming `role` on the replacement client | Result |
| --- | --- |
| `where: { role: "ADMIN" }` | **compile error** — `'role' does not exist in type 'FamilyGroupMemberWhereInput'` |
| `select: { id: true, role: true }` | compiles; **`PrismaClientValidationError`** at runtime, before any SQL |
| `create({ data: { …, role: "ADMIN" } })` | compiles; **`PrismaClientValidationError`** at runtime, before any SQL |

So **no call shape emits SQL naming the column** — there is no route to a Postgres
42703 from the replacement runtime — but only the `WHERE` shape is caught by `tsc`.
The other two fail loudly and unconditionally on first invocation instead. The
implicit hazard the old guard existed for (an `include:` naming the column with no
author intent) is structurally impossible now, which is the basis on which the
delegate scans were deleted from
`src/lib/__tests__/family-group-role-retirement.test.ts`.

**Rollback direction.** `rollback.sql` run by hand as the migration role:

- it restored `role | text | NO | 'MEMBER'::text` — **byte-identical** to the
  original column, confirmed by the script's own verification query;
- all **4 rows** came back populated, all `'MEMBER'`, in the one `ALTER TABLE`
  statement (constant default, no table rewrite);
- the `v0.13.2` client then read, filtered **and wrote** normally again;
- the filter returned **0 rows**, which is the documented cost measured rather than
  predicted: with every row back as `'MEMBER'` nobody holds `ADMIN`, so the
  one-step partner declaration finds no candidates and fails **closed**. Nothing
  else about family groups changed.

**The optional exact-value restore was exercised too**, since it is the only way
back to the real labels and a commented block nobody has run is not evidence. The
step-3 block in `rollback.sql`, run as a `psql -f` script (the `\copy`
meta-command needs a script file, not `-c`), loaded the pre-migration dump and
reported `UPDATE 2` — the two rows that differed — leaving
`fgm-admin=ADMIN, fgm-lead=LEAD, fgm-plain=MEMBER, fgm-default=MEMBER`, exactly the
pre-migration state.

**The gates were exercised in all three directions**, not just the passing one:

| `scripts/validate-blue-green-migrations.sh` on this migration | Result |
| --- | --- |
| no override | **refuses**, exit 1 — names the `DROP COLUMN` and the `windowed` ledger declaration |
| `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` + `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` | passes, exit 0, echoing the reason |
| override present but `rollback.sql` deleted | **refuses**, exit 1 — a documentation failure the override cannot rescue |

| Field | Value |
| --- | --- |
| Rehearsal environment | Throwaway PostgreSQL 16.14, full migration history, rows covering all three labels + one database-default row |
| Migration | `20260803030000_contract_drop_family_group_member_role` |
| Rehearsal date | 2026-08-03 |
| Result | **PASS** — migrate and `rollback.sql` both ways, plus the optional exact-value restore; no drift; all three validator directions as expected |
| Notable findings | One, in the documentation rather than the migration. Earlier drafts said naming the column is "a compile error" on the replacement client. Measured, only the `WHERE` shape is; `select` and `create`-data compile and are rejected by the client before any SQL. The conclusion (no SQL can name the column) is unchanged, and the schema comment, migration header, domain invariant and guard test were corrected to say the measured thing. |
| Rehearsed by | Lane implementation session (pre-merge, on the #2520 contract PR) |

> This rehearsal used seeded rows, not a production snapshot. Before the production
> window, re-run migrate and `rollback.sql` against a **restored copy of the
> production backup**. The real distribution of `role` values is the one thing a
> seed cannot supply — and it is exactly what step 8(b) records, since after the
> drop it cannot be recovered from the database at all.

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
| Cutover time (step 16) | _<HH:MM TZ>_ |
| Modules re-enabled | _<list>_ |
| Access-role audit run / result | _<n/a or PASS>_ |
| Money + Xero spot-check | _<clean / notes>_ |
| Critical journeys (login+2FA / book / pay / approve) | _<pass/fail each>_ |
| Post-checklist sign-off (owner) | _<name + time>_ |
