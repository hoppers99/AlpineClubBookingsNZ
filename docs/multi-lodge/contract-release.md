# Multi-Lodge Contract Release Runbook

The multi-lodge schema shipped as an **expand** release: `lodgeId` columns
were added nullable, backfilled to the sole seeded lodge, and every runtime
writer now stamps a lodge. The **contract** release is the follow-up that
tightens those columns to `NOT NULL`, adds the null-partition partial unique
indexes for the policy tables, and drops the superseded `EmailMessageSetting`
lodge-identity columns.

This runbook exists because the obligations are otherwise scattered across
ADR-001, ADR-003, the implementation plan, the scoping contract, and inline
schema/code comments. It is the single derived checklist for whoever writes
that migration. **Nothing here is invented** — every item traces to a nullable
column, a comment, or a documented deferral in the current schema/docs. If the
schema has changed since this was written, re-derive against
`prisma/schema.prisma` and `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.

Read `docs/BLUE_GREEN_MIGRATION_POLICY.md` and ADR-001's "Migration
sequencing" first. This is **Critical/High-risk, owner-approval-required**
work on booking-critical tables (per `CLAUDE.md`/`AGENTS.md` risk gate).

## Preconditions (all must hold before running)

1. **The expand release is fully deployed and cut over.** All of the
   `20260702*`/`20260703*` lodge expand migrations in the ledger are applied in
   production and the *new* application code — the one that stamps `lodgeId` on
   every write via `getDefaultLodgeId` — is the only code serving traffic.
2. **The old colour is fully drained.** No blue/green slot running pre-lodge
   code may still be accepting writes. A draining old colour can still insert
   `NULL`-`lodgeId` rows (rooms, lockers, seasons, bookings, chore templates,
   hut-leader assignments); `NOT NULL` will fail loudly against any such row,
   and the overlap/uniqueness code paths currently treat null-lodge rows as
   conflicting at every lodge precisely to stay safe during the drain. Confirm
   the old slot is stopped, not merely idle.
3. **Backfill is verified complete.** Run the verification queries below and
   confirm every count is `0` before adding any `NOT NULL` constraint. These
   are the assertions the production review (§2) flags as owed *before* this
   migration ships — write them as tests against a shadow database too.

### Backfill verification queries

Run against the production (or a production-clone shadow) database. Every
result must be `0`.

```sql
-- Entity tables that become NOT NULL. Any NULL here blocks the migration.
SELECT count(*) FROM "LodgeRoom"            WHERE "lodgeId" IS NULL;
SELECT count(*) FROM "Locker"               WHERE "lodgeId" IS NULL;
SELECT count(*) FROM "Season"               WHERE "lodgeId" IS NULL;
SELECT count(*) FROM "Booking"              WHERE "lodgeId" IS NULL;
SELECT count(*) FROM "ChoreTemplate"        WHERE "lodgeId" IS NULL;
SELECT count(*) FROM "HutLeaderAssignment"  WHERE "lodgeId" IS NULL;

-- Every stamped lodgeId points at a real lodge (FK integrity sanity check).
SELECT count(*) FROM "Booking" b
  LEFT JOIN "Lodge" l ON l.id = b."lodgeId"
  WHERE b."lodgeId" IS NOT NULL AND l.id IS NULL;

-- Policy tables: these stay nullable (null = club-wide default). Confirm the
-- club-wide partition has no accidental duplicates before adding the partial
-- unique index — each of these must be 0.
SELECT "daysBeforeStay", count(*) FROM "CancellationPolicy"
  WHERE "lodgeId" IS NULL GROUP BY "daysBeforeStay" HAVING count(*) > 1;
