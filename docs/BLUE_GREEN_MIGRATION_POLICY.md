# Blue/Green Migration Policy

Production deploys run Prisma migrations before the new web color receives traffic while the old color can still be serving requests against the shared Postgres database. Every committed migration must therefore preserve old-code/new-schema compatibility until the previous color has drained.

## Required Sequence

- Expand release: add nullable columns, new tables, new indexes, dual-write/backfill support, or compatibility views without removing the old shape used by the currently live app.
- Runtime release: move all reads and writes to the new shape while still tolerating the old one.
- Contract release: remove old columns, tables, indexes, enum values, token fields, or compatibility code only after the previous deployed runtime no longer depends on them.

Destructive contract migrations must name the previous expand/runtime release in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` and must declare `old_code_compatible=yes` — meaning *genuinely* compatible, because the migration carries a compensating pattern (for example a `SET NOT NULL` paired with a same-column non-NULL `SET DEFAULT`, so an old color's omitted-column `INSERT` still succeeds).

If that cannot be true, the migration is not valid for a normal blue/green deploy and needs a separate maintenance/bootstrap plan. **Declare that plan in the ledger as `old_code_compatible=windowed`** — do not assert `yes` and leave the caveat to prose.

### `old_code_compatible`: the three values

The ledger's fourth column is a closed vocabulary, and the validator rejects anything else outright. It checks **every row in the file**, not only the rows of the migrations pending for a deploy: most ledgered migrations match none of the SQL patterns below, so before #2288 their fourth column was read by nothing and a near-miss spelling — `Windowed`, `WINDOWED`, `maybe`, blank — silently disarmed the declaration while the gate reported "safety check passed". The same pass rejects a **duplicate** row for one migration, because only the first row is ever read and a silently shadowed row is most likely to be the `windowed` one two lanes raced to write.

| Value | Meaning |
| --- | --- |
| `yes` | Genuinely old-code compatible. The previous color keeps working throughout migrate → cutover, because the migration is additive or carries a compensating pattern. |
| `windowed` | **Not** compatible. The previous color *will* error between migrate and cutover. Requires a maintenance window **and** the `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` override at deploy time. |
| `no` | The migration has no breaking SQL matched by the deploy guard, so there is nothing to acknowledge. Read the row's `lock_impact_plan` anyway — see the historical note below. |

A migration matching the guard's breaking patterns must be `yes` or `windowed`; `no` fails. `windowed` additionally requires the incompatibility **and** the window plan to be written into `lock_impact_plan`, so it cannot become a quieter way to say `yes`. A `windowed` row also forces the override even when no SQL pattern matched — a data-only migration (an `UPDATE` flipping rows to a value the previous color's client cannot deserialize, say) breaks the old color with no breaking DDL at all, and the ledger row is the only place that knows.

### A `windowed` migration moves the rollback boundary

For an ordinary migration the rollback boundary is the **cutover**: everything up to it is reversible by aborting, because the already-migrated schema still serves the old color (`docs/PRODUCTION_UPGRADE_RUNBOOK.md` [§4](PRODUCTION_UPGRADE_RUNBOOK.md#4-rollback-plan)).

For a `windowed` migration the boundary moves back to the **migrate step**. Once migrate commits, the previous color is already broken, so aborting the deploy no longer restores service — going back means going *forward* to cutover, or restoring from backup. Therefore:

- Take and verify a fresh database backup immediately before migrating, not merely before the deploy.
- Write a reverse script and keep it **beside the migration**, as `prisma/migrations/<migration>/rollback.sql`, so the schema change can be undone without a restore. **The validator enforces this**: a `windowed` row whose migration folder has no `rollback.sql` fails the gate as a documentation failure, at PR time and at deploy time, and the `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` override does not rescue it. If the change genuinely cannot be reversed, commit a `rollback.sql` that says so and names the recovery path — an operator finding an empty folder mid-window is the failure this check exists to prevent. The file's *contents* are still inert: Prisma and every other gate address a migration folder by its `migration.sql` alone, so `rollback.sql` is never applied, never checksummed, and only ever run by an operator on purpose.
- Keep the migrate → cutover gap as short as the plan allows, and say in `lock_impact_plan` what the old color will do during it.

Historical note: before `windowed` existed the gate hard-required `yes`, so every breaking migration declared it whether or not it was true and the field carried no information for exactly the migrations that most needed scrutiny. Two classes of row predate the value and are more accurately `windowed`.

This note deliberately gives you the **class rule, not a list**. An enumeration here goes stale the moment somebody adds a row: an earlier draft of this note named four migrations when the ledger already held at least nine of them, including the enum rename #2288 was built around — and the artefact written to stop an auditor misreading the record was itself the misleading one. Read the classes off the ledger:

- **`yes` in the operator-acknowledgement sense.** A `contract`-phase row whose `lock_impact_plan` tells the operator to keep old-colour traffic idle, drained, or routed to the new runtime, or names a surface that errors "until cutover". Most say so in the text — `OLD-CODE CAVEAT`, `RESIDUAL WINDOW`, or "`old_code_compatible=yes` is asserted in the promo-redesign sense". `20260526120000_promo_code_per_individual_redesign` is the canonical row the later ones cite; `20260525010000_align_booking_change_request_with_review_queues` (the enum rename this rule came from), `20260708220200`, `20260708220300`, `20260709130000`, `20260714140000`, `20260717170000` and `20260719170000` are all in the class today.
- **`no` used to flag a genuinely incompatible **data** migration** that tripped none of the breaking patterns — `20260528120000_add_booking_admin_review_workflow` ("old code … is not treated as fully enum-compatible with backfilled `AWAITING_REVIEW` rows") and `20260707000100_backfill_org_age_tier_not_applicable` (pre-#1440 clients cannot deserialize `NOT_APPLICABLE`).

A mechanical starting point — it **over-collects, so read each row rather than trusting the filter**:

```bash
awk -F'\t' '$4 != "windowed" && $5 ~ /OLD-CODE CAVEAT|RESIDUAL WINDOW|CAUTION|until cutover|drained|idle or routed/' \
  docs/BLUE_GREEN_MIGRATION_SAFETY.tsv
