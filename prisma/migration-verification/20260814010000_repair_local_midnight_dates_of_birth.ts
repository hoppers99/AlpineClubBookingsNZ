import type { DataMigrationVerification } from "./types";

/**
 * #2859 — the dates of birth the Xero import stored a day early.
 *
 * This migration rewrites member PERSONAL DATA, in place, with no undo, on a
 * column that drives age tier and therefore pricing and hosting eligibility. It
 * is also keyed on a SHAPE — the stored time-of-day — rather than on a marker
 * anybody wrote deliberately, so every property the safety argument rests on has
 * to be shown against real rows on a real PostgreSQL. None of it is reachable
 * from the empty tables `Migration drift check` uses: the `UPDATE` would match
 * nothing and be proven to parse while proving nothing (#2418).
 *
 * WHAT THE CASES ARE FOR, one property each:
 *
 *  - both defective shapes (NZST `12:00` and NZDT `13:00`) move to UTC midnight
 *    on the day the member was actually born, INCLUDING the 1 January case where
 *    the defect moved the year as well as the day;
 *  - a correctly stored row at `00:00` is not touched — which is the property
 *    that stops the repair from running a second time on data it already fixed;
 *  - the `11:39` row measured in production, which neither defect explains, is
 *    left exactly as it is rather than swept into a shape-matched repair;
 *  - nothing near the boundary is caught by accident: `11:00`, `12:30`, `13:00`
 *    with a non-zero minute, and `12:00` with milliseconds all stay put;
 *  - a member with no date of birth at all is untouched and stays NULL;
 *  - every other column on a rewritten row is byte-identical afterwards —
 *    `ageTier` above all, because a repair that helpfully recomputed it would be
 *    changing a member's price;
 *  - an install with nothing to repair changes nothing, which is what makes the
 *    statement safe to replay after a blue/green cutover.
 *
 * `Member` rows here name only the columns the initial migration made NOT NULL
 * without a default (`id`, `email`, `passwordHash`, `firstName`, `lastName`,
 * `updatedAt`), plus the ones under test. No foreign keys are involved.
 */

/**
 * Both defective shapes, the correct shape, the unexplained outlier, and four
 * near-misses that a looser predicate would swallow.
 *
 * The two `dob-defective-*` rows are the measured live shapes: `12:00` is
 * Pacific/Auckland midnight at +12 (NZST) and `13:00` at +13 (NZDT). The
 * `new-year` row is the year-boundary case — 01/01/2000 was stored as
 * 1999-12-31, so the repair has to carry the year with it.
 */
const memberRows = `(
    'dob-defective-nzst', 'nzst@example.test', 'hash', 'Ada', 'Nzst',
    TIMESTAMP '1985-06-14 12:00:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-defective-nzdt', 'nzdt@example.test', 'hash', 'Bo', 'Nzdt',
    TIMESTAMP '2010-03-14 13:00:00', 'YOUTH', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-defective-new-year', 'newyear@example.test', 'hash', 'Cai', 'Newyear',
    TIMESTAMP '1999-12-31 13:00:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-correct', 'correct@example.test', 'hash', 'Dee', 'Correct',
    TIMESTAMP '1974-09-02 00:00:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-unexplained', 'unexplained@example.test', 'hash', 'Eli', 'Unexplained',
    TIMESTAMP '1968-04-11 11:39:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-near-eleven', 'eleven@example.test', 'hash', 'Fay', 'Eleven',
    TIMESTAMP '1990-05-06 11:00:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-near-half-past', 'halfpast@example.test', 'hash', 'Gus', 'Halfpast',
    TIMESTAMP '1946-01-01 12:30:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-near-minute', 'minute@example.test', 'hash', 'Hal', 'Minute',
    TIMESTAMP '2001-11-30 13:01:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-near-millis', 'millis@example.test', 'hash', 'Ivy', 'Millis',
    TIMESTAMP '1988-07-19 12:00:00.500', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-absent', 'absent@example.test', 'hash', 'Jo', 'Absent',
    NULL, 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  )`;

