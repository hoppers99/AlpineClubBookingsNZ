import type { DataMigrationVerification } from "./types";

/**
 * #2751 — the bed-allocation audit rows written before #2730.
 *
 * `AuditLog` is append-only by convention and this migration REWRITES stored
 * rows, so there is no undo and nothing about it may be taken on trust. Every
 * property the issue's safety argument rests on is asserted here against a real
 * PostgreSQL, because none of them is reachable from the empty tables
 * `Migration drift check` uses: the statement's `UPDATE` would match no row, and
 * the whole thing would be proven to parse and proven to do nothing (#2418).
 *
 * WHAT THE CASES ARE FOR, one property each:
 *
 *  - the rewrite reaches the pre-#2730 `admin` rows for the 18 exact actions;
 *  - it reaches NOTHING else — not another category, not a `LODGE_*` row, not a
 *    bed-allocation-shaped action name that is not on the list, and not a row
 *    with no category at all;
 *  - every other column on a rewritten row is byte-identical afterwards, which
 *    is the property that keeps retention and the actor trail intact;
 *  - the counts decision B asked for are really in the club's record, and the
 *    two DERIVED figures match an independently measured post-state — the one
 *    number in this migration that arithmetic produces rather than PostgreSQL;
 *  - an install with nothing to move records nothing, which is what makes the
 *    statement safe to run again after cutover.
 *
 * `AuditLog` carries no foreign keys, so every seed below is a plain insert on
 * the real schema with no parent rows to invent.
 */

/** The 18 action names the migration names, as a SQL list for the seeds below. */
const TARGETED_ACTIONS = [
  "BED_ALLOCATION_APPROVED",
  "BED_ALLOCATION_AUTO_RUN",
  "BED_ALLOCATION_BED_CREATED",
  "BED_ALLOCATION_BED_DELETED",
  "BED_ALLOCATION_BED_UPDATED",
  "BED_ALLOCATION_BULK_SET",
  "BED_ALLOCATION_CONFIG_IMPORTED",
  "BED_ALLOCATION_MANUAL_SET",
  "BED_ALLOCATION_PARTNERS_PROMOTED",
  "BED_ALLOCATION_PARTNER_PROMOTED",
  "BED_ALLOCATION_RANGE_SET",
  "BED_ALLOCATION_REMOVAL_APPLIED",
  "BED_ALLOCATION_ROOMS_BULK_CREATED",
  "BED_ALLOCATION_ROOM_CREATED",
  "BED_ALLOCATION_ROOM_DELETED",
  "BED_ALLOCATION_ROOM_UPDATED",
  "BED_ALLOCATION_SETTINGS_UPDATED",
  "LODGE_DISPLAY_CONFIG_UPDATED",
] as const;

/**
 * One `admin` row per targeted action, so the case proves all 18 names move
 * rather than proving the two a hand-written seed would have thought of. Ids are
 * literal and ordered so the assertions can read them back deterministically.
 */
const everyTargetedActionAsAdmin = TARGETED_ACTIONS.map(
  (action, index) => `(
    'seed-targeted-${String(index).padStart(2, "0")}',
    '${action}',
    'admin',
    TIMESTAMP '2026-06-0${(index % 9) + 1} 09:00:00'
  )`,
).join(",\n  ");

/**
 * The rows that must NOT move, each one a different way of getting this wrong.
 *
 * `LODGE_UPDATED` is the sharpest of them: #2730 deliberately LEFT the fifteen
 * lodge-gated writers (`LODGE_CREATED`, `LODGE_UPDATED`, `LODGE_SETTINGS_UPDATED`,
 * lodge instructions) at `admin`, so a backfill that reasoned "it says lodge, it
 * must be lodge" would silently take a decision #2730 explicitly declined and
 * #2755 still holds open.
 */
const untouchableRows = `(
    'seed-other-category',
    'BED_ALLOCATION_MANUAL_SET',
    'booking',
    TIMESTAMP '2026-06-10 09:00:00'
  ),
  (
    'seed-already-lodge',
    'BED_ALLOCATION_MANUAL_SET',
    'lodge',
    TIMESTAMP '2026-06-11 09:00:00'
  ),
  (
    'seed-lifecycle-lodge',
    'BED_ALLOCATION_MOVE_APPLIED',
    'lodge',
    TIMESTAMP '2026-06-12 09:00:00'
  ),
  (
    'seed-lodge-record',
    'LODGE_UPDATED',
    'admin',
    TIMESTAMP '2026-06-13 09:00:00'
  ),
  (
    'seed-lodge-instruction',
    'LODGE_INSTRUCTION_UPDATED',
    'admin',
    TIMESTAMP '2026-06-14 09:00:00'
  ),
  (
    'seed-member-merge',
    'MEMBER_MERGE_EXECUTED',
    'admin',
    TIMESTAMP '2026-06-15 09:00:00'
  ),
  (
    'seed-future-bed-action',
    'BED_ALLOCATION_SOMETHING_ADDED_LATER',
    'admin',
    TIMESTAMP '2026-06-16 09:00:00'
  )`;