```

It over-collects because a caveat can be about the **new** colour rather than the draining one: `20260716140000_xero_member_grouping` and `20260729180000_add_payment_manual_mark_paid` both carry an `OLD-CODE CAVEAT` heading and are genuinely `yes` for the old colour.

Every one of these rows is deliberately left as it was declared rather than rewritten: rewriting would falsify the record of what was declared at the time, and each row's `lock_impact_plan` already carries the real caveat. New rows use `windowed` for both cases.

## Deploy Gate

`scripts/run-production-blue-green-deploy.sh --internal-blue-green-deploy` calls `scripts/validate-blue-green-migrations.sh` before `prisma migrate deploy`. The validator checks pending migration SQL for:

- destructive schema removals, renames, type changes, `SET NOT NULL`, and constraint drops
- **enum-value renames** — `ALTER TYPE … RENAME VALUE` (#2288). Renaming a value inside a Postgres enum is genuinely breaking: the draining old color keeps sending the old label and Postgres answers `invalid input value for enum`. It is caught by **two** patterns, exactly as `RENAME COLUMN` is: the bare phrase `RENAME VALUE`, plus `ALTER TYPE … RENAME` as the backstop for a statement wrapped between the two words. The backstop also closes a standalone **type** rename, `ALTER TYPE "X" RENAME TO "Y"`, which no pattern matched before. `ALTER TYPE … ADD VALUE` is additive and deliberately **not** matched, and neither is `ALTER INDEX … RENAME TO` — no application code references an index by name, so matching it would generate false positives forever and train operators to reach for the override.
- An enum-value rename is treated as **breaking but not as a destructive removal**, so it needs `old_code_compatible=yes`/`windowed` plus the override, not `phase=contract` with a named `previous_expand_release`. That is a deliberate carve-out from the contract-release definition above, which lists enum values among the shapes a contract release removes: renaming a label is not the same act as dropping one, and in practice an enum rename that matters travels with the column renames or drops that already put the migration in the destructive-removal set (`20260525010000` is exactly that). Recorded here so the call is not re-litigated per pull request.
- operations touching hot tables: `Member`, `Booking`, `Payment`, membership tables, finance token tables, and auth/action-token tables — including index, constraint, and trigger creation/removal (`CREATE`/`DROP TRIGGER`, `CREATE CONSTRAINT TRIGGER`) against those tables
- matching entries in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`

Hot-table migrations require a lock-impact plan in the ledger. Potentially breaking migrations also require `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` and a non-empty `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` at deploy time, after the ledger records either why the active old color remains compatible (`old_code_compatible=yes`) or what the maintenance window is (`old_code_compatible=windowed`).