const verification: DataMigrationVerification = {
  migration: "20260814010000_repair_local_midnight_dates_of_birth",
  intent:
    "Move a stored date of birth whose time-of-day is exactly 12:00:00.000 or 13:00:00.000 UTC — Pacific/Auckland local midnight at +12 and +13, the shape the two defective Xero parsers wrote — forward onto UTC midnight of the day the member was actually born; change no other column on those rows, no row already at UTC midnight, no row whose time-of-day is any other value (including the one measured 11:39 outlier that neither defect explains), and no member without a date of birth.",
  idempotentReRun: true,
  cases: [
    {
      name: "a club carrying both defective shapes, a correctly stored row, the unexplained outlier, and four near-misses",
      seed: `
        INSERT INTO "Member" (
          "id", "email", "passwordHash", "firstName", "lastName",
          "dateOfBirth", "ageTier", "updatedAt"
        )
        VALUES
          ${memberRows};
      `,
      expectations: [
        {
          claim:
            "both defective shapes now sit at UTC midnight on the day the member was actually born, and the 1 January case carried its year across the boundary rather than only its day",
          // Rendered characters, not a raw Date: a naive timestamp(3) is
          // resolved by the pg driver against the CLIENT's zone, so a raw
          // comparison would pass in UTC CI and fail on a Pacific/Auckland
          // machine (types.ts).
          sql: `SELECT "id",
                       to_char("dateOfBirth", 'YYYY-MM-DD HH24:MI:SS.MS') AS "dateOfBirth"
                  FROM "Member"
                 WHERE "id" LIKE 'dob-defective-%'
                 ORDER BY "id"`,
          rows: [
            {
              id: "dob-defective-new-year",
              dateOfBirth: "2000-01-01 00:00:00.000",
            },
            {
              id: "dob-defective-nzdt",
              dateOfBirth: "2010-03-15 00:00:00.000",
            },
            {
              id: "dob-defective-nzst",
              dateOfBirth: "1985-06-15 00:00:00.000",
            },
          ],
        },
        {
          claim:
            "the correctly stored row, the unexplained 11:39 row, and all four near-misses hold exactly the instant they were written with — 11:00 and 12:30 are not New Zealand local midnights for any offset the zone has held, a non-zero minute is not local midnight either, and neither is 12:00 plus half a second",
          sql: `SELECT "id",
                       to_char("dateOfBirth", 'YYYY-MM-DD HH24:MI:SS.MS') AS "dateOfBirth"
                  FROM "Member"
                 WHERE "id" IN ('dob-correct', 'dob-unexplained', 'dob-near-eleven',
                                'dob-near-half-past', 'dob-near-minute', 'dob-near-millis')
                 ORDER BY "id"`,
          rows: [
            { id: "dob-correct", dateOfBirth: "1974-09-02 00:00:00.000" },
            { id: "dob-near-eleven", dateOfBirth: "1990-05-06 11:00:00.000" },
            { id: "dob-near-half-past", dateOfBirth: "1946-01-01 12:30:00.000" },
            { id: "dob-near-millis", dateOfBirth: "1988-07-19 12:00:00.500" },
            { id: "dob-near-minute", dateOfBirth: "2001-11-30 13:01:00.000" },
            { id: "dob-unexplained", dateOfBirth: "1968-04-11 11:39:00.000" },
          ],
        },
        {
          claim:
            "a member with no date of birth still has none — a repair that coalesced NULL into a day would invent a birthday, and would hand that member an age tier",
          sql: `SELECT "id", "dateOfBirth" FROM "Member" WHERE "id" = 'dob-absent'`,
          rows: [{ id: "dob-absent", dateOfBirth: null }],
        },
        {
          claim:
            "exactly four rows sit at UTC midnight afterwards — the three that were repaired plus the one that was already correct. The per-row assertions above could all hold while some row nobody named was rewritten as well; this counts the whole table",
          sql: `SELECT count(*)::int AS "atUtcMidnight"
                  FROM "Member"
                 WHERE "dateOfBirth" IS NOT NULL
                   AND "dateOfBirth" = date_trunc('day', "dateOfBirth")`,
          rows: [{ atUtcMidnight: 4 }],
        },
        {
          claim:
            "not one defective row is left behind: no stored date of birth is still at a New Zealand local midnight",
          sql: `SELECT "id" FROM "Member"
                 WHERE "dateOfBirth" IS NOT NULL
                   AND date_part('hour', "dateOfBirth") IN (12, 13)
                   AND date_part('minute', "dateOfBirth") = 0
                   AND date_part('second', "dateOfBirth") = 0
                 ORDER BY "id"`,
          rows: [],
        },
      ],
    },
    {
      name: "one repaired row carrying the columns a repair must not touch",
      seed: `
        INSERT INTO "Member" (
          "id", "email", "passwordHash", "firstName", "lastName",
          "dateOfBirth", "ageTier", "role", "active", "canLogin",
          "xeroContactId", "joinedDate", "updatedAt"
        )
        VALUES (
          'dob-full-row', 'full@example.test', 'hash', 'Kit', 'Fullrow',
          TIMESTAMP '2008-03-31 13:00:00', 'YOUTH', 'USER', true, false,
          'contact-1', TIMESTAMP '2019-02-01 00:00:00',
          TIMESTAMP '2026-08-14 00:00:00'
        );
      `,
      expectations: [
        {
          claim:
            "only `dateOfBirth` changed. `ageTier` in particular is byte-identical — recomputing it here would look conscientious and would silently change what this member is charged and whether they may host, from a migration nobody would think to check for a pricing change",
          sql: `SELECT "firstName", "lastName", "ageTier", "role", "active",
                       "canLogin", "xeroContactId",
                       to_char("joinedDate", 'YYYY-MM-DD HH24:MI:SS.MS') AS "joinedDate",
                       to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "updatedAt",
                       to_char("dateOfBirth", 'YYYY-MM-DD HH24:MI:SS.MS') AS "dateOfBirth"
                  FROM "Member" WHERE "id" = 'dob-full-row'`,
          rows: [
            {
              firstName: "Kit",
              lastName: "Fullrow",
              ageTier: "YOUTH",
              role: "USER",
              active: true,
              canLogin: false,
              xeroContactId: "contact-1",
              joinedDate: "2019-02-01 00:00:00.000",
              updatedAt: "2026-08-14 00:00:00.000",
              dateOfBirth: "2008-04-01 00:00:00.000",
            },
          ],
        },
      ],
    },
    {
      name: "an install with nothing to repair — the shape a replay after cutover meets, and the shape every non-Tokoroa deployment is in",
      seed: `
        INSERT INTO "Member" (
          "id", "email", "passwordHash", "firstName", "lastName",
          "dateOfBirth", "updatedAt"
        )
        VALUES
          ('dob-replay-correct', 'replay@example.test', 'hash', 'Lou', 'Replay',
           TIMESTAMP '1992-10-05 00:00:00', TIMESTAMP '2026-08-14 00:00:00'),
          ('dob-replay-none', 'replaynone@example.test', 'hash', 'Mo', 'Replaynone',
           NULL, TIMESTAMP '2026-08-14 00:00:00');
      `,
      expectations: [
        {
          claim:
            "nothing moved. A row already at UTC midnight can never match the predicate again, which is what lets an operator run this statement a second time after a blue/green cutover without walking every date of birth forward another day",
          sql: `SELECT "id",
                       to_char("dateOfBirth", 'YYYY-MM-DD HH24:MI:SS.MS') AS "dateOfBirth"
                  FROM "Member" WHERE "id" LIKE 'dob-replay-%' ORDER BY "id"`,
          rows: [
            { id: "dob-replay-correct", dateOfBirth: "1992-10-05 00:00:00.000" },
            { id: "dob-replay-none", dateOfBirth: null },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "match a RANGE of hours instead of the two exact local-midnight offsets",
      harm:
        "This is the shortcut the issue explicitly forbids. `BETWEEN 11 AND 13` reads as generous and sweeps in the one measured production row at 11:39 — a value no New Zealand offset explains, which nothing in this statement can know the intended day of. It would be shifted to a day chosen by arithmetic on a number nobody understands, permanently, with no undo, on a member's personal data. It also catches the 11:00 near-miss.",
      find: `   AND date_part('hour', "dateOfBirth") IN (12, 13)
   AND date_part('minute', "dateOfBirth") = 0
   AND date_part('second', "dateOfBirth") = 0;`,
      replace: `   AND date_part('hour', "dateOfBirth") BETWEEN 11 AND 13;`,
    },
    {
      name: "truncate to the day without adding the offset back first",
      harm:
        "Turns the defect into a permanent one. Every affected member keeps the day they were WRONGLY recorded as born on, now stored at UTC midnight so it looks correct and is indistinguishable from a row that was always right. The repair would report success having destroyed the only evidence of what it was repairing.",
      find: `SET "dateOfBirth" = date_trunc('day', "dateOfBirth" + INTERVAL '12 hours')`,
      replace: `SET "dateOfBirth" = date_trunc('day', "dateOfBirth")`,
    },
    {
      name: "add a whole day instead of the offset, then truncate",
      harm:
        "Correct for the NZST (+12) rows and a day late for every NZDT (+13) row: 1999-12-31 13:00 becomes 2000-01-02. 120 of the 364 affected members would end up one day AFTER their birthday, which is the same class of error this migration exists to undo and is far harder to spot once the obviously-wrong shape is gone.",
      find: `INTERVAL '12 hours'`,
      replace: `INTERVAL '24 hours'`,
    },
    {
      name: "drop the millisecond precision by comparing only whole seconds",
      harm:
        "`date_part('second', ...)` returns the fractional seconds too, so the predicate as written excludes 12:00:00.500. Flooring it admits any sub-second value into a repair whose whole claim is that the matched shape is exactly a local midnight — the row would be moved on the strength of a shape it does not have.",
      find: `   AND date_part('second', "dateOfBirth") = 0;`,
      replace: `   AND floor(date_part('second', "dateOfBirth")) = 0;`,
    },
  ],
};

export default verification;
