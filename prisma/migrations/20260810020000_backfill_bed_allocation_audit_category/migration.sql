-- #2751: give the bed-allocation audit rows written BEFORE #2730 the category
-- their writers now use, so bed-allocation history stops being split by date.
--
-- WHAT #2730 DID AND DID NOT DO. It moved 22 write sites from `admin` to
-- `lodge` — 21 admin-initiated bed-allocation writers plus the lodge display
-- configuration — because the affected domain is a bed in a lodge room on a
-- lodge night whoever moved it. `AuditLog.category` is STORED on the row at
-- write time and never re-derived at read time, so every bed-allocation row
-- written before that release still says `admin` and always will. Admin > Audit
-- Log's Category filter therefore answers "show me the bed allocations for that
-- weekend" only for one side of the release date, and the AI Diagnostics lodge
-- correlation entry returns the newer half while the system entry returns the
-- older half. This statement closes that, once, for exactly those actions.
--
-- WHY THIS IS ALLOWED TO REWRITE AN APPEND-ONLY TABLE. `AuditLog` is append-only
-- by convention and there is no undo, so the scope is the narrowest that fixes
-- the defect: ONE column, on rows matched by an exact literal action list and a
-- `category = 'admin'` predicate. Nothing else on the row is named in the SET
-- clause, so `severity`, `retentionClass`, `expiresAt`, `createdAt`, `details`,
-- `metadata`, `summary`, `entityType`, `entityId`, `requestId`, `outcome`,
-- `archivedAt`, `incidentPreserved`, `ipAddress`, `userAgent` and every actor
-- column (`memberId`, `actorMemberId`, `subjectMemberId`, `targetId`) keep the
-- bytes they were written with. In particular the migration does NOT recompute
-- `retentionClass` or `expiresAt` from the new category, which is the one edit
-- that would silently re-date when a row is purged.
--
-- AN EXACT LITERAL LIST, NEVER A PREFIX MATCH. `LIKE 'BED_ALLOCATION%'` would
-- read as simpler and is the wrong answer twice over: it cannot be reviewed
-- against the audit-writer census, and it would sweep up any bed-allocation
-- action added after this migration was written — an action whose writer may
-- have been classified deliberately somewhere else. The 18 names below are the
-- distinct `action` values written at the 22 sites #2730 moved, measured from
-- the census rather than typed from memory, and
-- `src/lib/__tests__/bed-allocation-audit-category-backfill.test.ts` fails if
-- this list and `REVIEWED_ADMIN_CATEGORIES_2730` ever stop agreeing in either
-- direction. 17 of the 18 are bed allocation; `LODGE_DISPLAY_CONFIG_UPDATED` is
-- the lodge display configuration, the 22nd site. (The issue body says "23 bed
-- allocation action codes"; the measured number of distinct action names is 17,
-- because five sites share `BED_ALLOCATION_PARTNER(S)_PROMOTED` and two share
-- `BED_ALLOCATION_BULK_SET`/`_MANUAL_SET`.)
--
-- RETENTION DOES NOT MOVE, and this was checked in the code rather than assumed.
-- `pruneExpiredAuditLogs` and `archiveEligibleAuditLogs` in
-- `src/lib/audit-retention.ts` select on the STORED `retentionClass`,
-- `expiresAt`, `severity`, `createdAt` and `archivedAt` columns and never read
-- `category` at all, so a category rewrite cannot change when a row is archived
-- or purged. The only code that re-derives retention from a stored row's
-- category is `isAuditLogRetentionCritical`, a test seam with no production
-- caller, and it agrees anyway: `classifyAuditRetention` only treats a category
-- specially for an ACCESS event (its test is /\b(view|access|login|logout|
-- search)\b/ over the action with `._-` turned into spaces) or for
-- `category = 'system'`, and not one of the 18 names below matches either — so
-- every one of these rows classifies `critical` (seven years) under `admin` and
-- under `lodge` alike.
--
-- NO MEMBER GAINS OR LOSES SIGHT OF ANYTHING. `MEMBER_VISIBLE_AUDIT_CATEGORIES`
-- in `src/lib/audit-query.ts` holds neither `admin` nor `lodge`, so none of
-- these rows is on a member's own activity page in either direction.
--
-- WHO CAN READ THEM AFTERWARDS — this IS a readership change, and it is the
-- narrowing #2730 already applied to new rows (`AUDIT_CORRELATION_DOMAIN_AREAS`
-- makes `admin` a `support` read and `lodge` a `support` AND `lodge` read):
--   * AI Diagnostics, support alone: LOSES these rows. They leave the system
--     correlation entry and do not appear in the lodge one.
--   * AI Diagnostics, support + lodge: GAINS them, in the entry that already
--     holds every newer bed-allocation row.
--   * Admin > Audit Log: unchanged. It is a `support`-area surface with no
--     category gate of its own, so anyone with Support access still reads every
--     one of these rows in full — which is why this is a projection change and
--     not a loss of evidence.
--
-- ROWS WITH NO CATEGORY AT ALL ARE OUT OF SCOPE, deliberately. `category = 'admin'`
-- does not match NULL, so the pre-#2581 uncategorised rows stay as they are;
-- they are a different population with a different decision (#2581's third
-- child), and `buildAuditCategoryWhere`'s legacy action-name fallback already
-- fires for them because it is gated on `category IS NULL`.
--
-- IDEMPOTENT. The predicate is the state the statement destroys: after it runs,
-- no row matches `category = 'admin' AND action IN (…)`, so a second run updates
-- zero rows — and the audit row below is gated on `rewritten > 0`, so a second
-- run appends nothing either. `idempotentReRun: true` in the fixture makes the
-- real-PostgreSQL suite prove that rather than take this comment's word for it.
--
-- BOUNDED. The `IN` list is 18 constants against `AuditLog_action_idx`
-- (`@@index([action])`), so the planner reaches these rows by a bitmap index
-- scan rather than scanning the table, and the rows it locks are only the ones
-- it rewrites. The population is one club's bed-allocation history — thousands
-- of rows on a busy install, not millions — so there is no batching here and
-- none is wanted: batching would give up the single-statement atomicity that
-- makes a partial rewrite impossible. No DDL, so no table-level lock and no
-- `ACCESS EXCLUSIVE` wait behind a long reader.
--   The one contention this can meet is the nightly retention job on the still-
--   serving old colour: `anonymizeExpiredAuditRequestData` updates `ipAddress`/
--   `userAgent` on old rows and `pruneExpiredAuditLogs` deletes expired ones, and
--   either could hold a row lock this statement wants (or, in the worst case,
--   deadlock with it). That failure is SAFE rather than silent: PostgreSQL
--   aborts one transaction, `prisma migrate deploy` fails, and the deploy stops
--   BEFORE cutover with nothing half-applied. Re-run the deploy.
--
-- OPERATOR NOTE — RE-RUN THIS STATEMENT AFTER CUTOVER, and the runbook asks for
-- it: `docs/PRODUCTION_UPGRADE_RUNBOOK.md` §3.2. `prisma migrate deploy` is step
-- 13/20 of that runbook, before the new colour takes traffic, and #2730 has not
-- shipped in any release yet — so during the window between this migration and
-- cutover the OLD colour is still filing new bed-allocation rows as `admin`.
-- Those rows are written after this statement has already passed and keep
-- `admin` permanently unless the same statement is run again. Running it
-- verbatim a second time after cutover picks them up and changes nothing
-- anywhere it already ran. This is not reversible by aborting the cutover: a
-- committed data rewrite survives a rollback of the code, there is no
-- `rollback.sql` (this migration is not `windowed`), and the club's own record
-- of the rewrite is the `AUDIT_CATEGORY_BACKFILLED` row below.