The breaking/hot-table scan is line-oriented, not a SQL parser: it reads every non-comment line of the pending `migration.sql`, case-insensitively, including lines inside a `DO $$ … $$` block. No single pattern can see a keyword *phrase* split across lines — `RENAME` at the end of one line and `VALUE` at the start of the next reads as neither. The two rename constructs therefore carry a **partner pattern** that matches the first line on its own: `ALTER TABLE … RENAME` behind `RENAME COLUMN`, and `ALTER TYPE … RENAME` behind `RENAME VALUE`. Both wraps are caught. Splitting *between* clauses is fine and is caught on the second line — `ALTER TYPE "X"` on one line and `RENAME VALUE 'a' TO 'b';` on the next.

The patterns without a partner (`DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN … TYPE` and the rest) do still lose a mid-phrase wrap. No migration in this repo is written that way; keep it so.

## Session-clock DML gate

The validator separately blocks `CURRENT_TIMESTAMP` / `now()` written into an `INSERT` or `UPDATE` payload (issues #1656 / #1627). Session (database-local) time landing in a naive timestamp column renders local wall-clock on a non-UTC database and skews `createdAt` ordering — the defect that once let a same-day app-created lodge silently become the club default. DML must write an explicit UTC value instead, e.g. `timezone('UTC', statement_timestamp())` or a literal `'2026-01-01T00:00:00Z'`. A column `DEFAULT CURRENT_TIMESTAMP` is DDL, not a payload, and is fine. Statements are reconstructed dollar-quote-aware (arbitrary `$tag$…$tag$` bodies, so semicolons inside a quoted HTML payload do not fragment the statement); an unterminated dollar-quote fails the gate rather than passing unchecked. This gate is a **hard, non-overridable block**: `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` does not waive it, and it is enforced at both deploy time and PR time (the coverage gate runs the validator with the breaking override set, so the session-clock block still fires). Migrations whose timestamp prefix sorts before the gate's baseline predate it and are exempt so committed history never retro-fails.

The rare reviewed exception is a name-keyed allowlist, `SESSION_CLOCK_DML_ACKNOWLEDGED` in `scripts/validate-blue-green-migrations.sh`, documented in the same spirit as the grandfathered timestamp prefixes: each entry is an exact migration folder name with a comment justifying why the session clock is harmless there — only for a cosmetic write on a cold table with no `createdAt`-ordering invariant to skew (e.g. `20260717180000_genericise_starter_lodge_copy`, which refreshes `updatedAt` on the cold `PageContent` table). The waiver is scoped to the session-clock gate only, never the destructive/hot-table checks, and prefer fixing the migration SQL to write explicit UTC over adding an entry.

## PR-time coverage gate

The deploy gate only inspects migrations still pending against the target database, so a regex-matching migration committed without a ledger entry stays invisible until a deploy aborts before cutover (that is exactly how a fork upgrading from `v0.9.0` was hard-blocked — see issue #1359). CI's `migration-drift` job therefore runs `scripts/check-migration-safety-coverage.sh` on every pull request. It is read-only and needs no database, and it fails the build when:

- any row in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` declares an `old_code_compatible` outside `yes`/`no`/`windowed`, names no migration, or repeats a migration already named on an earlier row. This runs over the whole ledger and does not depend on which migrations are in scope below, so a mistyped `windowed` fails the pull request rather than the deploy,
- a committed migration at or after the ledger baseline (the earliest migration named in the ledger) matches the hot-table/breaking regexes but has no well-formed `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` entry — or is declared `windowed` and ships no `rollback.sql` beside its `migration.sql`, or
- a new migration reuses an existing timestamp prefix. Prisma orders migrations by folder name, so a duplicate prefix sorts ambiguously. The historical duplicate prefixes that predate this gate are grandfathered in the script; any new collision fails CI. Always stamp a new migration with a timestamp later than every committed migration.

Add the ledger row (and, for destructive changes, follow the expand/contract sequence above) in the same pull request that adds the migration.

## Historical Migrations

The April 2026 migration history contains single-step destructive changes that predate this policy. Those files are not edited retroactively because Prisma records migration checksums after deployment. If any environment still has one of those migrations pending, do not run it through the normal blue/green path; treat it as a bootstrap or maintenance migration with an explicit operator plan.
