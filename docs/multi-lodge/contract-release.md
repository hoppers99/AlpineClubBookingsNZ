# Multi-Lodge Schema Posture — Expand-Only (why there is no contract release)

**Decision (owner, 2026-07-05): the multi-lodge schema stays permanently in its
expand shape. `lodgeId` remains `NULL`-able on every scoped table, and the
superseded legacy columns are retained. There is no follow-up "contract"
release that enforces `NOT NULL` or drops columns.** Integrity is held at the
application layer instead (below). This document explains *why*, how the deploy
works, what outage a contract migration *would* cause, and — for the record —
what a contract release would contain if the deployment model ever changed.

## Why expand-only (and not "expand now, contract later")

The classic expand/contract pattern assumes a **sequenced** rollout: ship the
expand release, let every deployment run it and drain its old code, *then* ship
the contract release that tightens the schema. Two facts about this project
break that assumption:

1. **Deploys are blue/green (zero-downtime).** `prisma migrate deploy` runs from
   the `migrate` container **while the old app colour is still serving**
   (deploy step 13/19), and the old colour keeps taking writes until Caddy cuts
   over (step 16) and the old container is removed (step 17). So there is always
   a window where the *old* code runs against the *newly-migrated* schema. That
   is exactly what expand migrations are designed to survive — and what
   `SET NOT NULL` / `DROP COLUMN` are not (`docs/BLUE_GREEN_MIGRATION_POLICY.md`
   classifies them as breaking).
2. **Clubs target `latest` and skip intermediate versions.** A self-hosted club
   that hasn't updated in months (or years) jumps straight from a pre-lodge
   version to whatever `latest` is. `prisma migrate deploy` then applies the
   expand *and* any later contract migrations in **one** run — with the club's
   **pre-lodge** code as the old colour. That old colour does not stamp
   `lodgeId`, so the instant a contract `NOT NULL` migration is applied it starts
   rejecting the old colour's inserts.

Put together: we can never guarantee the old colour serving during a cutover is
lodge-aware, so a contract migration would break real deployments. Sequencing
(option A) doesn't save us because target-latest bypasses the intermediate
release the sequencing relies on.

## What outage a contract migration would cause

Concretely, during the step 13→17 window of a deploy that includes a breaking
lodge migration, with pre-lodge code as the old colour:

- **`SET NOT NULL` on `Booking.lodgeId` (etc.):** every booking/room/season/etc.
  write the old colour attempts (a member booking, an admin creating a room)
  fails with a `NOT NULL` violation → 500s on those paths until cutover
  completes. A partial outage of the write paths for the ~seconds-to-minutes the
  old colour is still live, and any in-flight transaction on those tables aborts.
- **`DROP COLUMN` on `EmailMessageSetting.*`:** the old colour still reads those
  columns → errors on the surfaces that render lodge identity until cutover.

The migrate step itself would also fail loudly if a pre-lodge colour had already
inserted a `NULL`-`lodgeId` row between the backfill and the `NOT NULL` within
the same run. The blue/green policy therefore treats these as breaking and
requires `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` + a maintenance window — which
defeats the zero-downtime model we rely on.

## How integrity is maintained without `NOT NULL`

`lodgeId` is nullable *by constraint* but effectively never null *in practice*:

- **Backfill on expand.** `20260702120000_add_lodge_id_scoping_expand` backfills
  every existing row to the sole seeded lodge, so no legacy nulls survive the
  upgrade.
- **Every writer stamps a lodge.** All create/modify paths resolve and write
  `lodgeId` (`getDefaultLodgeId` when a caller doesn't specify one). New rows are
  never null in normal operation.
- **Null-tolerant reads.** `lodgeNullTolerantScope(lodgeId)` and the
  `lodgeId ?? getDefaultLodgeId()` fallback mean that even if a null row appeared
  (e.g. a pre-lodge old colour wrote one during a cutover), it resolves to the
  default lodge rather than disappearing or erroring. Overlap/uniqueness checks
  deliberately treat null-lodge rows as belonging to every lodge, so they can
  never be double-booked.
- **Legacy identity columns kept in sync.** `EmailMessageSetting.lodgeName/…`
  are retained and kept current by `syncSoleActiveLodgeIdentity`, so any code
  path (old or new) reads consistent values.

The DB-level `NOT NULL` guarantee is therefore a *nice-to-have we forgo* to keep
zero-downtime, target-latest deploys safe — not a correctness requirement.

## Additive hardening that IS still safe (optional)

Not everything a contract release would do is breaking. Adding **partial unique
indexes** (`WHERE "lodgeId" IS NULL`) on the policy tables
(`CancellationPolicy`, `MinimumStayPolicy`, `BookingPeriod`, `LodgeInstruction`)
is *additive* — existing null rows already satisfy uniqueness (app-enforced
since expand), so the index validates cleanly and the old colour is unaffected.
These may ship in a normal expand-safe migration if we want the club-wide
partition's uniqueness re-hardened at the DB level. They are optional and
independent of the `NOT NULL` decision above.

---

## Appendix — if the deployment model ever changes

Should the project ever move to coordinated maintenance-window upgrades (old
colour stopped before migrate), the breaking items below become runnable. This
is retained so the derivation isn't lost — **do not run any of it under the
current blue/green + target-latest model.**

Preconditions if ever run: old colour fully stopped (not merely idle); backfill
verified (every count below `0`) before any `NOT NULL`.

```sql
SELECT count(*) FROM "LodgeRoom"           WHERE "lodgeId" IS NULL;
SELECT count(*) FROM "Locker"              WHERE "lodgeId" IS NULL;
SELECT count(*) FROM "Season"              WHERE "lodgeId" IS NULL;
SELECT count(*) FROM "Booking"             WHERE "lodgeId" IS NULL;
SELECT count(*) FROM "ChoreTemplate"       WHERE "lodgeId" IS NULL;
SELECT count(*) FROM "HutLeaderAssignment" WHERE "lodgeId" IS NULL;
```

Items a contract release would contain: (1) `NOT NULL` on `LodgeRoom`, `Locker`,
`Season`, `Booking`, `ChoreTemplate`, `HutLeaderAssignment` `lodgeId`; (2) the
policy-table partial unique indexes (additive — see above, shippable now); (3)
simplify the null-lodge compatibility branches once no nulls remain; (4) drop
`EmailMessageSetting.lodgeName/lodgeTravelNote/doorCode`; (5) optional
`LodgeSettings` legacy-`"default"`-row consolidation. Each `NOT NULL`/drop row in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` would be `phase = contract`, name its
`previous_expand_release`, and honestly carry `old_code_compatible = no` — which
is precisely why they are not run under blue/green.