const verification: DataMigrationVerification = {
  migration: "20260810020000_backfill_bed_allocation_audit_category",
  intent:
    "Move the stored category from `admin` to `lodge` on exactly the audit rows whose writers #2730 reclassified — the 17 bed-allocation actions and the lodge display configuration — changing no other column on those rows, no row in any other category, and no row whose category is NULL; and record the before/after counts as one AUDIT_CATEGORY_BACKFILLED row, only when something actually moved.",
  idempotentReRun: true,
  cases: [
    {
      name: "a club with bed-allocation history either side of the #2730 release, plus every row that must not move",
      seed: `
        INSERT INTO "AuditLog" ("id", "action", "category", "createdAt")
        VALUES
          ${everyTargetedActionAsAdmin},
          ${untouchableRows};

        -- A pre-#2581 row: no category at all. #2581's third child owns this
        -- population and \`category = 'admin'\` does not match NULL, so it must
        -- still be NULL afterwards — the legacy action-name fallback in
        -- buildAuditCategoryWhere only fires while it is.
        INSERT INTO "AuditLog" ("id", "action", "category", "createdAt")
        VALUES ('seed-uncategorised', 'BED_ALLOCATION_MANUAL_SET', NULL,
                TIMESTAMP '2026-01-05 09:00:00');
      `,
      expectations: [
        {
          claim:
            "all 18 targeted actions moved to `lodge`: 18 rows, and none of them still says `admin`",
          sql: `SELECT count(*)::int AS "lodgeNow"
                  FROM "AuditLog"
                 WHERE "id" LIKE 'seed-targeted-%' AND "category" = 'lodge'`,
          rows: [{ lodgeNow: 18 }],
        },
        {
          claim:
            "not one targeted row is left behind on `admin` — the count above could be satisfied by a partial rewrite",
          sql: `SELECT "id", "action" FROM "AuditLog"
                 WHERE "id" LIKE 'seed-targeted-%' AND "category" <> 'lodge'
                 ORDER BY "id"`,
          rows: [],
        },
        {
          claim:
            "every row that must not move still holds exactly the category it was written with: another category, an already-`lodge` row, a lifecycle action, the two `LODGE_*` records #2730 deliberately kept at `admin`, an unrelated admin action, and a bed-allocation-shaped name that is not on the list",
          sql: `SELECT "id", "category" FROM "AuditLog"
                 WHERE "id" IN ('seed-other-category', 'seed-already-lodge',
                                'seed-lifecycle-lodge', 'seed-lodge-record',
                                'seed-lodge-instruction', 'seed-member-merge',
                                'seed-future-bed-action')
                 ORDER BY "id"`,
          rows: [
            { id: "seed-already-lodge", category: "lodge" },
            { id: "seed-future-bed-action", category: "admin" },
            { id: "seed-lifecycle-lodge", category: "lodge" },
            { id: "seed-lodge-instruction", category: "admin" },
            { id: "seed-lodge-record", category: "admin" },
            { id: "seed-member-merge", category: "admin" },
            { id: "seed-other-category", category: "booking" },
          ],
        },
        {
          claim:
            "the row with no category still has none, so the uncategorised population is untouched and its legacy action-name fallback still fires",
          sql: `SELECT "id", "category" FROM "AuditLog"
                 WHERE "id" = 'seed-uncategorised'`,
          rows: [{ id: "seed-uncategorised", category: null }],
        },
        {
          claim:
            "exactly one AUDIT_CATEGORY_BACKFILLED row is written, in the support-only `admin` category so the operator who just lost these rows from their system correlation entry can see why",
          sql: `SELECT "action", "category", "severity", "outcome", "entityType",
                       "entityId", "retentionClass"
                  FROM "AuditLog" WHERE "action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [
            {
              action: "AUDIT_CATEGORY_BACKFILLED",
              category: "admin",
              severity: "important",
              outcome: "success",
              entityType: "AuditLog",
              entityId: null,
              retentionClass: "critical",
            },
          ],
        },
        {
          claim:
            "the counts decision B asked for are really recorded: 18 rows on the superseded category before, 1 already on `lodge` before, 18 rewritten, and all 18 action names among the ones that moved",
          sql: `SELECT ("metadata" -> 'measured' ->> 'adminBefore')::int AS "adminBefore",
                       ("metadata" -> 'measured' ->> 'lodgeBefore')::int AS "lodgeBefore",
                       ("metadata" -> 'measured' ->> 'rewritten')::int AS "rewritten",
                       jsonb_array_length("metadata" -> 'measured' -> 'rewrittenActions')
                         AS "distinctActions",
                       -- Containment, not an ordered comparison: the migration's
                       -- ORDER BY is collation-dependent (an `en_US` database
                       -- orders `PARTNERS_` against `PARTNER_` differently from a
                       -- `C` one), and only the SET is load-bearing.
                       ("metadata" -> 'measured' -> 'rewrittenActions')
                         @> ${dollarQuoted(JSON.stringify([...TARGETED_ACTIONS]))}::jsonb
                         AS "namesEveryAction"
                  FROM "AuditLog" WHERE "action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [
            {
              adminBefore: 18,
              lodgeBefore: 1,
              rewritten: 18,
              distinctActions: 18,
              namesEveryAction: true,
            },
          ],
        },
        {
          claim:
            "the two DERIVED figures match an independently measured post-state — `adminAfter` is really 0 and `lodgeAfter` is really the number of targeted-action rows now carrying `lodge`",
          sql: `SELECT
                    (log."metadata" -> 'derived' ->> 'adminAfter')::int AS "loggedAdminAfter",
                    (log."metadata" -> 'derived' ->> 'lodgeAfter')::int AS "loggedLodgeAfter",
                    measured."adminAfter",
                    measured."lodgeAfter"
                  FROM "AuditLog" log
                  CROSS JOIN (
                    SELECT
                      count(*) FILTER (WHERE "category" = 'admin')::int AS "adminAfter",
                      count(*) FILTER (WHERE "category" = 'lodge')::int AS "lodgeAfter"
                    FROM "AuditLog"
                    WHERE "action" IN (${TARGETED_ACTIONS.map((action) => `'${action}'`).join(", ")})
                  ) measured
                  WHERE log."action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [
            {
              loggedAdminAfter: 0,
              loggedLodgeAfter: 19,
              adminAfter: 0,
              lodgeAfter: 19,
            },
          ],
        },
        {
          claim:
            "the backfill row's own retention is the seven years `classifyAuditRetention` would have derived, stated rather than left NULL because raw SQL bypasses the audit boundary",
          sql: `SELECT "expiresAt" = "createdAt" + interval '7 years' AS "sevenYears",
                       "createdAt" IS NOT NULL AS "hasCreatedAt"
                  FROM "AuditLog" WHERE "action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [{ sevenYears: true, hasCreatedAt: true }],
        },
      ],
    },
    {
      name: "one rewritten row carrying every other field a real audit row carries",
      seed: `
        INSERT INTO "AuditLog" (
          "id", "action", "memberId", "targetId", "details", "ipAddress",
          "createdAt", "actorMemberId", "subjectMemberId", "entityType",
          "entityId", "category", "severity", "outcome", "summary", "metadata",
          "requestId", "userAgent", "retentionClass", "expiresAt", "archivedAt",
          "incidentPreserved"
        )
        VALUES (
          'seed-full-row', 'BED_ALLOCATION_MANUAL_SET', 'member-actor',
          'member-target', 'Moved Jane Doe to bed 4',
          '203.0.113.7', TIMESTAMP '2026-05-04 21:15:32.123', 'member-actor',
          'member-subject', 'BedAllocation', 'alloc-1', 'admin', 'important',
          'success', 'Bed allocation set by hand',
          '{"bedId": "bed-4", "night": "2026-07-14"}'::jsonb,
          'req-abc', 'Mozilla/5.0', 'critical',
          TIMESTAMP '2033-05-04 21:15:32.123', NULL, true
        );
      `,
      expectations: [
        {
          claim:
            "only `category` changed. Every other column is byte-identical — and `retentionClass`/`expiresAt` in particular, because recomputing them from the new category is the one edit that would silently re-date when this row is purged",
          sql: `SELECT "action", "memberId", "targetId", "details", "ipAddress",
                       to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "createdAt",
                       "actorMemberId", "subjectMemberId", "entityType", "entityId",
                       "category", "severity", "outcome", "summary",
                       "metadata"::text AS "metadata", "requestId", "userAgent",
                       "retentionClass",
                       to_char("expiresAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "expiresAt",
                       "archivedAt", "incidentPreserved"
                  FROM "AuditLog" WHERE "id" = 'seed-full-row'`,
          rows: [
            {
              action: "BED_ALLOCATION_MANUAL_SET",
              memberId: "member-actor",
              targetId: "member-target",
              details: "Moved Jane Doe to bed 4",
              ipAddress: "203.0.113.7",
              createdAt: "2026-05-04 21:15:32.123",
              actorMemberId: "member-actor",
              subjectMemberId: "member-subject",
              entityType: "BedAllocation",
              entityId: "alloc-1",
              category: "lodge",
              severity: "important",
              outcome: "success",
              summary: "Bed allocation set by hand",
              metadata: '{"bedId": "bed-4", "night": "2026-07-14"}',
              requestId: "req-abc",
              userAgent: "Mozilla/5.0",
              retentionClass: "critical",
              expiresAt: "2033-05-04 21:15:32.123",
              archivedAt: null,
              incidentPreserved: true,
            },
          ],
        },
      ],
    },
    {
      name: "an install with nothing to move — the shape a replay after cutover meets",
      seed: `
        INSERT INTO "AuditLog" ("id", "action", "category", "createdAt")
        VALUES
          ('seed-replay-lodge', 'BED_ALLOCATION_MANUAL_SET', 'lodge',
           TIMESTAMP '2026-06-20 09:00:00'),
          ('seed-replay-admin', 'MEMBER_MERGE_EXECUTED', 'admin',
           TIMESTAMP '2026-06-21 09:00:00');
      `,
      expectations: [
        {
          claim:
            "nothing moved, so NO backfill row is appended. An unconditional insert would append one saying `rewritten: 0` on every replay, which is a change — and would make the whole migration non-idempotent",
          sql: `SELECT count(*)::int AS "backfillRows" FROM "AuditLog"
                 WHERE "action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [{ backfillRows: 0 }],
        },
        {
          claim: "and the two seeded rows are exactly as they were",
          sql: `SELECT "id", "category" FROM "AuditLog"
                 WHERE "id" LIKE 'seed-replay-%' ORDER BY "id"`,
          rows: [
            { id: "seed-replay-admin", category: "admin" },
            { id: "seed-replay-lodge", category: "lodge" },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "drop the `category = 'admin'` predicate, keeping only the action list",
      harm:
        "Rewrites a targeted action's row in EVERY category, not only the superseded one: the `booking`-category row and the row with no category both become `lodge`. That silently republishes rows to a different permission gate than the one they were classified into, and the NULL row loses the legacy action-name fallback that is the only thing making it findable at all.",
      find: `  WHERE "category" = 'admin'
    AND "action" IN (`,
      replace: `  WHERE "action" IN (`,
    },
    {
      name: "match the action names by prefix instead of the exact literal list",
      harm:
        "This is the shortcut the issue explicitly forbids. It sweeps up any bed-allocation action added after this migration was written — including one deliberately classified somewhere else — and it silently DROPS `LODGE_DISPLAY_CONFIG_UPDATED`, the 22nd site, which does not share the prefix. Neither half can be reviewed against the audit-writer census.",
      find: `    AND "action" IN (
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
    )`,
      replace: `    AND "action" LIKE 'BED_ALLOCATION%'`,
    },
    {
      name: "also recompute retentionClass and expiresAt from the new category",
      harm:
        "Re-dates when these rows are purged. It is the most dangerous edit available here because it looks conscientious — the stored retention WAS derived from the category at write time — and it is invisible for two years: `sensitive_access` expires at 24 months where `critical` expires at 7 years, so an admin-initiated bed allocation would be deleted five years early, and there is no undo on an append-only table.",
      find: `  SET "category" = 'lodge'`,
      replace: `  SET "category" = 'lodge',
      "retentionClass" = 'sensitive_access',
      "expiresAt" = timezone('UTC', statement_timestamp()) + interval '24 months'`,
    },
    {
      name: "write the backfill audit row unconditionally",
      harm:
        "Breaks idempotency in the one direction that matters for the post-cutover replay: every re-run appends another AUDIT_CATEGORY_BACKFILLED row claiming a rewrite that did not happen, so the club's own record of what the upgrade did becomes a pile of zero-row entries and the operator note to run the statement again reads as unsafe.",
      find: `WHERE (SELECT count(*) FROM rewritten) > 0;`,
      replace: `;`,
    },
    {
      name: "log the lodge total as it was before the rewrite",
      harm:
        "Decision B asked for the row count before AND after. A stale `lodgeAfter` makes the record say the rewrite was smaller than it was, which is exactly the number an operator would use to decide whether the backfill needs running again after cutover.",
      find: `'lodgeAfter', before_counts."lodgeBefore" + (SELECT count(*)::int FROM rewritten)`,
      replace: `'lodgeAfter', before_counts."lodgeBefore"`,
    },
  ],
};

/**
 * Wrap a value in a `$fixture$` dollar-quoted literal, so the JSON array of
 * action names below reaches PostgreSQL as the bytes this file states rather
 * than through hand-escaped quotes.
 */
function dollarQuoted(value: string): string {
  if (value.includes("$fixture$")) {
    throw new Error("fixture value contains the dollar-quote tag $fixture$");
  }
  return `$fixture$${value}$fixture$`;
}

export default verification;