-- (repeat the equivalent club-wide-partition duplicate check for the
--  MinimumStayPolicy and BookingPeriod key columns before their partial
--  indexes are added.)
```

## Items (the full derived list)

### 1. `NOT NULL` on the five entity tables + `HutLeaderAssignment`

These carry a `lodgeId` that is *conceptually required* but was left nullable
for the expand release. Enforce `NOT NULL` after the backfill checks pass:

| Table | Field | Current | Target |
| --- | --- | --- | --- |
| `LodgeRoom` | `lodgeId` | `String?` | `String` (NOT NULL) |
| `Locker` | `lodgeId` | `String?` | `String` (NOT NULL) |
| `Season` | `lodgeId` | `String?` | `String` (NOT NULL) |
| `Booking` | `lodgeId` | `String?` | `String` (NOT NULL) |
| `ChoreTemplate` | `lodgeId` | `String?` | `String` (NOT NULL) |
| `HutLeaderAssignment` | `lodgeId` | `String?` | `String` (NOT NULL) |

`HutLeaderAssignment` is included per the production review: hut-leader PINs
currently match legacy null-lodge assignments as a compatibility path
(implementation-plan phase 4); once `NOT NULL` lands, that legacy branch is
dead and can be removed. `Booking.waitlistOfferedLodgeId` stays nullable — it
is the ADR-004 offer marker, not the entity scope.

### 2. Null-partition partial unique indexes for the policy tables

`CancellationPolicy`, `MinimumStayPolicy`, and `BookingPeriod` keep a
*permanently nullable* `lodgeId` (null = club-wide default; ADR-001 Q3). The
expand release re-scoped their uniqueness to `[lodgeId, …]`, but because
PostgreSQL treats NULLs as distinct, the database no longer hard-enforces
club-wide uniqueness on the null partition — the admin routes enforce it in a
Serializable replace transaction in the meantime (see the
`20260702210000_rescope_cancellation_tier_uniqueness` ledger note).

Add a **partial unique index `WHERE "lodgeId" IS NULL`** on each policy table's
key so the club-wide partition regains today's DB-level guarantee:

- `CancellationPolicy` — partial unique on `(daysBeforeStay) WHERE "lodgeId" IS NULL`
- `MinimumStayPolicy` — partial unique on its key column(s) `WHERE "lodgeId" IS NULL`
- `BookingPeriod` — partial unique on its key column(s) `WHERE "lodgeId" IS NULL`

Confirm the exact key columns against `prisma/schema.prisma` at migration time
(Prisma expresses partial indexes as raw SQL in the migration; the schema-level
`@@unique` cannot express the `WHERE` clause). `LodgeInstruction` follows the
same pattern per document key — its null-partition partial unique index on
`(key) WHERE "lodgeId" IS NULL` belongs in this release too (see the
`20260703153000_rescope_lodge_instructions` ledger note).

### 3. Rooms/lockers `NOT NULL` completion of the pulled-forward re-scoping

The `[lodgeId, name]` uniqueness re-scoping for `LodgeRoom` and `Locker` was
**pulled forward** into the expand release
(`20260703200000_rescope_room_locker_name_uniqueness`) after two-lodge testing
hit "Room 1 already exists". That migration only swapped the index; it did not
make `lodgeId` NOT NULL. Item 1 above completes it. Once `lodgeId` is NOT NULL,
add the null-partition handling is moot for these two (no nulls remain), and
the app-side "null rows clash at every lodge" pre-checks in the bulk-seed
routes (`admin/bed-allocation/rooms/bulk`, `admin/lockers/bulk`) can be
simplified to a straight per-lodge check.

### 4. `EmailMessageSetting` lodge-identity column drop

The lodge-identity fields were moved onto `Lodge` (the `Lodge` model now owns
`doorCode` and `travelNote`; identity is synced by `syncSoleActiveLodgeIdentity`).
The legacy columns still exist on `EmailMessageSetting` and are superseded:

- `EmailMessageSetting.lodgeName`
- `EmailMessageSetting.lodgeTravelNote`
- `EmailMessageSetting.doorCode`

Drop these in the contract release. A column drop is only blue/green-safe once
no running code reads them — confirm no writer/reader remains before dropping
(implementation-plan phase 1/2 records this as deferred to the contract
release precisely because a drop is destructive).

### 5. Possible `LodgeSettings` legacy-row consolidation (optional)

`LodgeSettings` / `BedAllocationSettings` became per-lodge rows keyed by lodge
id, but the legacy `"default"` row is kept and claimed on first per-lodge write
(scoping contract, "Resolved 2026-07-03"). The contract release *may*
consolidate the legacy rows and then add a real `[lodgeId]` uniqueness once no
unlinked legacy row remains. This is optional and lower-risk than items 1–4;
only do it if the legacy-row resolution logic is being retired. `hutLeaderLookaheadDays`
stays a club-wide knob on the legacy row regardless.

## Sequencing

Ship as one or more contract migrations, in this order, after the preconditions
hold:

1. **Verify backfill** (queries above) — abort if any count is non-zero;
   re-run the expand-era backfill for the offending table first.
2. **Add the policy-table + `LodgeInstruction` null-partition partial unique
   indexes** (item 2). These are additive and safe on the existing null rows,
   which already satisfy uniqueness.
3. **Enforce `NOT NULL`** on the six entity/assignment tables (items 1 and 3).
   `Booking` is the hot table — take the brief `ACCESS EXCLUSIVE` lock during
   low booking traffic; the column is already fully populated so there is no
   table rewrite, only a validation scan (or use the
   `ADD CONSTRAINT … NOT VALID` → `VALIDATE CONSTRAINT` split if the scan lock
   window is a concern).
4. **Drop the superseded `EmailMessageSetting` columns** (item 4) — destructive,
   so last, and only once no code reads them.
5. **(Optional) consolidate `LodgeSettings` legacy rows** (item 5).
6. Remove the now-dead null-lodge compatibility branches in code (overlap
   queries counting null rows against every lodge; the hut-leader legacy
   null-assignment match; the bulk-seed null-clash pre-checks) — code change,
   can follow the migration once it is confirmed applied.

## Migration-ledger entries this release will need

Add one row per migration to `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`. All the
lodge expand rows use `phase = expand`; these are the first lodge rows with
`phase = contract`, so each destructive/NOT-NULL migration **must** name its
`previous_expand_release` (the ledger requires it for contract migrations) and
carry a lock-impact plan. Templates (fill the exact migration name and the
expand release it depends on):

```
<name>_multi_lodge_policy_partial_unique_indexes	contract	20260702210000_rescope_cancellation_tier_uniqueness	yes	Adds WHERE "lodgeId" IS NULL partial unique indexes on CancellationPolicy, MinimumStayPolicy, BookingPeriod, and LodgeInstruction so the club-wide (null) partition regains DB-level uniqueness the nulls-distinct expand swap gave up. Existing null rows already satisfy uniqueness (app-enforced since the expand release), so index creation validates cleanly. Additive; brief lock on small admin-written tables.
<name>_multi_lodge_entity_lodge_id_not_null	contract	20260702120000_add_lodge_id_scoping_expand	yes	Enforces NOT NULL on lodgeId for LodgeRoom, Locker, Season, Booking, ChoreTemplate, and HutLeaderAssignment after backfill verification. Requires the old (pre-lodge) colour fully drained: a draining old colour could still insert null-lodge rows and fail the constraint. Booking is hot — the column is fully populated so no rewrite; take the ACCESS EXCLUSIVE validation lock during low booking traffic, or split into ADD CONSTRAINT NOT VALID then VALIDATE CONSTRAINT to shorten the blocking window.
<name>_drop_email_message_setting_lodge_columns	contract	20260702100000_add_lodge_entity_and_multi_lodge_module	yes	Drops the superseded EmailMessageSetting.lodgeName/lodgeTravelNote/doorCode columns now that lodge identity lives on Lodge (synced by syncSoleActiveLodgeIdentity). Destructive: run only once no serving code reads these columns. Small single-row table; brief metadata lock.
```

Verify each row's `old_code_compatible` honestly (the NOT NULL and column-drop
migrations are only compatible once the old colour is gone — that is why the
drained-precondition is mandatory, not advisory), and run
`npm run db:check-drift` against a shadow database for every migration PR.
