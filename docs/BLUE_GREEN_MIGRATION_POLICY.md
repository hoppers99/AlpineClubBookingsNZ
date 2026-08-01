# Blue/Green Migration Policy

Production deploys run Prisma migrations before the new web color receives traffic while the old color can still be serving requests against the shared Postgres database. Every committed migration must therefore preserve old-code/new-schema compatibility until the previous color has drained.

## Required Sequence

- Expand release: add nullable columns, new tables, new indexes, dual-write/backfill support, or compatibility views without removing the old shape used by the currently live app.
- Runtime release: move all reads and writes to the new shape while still tolerating the old one.
- Contract release: remove old columns, tables, indexes, enum values, token fields, or compatibility code only after the previous deployed runtime no longer depends on them.

Destructive contract migrations must name the previous expand/runtime release in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` and must declare `old_code_compatible=yes`. If that cannot be true, the migration is not valid for normal blue/green deploy and needs a separate maintenance/bootstrap plan.

## Deploy Gate

`scripts/run-production-blue-green-deploy.sh --internal-blue-green-deploy` calls `scripts/validate-blue-green-migrations.sh` before `prisma migrate deploy`. The validator checks pending migration SQL for:

- destructive schema removals, renames, type changes, `SET NOT NULL`, and constraint drops
- operations touching hot tables: `Member`, `Booking`, `Payment`, membership tables, finance token tables, and auth/action-token tables — including index, constraint, and trigger creation/removal (`CREATE`/`DROP TRIGGER`, `CREATE CONSTRAINT TRIGGER`) against those tables
- matching entries in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`

Hot-table migrations require a lock-impact plan in the ledger. Potentially breaking migrations also require `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` and a non-empty `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` at deploy time, after the ledger documents why the active old color remains compatible.

## Session-clock DML gate

