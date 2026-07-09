# Multi-Lodge Schema Tightening — status and what remains

The multi-lodge schema shipped **expand-first** (`lodgeId` added nullable and
backfilled to the sole lodge). This doc records what has since been **tightened**,
how it was done **without an outage**, and what is deliberately **left as-is**.

## Done: `lodgeId` is now `NOT NULL` on the entity tables — with no outage

Migration `20260708001100_multi_lodge_entity_lodge_id_not_null` enforces
`NOT NULL` on `lodgeId` for the six entity tables (`LodgeRoom`, `Locker`,
`Season`, `Booking`, `ChoreTemplate`, `HutLeaderAssignment`).

The catch it solves: deploys are blue/green (the `migrate` container runs while
the *old* app colour still serves) and clubs **target `latest`**, so the old
colour during a cutover can be *pre-lodge* code that doesn't stamp `lodgeId`. A
naive `SET NOT NULL` would reject that colour's inserts mid-cutover (outage) or
abort the migration.

The fix is a **column default that resolves the lodge**:

```sql
CREATE FUNCTION default_lodge_id() ...   -- oldest active lodge, else oldest
ALTER TABLE "Booking" ALTER COLUMN "lodgeId" SET DEFAULT default_lodge_id();
UPDATE "Booking" SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL;
ALTER TABLE "Booking" ALTER COLUMN "lodgeId" SET NOT NULL;
```

An old colour's `INSERT` omits `lodgeId` → the default fills the lodge → no null
is ever written → `NOT NULL` holds throughout the cutover, on both fresh and
existing installs. **No outage, no migration abort.** The schema declares the
default as `@default(dbgenerated("default_lodge_id()"))`, which `db:check-drift`
matches exactly. The default is kept **permanently** (harmless — new code always
stamps `lodgeId`; the default only ever fires for an old colour's omitted-column
write during a cutover). Removing it later would re-open the window and is not
planned.

**Deploy: no override needed.** The blue/green migration validator recognises the safe pattern — a `SET NOT NULL` whose same table+column also gets a `SET DEFAULT` in the same migration is old-code-compatible — so this deploys through the normal blue/green flow **without** `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS`. It still carries a documented safety-ledger row; genuinely-breaking SQL (drops, renames, type changes, or an *unmatched* `SET NOT NULL`) stays gated.

The null-tolerant code paths for these tables are now retired:
`lodgeNullTolerantScope` returns a strict `{ lodgeId }`, capacity queries scope
with a plain `lodgeId` field, and the bulk-seed / hut-leader-PIN "null clashes
everywhere" branches are gone.

## Done: `EmailMessageSetting` lodge-identity columns dropped — identity resolves from `Lodge`

Migration `20260709001000_drop_email_message_setting_lodge_identity_columns`
drops `EmailMessageSetting.lodgeName / lodgeTravelNote / doorCode`. It landed
with the code refactor it required: `loadEmailMessageSettingsForLodge` now
**always** resolves a lodge and reads name / travel note / door code from the
`Lodge` table — the explicit booking lodge when given, otherwise the club's
**default lodge** (oldest active, else oldest — the same resolution as
`getDefaultLodgeId` and the SQL `default_lodge_id()` function). The club-level
fields (club name, bookings name, sender name, support / contact email, public
URL) stay on the singleton. `loadEmailMessageSettings()` now delegates to
`loadEmailMessageSettingsForLodge(null)`, and the compatibility mirror
`syncSoleActiveLodgeIdentity` is retired.

The drop is **value-dead** after the same-release refactor — nothing reads the
columns' values anymore. The migration **backfills first** so no admin-entered
value is lost: it copies the singleton's `lodgeTravelNote` / `doorCode` onto the
default lodge wherever that lodge's own columns are still NULL. `lodgeName` is
not backfilled — `Lodge.name` is NOT NULL and authoritative, so a divergent
email-only lodge name is superseded by design.

**Deploy: breaking-gated.** The columns stayed in the Prisma model until this
release, so an old colour during a cutover still SELECTs them by name on the
singleton. Member-facing sends **degrade gracefully** (the persisted-settings
loader catches the error and falls back to config defaults, and per-booking
identity already reads from `Lodge`), but the admin email-settings and
lodge-admin routes error until cutover — admin-only, brief, retryable. Deploy
with old traffic idle or drained and `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1`;
the migration-ledger row records the full rationale.

## Deliberately NOT done

### Policy-table null-partition partial unique indexes — not expressible in Prisma

`CancellationPolicy` and `LodgeInstruction` keep a **nullable** `lodgeId`
(null = club-wide default) with `@@unique([lodgeId, …])`. PostgreSQL treats NULLs
as distinct, so the club-wide (null) partition isn't DB-enforced; a partial
`… WHERE "lodgeId" IS NULL` unique index would restore it. Prisma's schema cannot
express a partial index, so adding one as raw SQL would itself fail
`db:check-drift`. The club-wide uniqueness therefore stays **app-enforced** (the
admin routes' Serializable replace transactions), unchanged from the expand
release. Revisit only if Prisma gains partial-index support.

## Policy tables keep nullable `lodgeId` by design

`CancellationPolicy`, `MinimumStayPolicy`, `BookingPeriod`, `LodgeInstruction`,
`BookingRequest`, and the settings singletons keep a nullable `lodgeId` where
`null` is a real value (club-wide default / no explicit lodge). These are **not**
part of the `NOT NULL` tightening; they scope via `resolvePolicyRowsForLodge`
(own row → club-wide/null fallback), not `lodgeNullTolerantScope`.