WITH before_counts AS (
  -- The BEFORE half of the count decision B asks for, read in the same statement
  -- as the rewrite. All sub-statements of a `WITH` share one snapshot and cannot
  -- see each other's effects, so this counts the table as it stood before the
  -- UPDATE even though it is written beside it — which is exactly what "before"
  -- has to mean, and it is atomic with the rewrite rather than a separate query
  -- somebody has to remember to run first.
  SELECT
    count(*) FILTER (WHERE "category" = 'admin')::int AS "adminBefore",
    count(*) FILTER (WHERE "category" = 'lodge')::int AS "lodgeBefore"
  FROM "AuditLog"
  WHERE "action" IN (
    'BED_ALLOCATION_APPROVED',
    'BED_ALLOCATION_AUTO_RUN',
    'BED_ALLOCATION_BED_CREATED',
    'BED_ALLOCATION_BED_DELETED',
    'BED_ALLOCATION_BED_UPDATED',
    'BED_ALLOCATION_BULK_SET',
    'BED_ALLOCATION_CONFIG_IMPORTED',
    'BED_ALLOCATION_MANUAL_SET',
    'BED_ALLOCATION_PARTNERS_PROMOTED',
    'BED_ALLOCATION_PARTNER_PROMOTED',
    'BED_ALLOCATION_RANGE_SET',
    'BED_ALLOCATION_REMOVAL_APPLIED',
    'BED_ALLOCATION_ROOMS_BULK_CREATED',
    'BED_ALLOCATION_ROOM_CREATED',
    'BED_ALLOCATION_ROOM_DELETED',
    'BED_ALLOCATION_ROOM_UPDATED',
    'BED_ALLOCATION_SETTINGS_UPDATED',
    'LODGE_DISPLAY_CONFIG_UPDATED'
  )
),
rewritten AS (
  -- The rewrite itself. `category` is the only column named; every other field
  -- keeps the bytes it was written with.
  UPDATE "AuditLog"
  SET "category" = 'lodge'
  WHERE "category" = 'admin'
    AND "action" IN (
      'BED_ALLOCATION_APPROVED',
      'BED_ALLOCATION_AUTO_RUN',
      'BED_ALLOCATION_BED_CREATED',
      'BED_ALLOCATION_BED_DELETED',
      'BED_ALLOCATION_BED_UPDATED',
      'BED_ALLOCATION_BULK_SET',
      'BED_ALLOCATION_CONFIG_IMPORTED',
      'BED_ALLOCATION_MANUAL_SET',
      'BED_ALLOCATION_PARTNERS_PROMOTED',
      'BED_ALLOCATION_PARTNER_PROMOTED',
      'BED_ALLOCATION_RANGE_SET',
      'BED_ALLOCATION_REMOVAL_APPLIED',
      'BED_ALLOCATION_ROOMS_BULK_CREATED',
      'BED_ALLOCATION_ROOM_CREATED',
      'BED_ALLOCATION_ROOM_DELETED',
      'BED_ALLOCATION_ROOM_UPDATED',
      'BED_ALLOCATION_SETTINGS_UPDATED',
      'LODGE_DISPLAY_CONFIG_UPDATED'
    )
  RETURNING "id", "action"
)
-- The club's own durable record of the rewrite, and the AFTER half of decision
-- B's count. It is an audit row rather than a `RAISE NOTICE` for one plain
-- reason: `prisma migrate deploy` does not surface PostgreSQL notices, so a
-- notice would be a log nobody can read. This row is readable in Admin > Audit
-- Log for seven years, and it is `admin` — the support-only category — on
-- purpose, so the support-only operator who just lost these rows from their
-- system correlation entry can see in that same entry why.
INSERT INTO "AuditLog" (
  "id",
  "action",
  "entityType",
  "category",
  "severity",
  "outcome",
  "summary",
  "metadata",
  "retentionClass",
  "expiresAt",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  'AUDIT_CATEGORY_BACKFILLED',
  -- The affected population is a SET of audit rows, not one record, so there is
  -- no honest `entityId` to give: inventing one would put a false reference into
  -- the club's audit trail (the same reason recorded in
  -- `AUDIT_WRITERS_WITHOUT_ENTITY_IDENTIFIER` for the 16 collection writers).
  'AuditLog',
  'admin',
  'important',
  'success',
  'Upgrade moved historical bed-allocation and lodge-display activity records from the Admin category to Lodge, so the whole history reads as one run',
  jsonb_build_object(
    -- MEASURED and DERIVED are separated because they are not the same kind of
    -- number and an operator reading this row should not have to guess which is
    -- which. `measured` is what PostgreSQL counted. `derived` is arithmetic: a
    -- re-read of the table in this statement would return the BEFORE snapshot
    -- again (all `WITH` sub-statements share one snapshot), so the after figures
    -- are computed from the two measurements rather than pretended to be
    -- readings. The fixture at
    -- `prisma/migration-verification/20260810020000_backfill_bed_allocation_audit_category.ts`
    -- compares them against an independently measured post-state, so the
    -- arithmetic is proven rather than asserted.
    'measured', jsonb_build_object(
      'adminBefore', before_counts."adminBefore",
      'lodgeBefore', before_counts."lodgeBefore",
      'rewritten', (SELECT count(*)::int FROM rewritten),
      'rewrittenActions', (
        SELECT jsonb_agg(DISTINCT rewritten."action" ORDER BY rewritten."action")
        FROM rewritten
      )
    ),
    'derived', jsonb_build_object(
      'adminAfter', before_counts."adminBefore" - (SELECT count(*)::int FROM rewritten),
      'lodgeAfter', before_counts."lodgeBefore" + (SELECT count(*)::int FROM rewritten)
    ),
    'source', 'migration:20260810020000_backfill_bed_allocation_audit_category',
    'issue', 2751,
    'reclassifiedBy', 2730
  ),
  -- Stated rather than derived, because raw SQL does not go through
  -- `buildAuditLogCreateData`. These are the values that boundary would have
  -- produced: `classifyAuditRetention` returns `critical` for this action under
  -- `admin` (it is not an access event and the category is not `system`), and
  -- `getAuditRetentionExpiresAt` puts `critical` seven years out.
  'critical',
  timezone('UTC', statement_timestamp()) + interval '7 years',
  timezone('UTC', statement_timestamp())
FROM before_counts
-- Nothing to record when nothing moved, which is what makes the whole migration
-- idempotent: a replay rewrites no row and appends no row.
WHERE (SELECT count(*) FROM rewritten) > 0;