The validator separately blocks `CURRENT_TIMESTAMP` / `now()` written into an `INSERT` or `UPDATE` payload (issues #1656 / #1627). Session (database-local) time landing in a naive timestamp column renders local wall-clock on a non-UTC database and skews `createdAt` ordering — the defect that once let a same-day app-created lodge silently become the club default. DML must write an explicit UTC value instead, e.g. `timezone('UTC', statement_timestamp())` or a literal `'2026-01-01T00:00:00Z'`. A column `DEFAULT CURRENT_TIMESTAMP` is DDL, not a payload, and is fine. Statements are reconstructed dollar-quote-aware (arbitrary `$tag$…$tag$` bodies, so semicolons inside a quoted HTML payload do not fragment the statement); an unterminated dollar-quote fails the gate rather than passing unchecked. This gate is a **hard, non-overridable block**: `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` does not waive it, and it is enforced at both deploy time and PR time (the coverage gate runs the validator with the breaking override set, so the session-clock block still fires). Migrations whose timestamp prefix sorts before the gate's baseline predate it and are exempt so committed history never retro-fails.

The rare reviewed exception is a name-keyed allowlist, `SESSION_CLOCK_DML_ACKNOWLEDGED` in `scripts/validate-blue-green-migrations.sh`, documented in the same spirit as the grandfathered timestamp prefixes: each entry is an exact migration folder name with a comment justifying why the session clock is harmless there — only for a cosmetic write on a cold table with no `createdAt`-ordering invariant to skew (e.g. `20260717180000_genericise_starter_lodge_copy`, which refreshes `updatedAt` on the cold `PageContent` table). The waiver is scoped to the session-clock gate only, never the destructive/hot-table checks, and prefer fixing the migration SQL to write explicit UTC over adding an entry.

## PR-time coverage gate

The deploy gate only inspects migrations still pending against the target database, so a regex-matching migration committed without a ledger entry stays invisible until a deploy aborts before cutover (that is exactly how a fork upgrading from `v0.9.0` was hard-blocked — see issue #1359). CI's `migration-drift` job therefore runs `scripts/check-migration-safety-coverage.sh` on every pull request. It is read-only and needs no database, and it fails the build when:

- a committed migration at or after the ledger baseline (the earliest migration named in the ledger) matches the hot-table/breaking regexes but has no well-formed `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` entry, or
- a new migration reuses an existing timestamp prefix. Prisma orders migrations by folder name, so a duplicate prefix sorts ambiguously. The historical duplicate prefixes that predate this gate are grandfathered in the script; any new collision fails CI. Always stamp a new migration with a timestamp later than every committed migration.

Add the ledger row (and, for destructive changes, follow the expand/contract sequence above) in the same pull request that adds the migration.

## Data-migration verification

Some migrations do not only change the *shape* of the database — they rewrite data a club has typed in. `Migration drift check` applies every migration to a real PostgreSQL, but the tables are **empty**, so a backfill, repair, or value transform matches no rows: the statement is proven to parse and proven to do nothing. Tests that string-match the SQL, or re-run its patterns in JavaScript, prove the patterns are what the author intended; JavaScript and PostgreSQL regular expressions differ on greediness, on newlines inside character classes, and on backslashes inside brackets, so they cannot prove PostgreSQL executes them the same way. Every defect the three review rounds found in #2269's migration was semantic, and none was reachable from empty tables (issue #2418).

**The rule: a data-rewriting migration ships a verification fixture in the same pull request.** `scripts/check-data-migration-verification.sh` enforces it, and runs both in `migration-drift` (a required check) and in the `Data migration verification` job that executes the fixtures. It is read-only and needs no database.

A migration counts as **data-rewriting** when any top-level statement:

- begins with `UPDATE`, `DELETE`, `TRUNCATE` or `MERGE` — these can only reach rows that already exist;
- begins with `INSERT` and derives values from existing rows (a `SELECT` anywhere in the statement) or resolves a conflict with `DO UPDATE`;
- begins with `WITH` and contains an `UPDATE`/`DELETE`/`INSERT`/`MERGE` (a data-modifying CTE);
- is an `ALTER TABLE ... ALTER COLUMN ... TYPE ... USING ...`, whose `USING` expression transforms every existing value; or
- is a `DO` block containing any of the above (a PL/pgSQL body is opaque to a line-oriented gate, so it is classified conservatively).

A plain `INSERT ... VALUES` is deliberately **not** data-rewriting: it adds rows and cannot alter anything a club has typed. Neither is a `CREATE FUNCTION` body containing an `UPDATE` — that defines future runtime behaviour (a trigger), which the trigger suites cover instead. Statements are reconstructed with the same dollar-quote-aware splitter the deploy gate uses (`scripts/lib/split-sql-statements.awk`), so both gates grade the same program.

### Writing a fixture

Add `prisma/migration-verification/<migration_name>.ts`, named exactly after the migration directory, and register it in that directory's `index.ts` (an unregistered fixture never runs, so the gate fails on one). A fixture declares, in data:

- `intent` — plain English: what the migration must do, and to whom.
- `cases` — each a pre-state (`seed` SQL) and the `expectations` that must hold afterwards, as named queries and the exact rows they must return. **The runner replays every earlier migration first**, so a case seeds rows on the real schema rather than inventing tables — and the strongest case seeds nothing at all, because the pre-state is then literally what a real install holds. Select timestamps through `to_char(...)`: a raw naive timestamp is resolved against the *client's* zone and would pass in UTC CI while failing on a Pacific/Auckland machine.
- `mutants` — deliberate breakages of the migration (an inverted `WHERE`, a dropped predicate, a row-scoped rewrite where the real one is value-scoped), each with the real-world harm it would cause. The runner applies each mutant and **requires at least one case to fail**; a mutant that goes undetected fails the build. It also runs one mutant nobody declares: not applying the migration at all. Without this, a post-state assertion that would pass either way — coverage that does not exist — sits green forever.
- `idempotentReRun` — true when running the whole migration twice must change nothing (a pure value-scoped repair). The runner then proves it.

`prisma/migration-verification/20260802110000_clear_waldvogel_lodge_address.ts` and `20260802140000_clear_starter_footer_affiliations.ts` are the reference implementations.

Run it locally against any throwaway database (the suite creates and drops its own, so the user needs `CREATEDB`):

```bash
DATA_MIGRATION_VERIFICATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  npx vitest run src/lib/__tests__/data-migration-verification.realdb.test.ts
```

Without that variable the real-database checks do not run, but the suite still fails if CI stops running them — and it fails outright inside its own CI job when the variable is missing, so the coverage can never quietly disappear.

**Limitation.** The migration under test is applied inside a transaction so each case can be rolled back, which means a migration that adds an enum value *and uses it* cannot be verified this way (PostgreSQL refuses `ALTER TYPE ... ADD VALUE` followed by use in one transaction block). Split such a change into two migrations, which the expand/contract sequence above wants anyway.

### The grandfather list

`scripts/data-migration-verification-grandfathered.txt` names the 85 data-rewriting migrations that shipped before this gate existed (recorded 2 August 2026). The count is pinned in the script, so the list cannot grow unnoticed. Removing a name is how a historical migration gets retro-fitted: write the fixture, delete the line, drop the pinned count. **Adding** a name means "this data-rewriting migration ships unverified" and needs the same justification a security waiver would, stated in the PR body. A migration cannot be both grandfathered and verified — the gate fails on that, so the list can never decay into decoration.

## Historical Migrations

The April 2026 migration history contains single-step destructive changes that predate this policy. Those files are not edited retroactively because Prisma records migration checksums after deployment. If any environment still has one of those migrations pending, do not run it through the normal blue/green path; treat it as a bootstrap or maintenance migration with an explicit operator plan.
