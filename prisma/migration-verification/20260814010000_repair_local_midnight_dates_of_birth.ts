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
 * THE DEFECTIVE HOURS. A New Zealand local midnight is stored as
 * `(local 00:00 - offset)`, so the defect writes the PREVIOUS day at 11:00 UTC
 * for a daylight-time birthday (+13) and 12:00 UTC for a standard-time one
 * (+12) — which is what #2859 states, what its two worked examples show, and
 * what production holds: six rows at `11:00` and four at `12:00`, out of 375
 * members with a date of birth. A `13:00` bucket was reported once and is
 * retracted; that census applied `AT TIME ZONE` to a naive column and read it
 * back through the session zone, which inverted it. The migration still matches
 * 13 as a known-inert safety margin, so a row is seeded there too — an arm
 * nobody exercises is an arm nobody can trust.
 *
 * WHAT THE CASES ARE FOR, one property each:
 *
 *  - all three matched hours move to UTC midnight on the day the member was
 *    actually born, INCLUDING both year-boundary cases where the defect moved
 *    the year as well as the day;
 *  - a correctly stored row at `00:00` is not touched — the property that stops
 *    the repair running a second time on data it already fixed;
 *  - nothing near the boundary is caught by accident: `10:00`, `12:30`, a
 *    non-zero minute (on two different hours), a non-zero whole second and a
 *    non-zero millisecond all stay put;
 *  - a member with no date of birth at all is untouched and stays NULL;
 *  - every other column on a rewritten row is byte-identical afterwards —
 *    `ageTier` above all, because a repair that helpfully recomputed it would be
 *    changing a member's price;
 *  - an install with nothing to repair changes nothing, which is what makes the
 *    statement safe to replay after a blue/green cutover.
 *
 * WHY THE `11:00` ROWS ARE THE SHARP ONES. `date_trunc('day', t + N hours)` on
 * a row at hour H lands on day `D + floor((H+N)/24)`, so on hours 12 and 13
 * EVERY interval from 12 to 34 hours produces the same answer — 12, 13 and 24
 * are literally the same program there, and no assertion on those rows can tell
 * them apart. Only an `11:00` row separates them: `11+13 = 24` crosses the day,
 * `11+12 = 23` does not. That single row is what gives the `12 hours` mutant
 * below its teeth, and its absence is why the first version of this migration
 * shipped an interval that would have left the whole daylight-time population a
 * day early, rewritten to UTC midnight ON the wrong day and undetectable
 * afterwards.
 *
 * `Member` rows here name only the columns the initial migration made NOT NULL
 * without a default (`id`, `email`, `passwordHash`, `firstName`, `lastName`,
 * `updatedAt`), plus the ones under test. No foreign keys are involved.
 */

/**
 * Every shape, seeded together so one pre-state proves both what moves and what
 * does not.
 *
 * The two `nzdt` rows carry 11:00 — the daylight-time shape, and the hour that
 * separates a correct interval from the plausible wrong one. `synthetic-1300`
 * covers the migration's inert 13 arm: no such row exists in production, and an
 * arm no fixture exercises is one nobody can trust. The two `new-year` rows are
 * the year-boundary cases, one per offset. The four `near-` rows are SYNTHETIC
 * near-misses, not observed production values — they exist to pin what the
 * predicate refuses.
 */
const memberRows = `(
    'dob-nzst-1200', 'nzst@example.test', 'hash', 'Ada', 'Nzst',
    TIMESTAMP '1985-06-14 12:00:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-nzdt-1100', 'nzdt@example.test', 'hash', 'Bo', 'Nzdt',
    TIMESTAMP '2010-03-14 11:00:00', 'YOUTH', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-nzdt-1100-new-year', 'nzdtny@example.test', 'hash', 'Cai', 'Nzdtnewyear',
    TIMESTAMP '1999-12-31 11:00:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-nzst-1200-new-year', 'nzstny@example.test', 'hash', 'Dee', 'Nzstnewyear',
    TIMESTAMP '1969-12-31 12:00:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-synthetic-1300', 'synthetic13@example.test', 'hash', 'Eli', 'Synthetic',
    TIMESTAMP '2001-07-05 13:00:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-correct', 'correct@example.test', 'hash', 'Fay', 'Correct',
    TIMESTAMP '1974-09-02 00:00:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-near-minute-at-eleven', 'nearminute11@example.test', 'hash', 'Gus', 'Nearminute',
    TIMESTAMP '1968-04-11 11:39:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-near-second', 'nearsecond@example.test', 'hash', 'Hal', 'Nearsecond',
    TIMESTAMP '1867-05-20 12:20:56', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-near-ten', 'ten@example.test', 'hash', 'Ivy', 'Ten',
    TIMESTAMP '1990-05-06 10:00:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-near-half-past', 'halfpast@example.test', 'hash', 'Jo', 'Halfpast',
    TIMESTAMP '1946-01-01 12:30:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-near-minute', 'minute@example.test', 'hash', 'Kit', 'Minute',
    TIMESTAMP '2001-11-30 13:01:00', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-near-millis', 'millis@example.test', 'hash', 'Lou', 'Millis',
    TIMESTAMP '1988-07-19 12:00:00.500', 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  ),
  (
    'dob-absent', 'absent@example.test', 'hash', 'Mo', 'Absent',
    NULL, 'ADULT', TIMESTAMP '2026-08-14 00:00:00'
  )`;

const verification: DataMigrationVerification = {
  migration: "20260814010000_repair_local_midnight_dates_of_birth",
  intent:
    "Move a stored date of birth whose time-of-day is exactly 11:00:00.000, 12:00:00.000 or 13:00:00.000 UTC — the New Zealand local-midnight shapes the two defective Xero parsers wrote (11 and 12 measured in production, 13 a known-inert safety margin) — forward onto UTC midnight of the day the member was actually born; change no other column on those rows, no row already at UTC midnight, no row whose time-of-day is any other value, and no member without a date of birth.",
  idempotentReRun: true,
  cases: [
    {
      name: "a club carrying both measured defective hours and the inert third, both year boundaries, a correctly stored row, and four near-misses",
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
            "all three matched hours now sit at UTC midnight on the day the member was actually born. The two 11:00 rows are the daylight-time shape #2859's own worked example gives (01/01/2000 stored as 1999-12-31 11:00), and they are the only rows that can distinguish a correct 13-hour interval from a 12-hour one",
          // Rendered characters, not a raw Date: a naive timestamp(3) is
          // resolved by the pg driver against the CLIENT's zone, so a raw
          // comparison would pass in UTC CI and fail on a Pacific/Auckland
          // machine (types.ts).
          sql: `SELECT "id",
                       to_char("dateOfBirth", 'YYYY-MM-DD HH24:MI:SS.MS') AS "dateOfBirth"
                  FROM "Member"
                 WHERE "id" IN ('dob-nzst-1200', 'dob-nzdt-1100',
                                'dob-nzdt-1100-new-year', 'dob-nzst-1200-new-year',
                                'dob-synthetic-1300')
                 ORDER BY "id" COLLATE "C"`,
          // ROWS ARE COMPARED IN ORDER, so this array is sorted by `id` in C
          // (byte) order and must be RE-SORTED whenever a row is renamed. That
          // is not hypothetical: renaming `dob-measured-1300` to
          // `dob-synthetic-1300` moved it from the front of this list to the
          // back, and only the real-PostgreSQL job could see it.
          rows: [
            {
              id: "dob-nzdt-1100",
              dateOfBirth: "2010-03-15 00:00:00.000",
            },
            {
              // The year boundary, on the offset that actually produces it.
              id: "dob-nzdt-1100-new-year",
              dateOfBirth: "2000-01-01 00:00:00.000",
            },
            {
              id: "dob-nzst-1200",
              dateOfBirth: "1985-06-15 00:00:00.000",
            },
            {
              id: "dob-nzst-1200-new-year",
              dateOfBirth: "1970-01-01 00:00:00.000",
            },
            {
              id: "dob-synthetic-1300",
              dateOfBirth: "2001-07-06 00:00:00.000",
            },
          ],
        },
        {
          claim:
            "the correctly stored row and all six near-misses hold exactly the instant they were written with. These are SYNTHETIC shapes, not observed production values — they exist to pin what the predicate refuses. 10:00 is no New Zealand offset; 12:30 would be a genuine local midnight under New Zealand Mean Time (+11:30, 1868-1941) but no row was measured there and repairing an unmeasured shape is the guess this migration refuses; a non-zero minute is not a local midnight on hour 11 or on hour 13; neither is a non-zero whole second, nor 12:00 plus half a millisecond-bearing second",
          sql: `SELECT "id",
                       to_char("dateOfBirth", 'YYYY-MM-DD HH24:MI:SS.MS') AS "dateOfBirth"
                  FROM "Member"
                 WHERE "id" IN ('dob-correct', 'dob-near-minute-at-eleven', 'dob-near-second',
                                'dob-near-ten', 'dob-near-half-past',
                                'dob-near-minute', 'dob-near-millis')
                 ORDER BY "id" COLLATE "C"`,
          // Sorted by `id` in C (byte) order — see the note on the readback
          // above. The two renamed rows sort into the MIDDLE of this list, not
          // at the end where their old `dob-outlier-*` names put them.
          rows: [
            { id: "dob-correct", dateOfBirth: "1974-09-02 00:00:00.000" },
            { id: "dob-near-half-past", dateOfBirth: "1946-01-01 12:30:00.000" },
            { id: "dob-near-millis", dateOfBirth: "1988-07-19 12:00:00.500" },
            { id: "dob-near-minute", dateOfBirth: "2001-11-30 13:01:00.000" },
            { id: "dob-near-minute-at-eleven", dateOfBirth: "1968-04-11 11:39:00.000" },
            { id: "dob-near-second", dateOfBirth: "1867-05-20 12:20:56.000" },
            { id: "dob-near-ten", dateOfBirth: "1990-05-06 10:00:00.000" },
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
            "exactly six rows sit at UTC midnight afterwards — the five that were repaired plus the one that was already correct. The per-row assertions above could all hold while some row nobody named was rewritten as well; this counts the whole table",
          sql: `SELECT count(*)::int AS "atUtcMidnight"
                  FROM "Member"
                 WHERE "dateOfBirth" IS NOT NULL
                   AND "dateOfBirth" = date_trunc('day', "dateOfBirth")`,
          rows: [{ atUtcMidnight: 6 }],
        },
        {
          claim:
            "not one defective row is left behind: no stored date of birth is still on a New Zealand local-midnight hour",
          sql: `SELECT "id" FROM "Member"
                 WHERE "dateOfBirth" IS NOT NULL
                   AND date_part('hour', "dateOfBirth") IN (11, 12, 13)
                   AND date_part('minute', "dateOfBirth") = 0
                   AND date_part('second', "dateOfBirth") = 0
                 ORDER BY "id" COLLATE "C"`,
          // Expected empty, so order cannot bite here — pinned anyway, because
          // the day this assertion starts failing is the day it returns rows,
          // and a diff nobody can read is a worse signal than one they can.
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
          'dob-full-row', 'full@example.test', 'hash', 'Nia', 'Fullrow',
          TIMESTAMP '2008-03-31 11:00:00', 'YOUTH', 'USER', true, false,
          'contact-1', TIMESTAMP '2019-02-01 00:00:00',
          TIMESTAMP '2026-08-14 00:00:00'
        );
      `,
      expectations: [
        {
          claim:
            "only `dateOfBirth` changed, and it landed on 1 April 2008 — the season-start anniversary, the one day where an age tier turns on this value. `ageTier` in particular is byte-identical: recomputing it here would look conscientious and would silently change what this member is charged and whether they may host, from a migration nobody would think to check for a pricing change",
          sql: `SELECT "firstName", "lastName", "ageTier", "role", "active",
                       "canLogin", "xeroContactId",
                       to_char("joinedDate", 'YYYY-MM-DD HH24:MI:SS.MS') AS "joinedDate",
                       to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "updatedAt",
                       to_char("dateOfBirth", 'YYYY-MM-DD HH24:MI:SS.MS') AS "dateOfBirth"
                  FROM "Member" WHERE "id" = 'dob-full-row'`,
          rows: [
            {
              firstName: "Nia",
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
          ('dob-replay-correct', 'replay@example.test', 'hash', 'Oli', 'Replay',
           TIMESTAMP '1992-10-05 00:00:00', TIMESTAMP '2026-08-14 00:00:00'),
          ('dob-replay-none', 'replaynone@example.test', 'hash', 'Pip', 'Replaynone',
           NULL, TIMESTAMP '2026-08-14 00:00:00');
      `,
      expectations: [
        {
          claim:
            "nothing moved. A row already at UTC midnight can never match the predicate again, which is what lets an operator run this statement a second time after a blue/green cutover without walking every date of birth forward another day",
          sql: `SELECT "id",
                       to_char("dateOfBirth", 'YYYY-MM-DD HH24:MI:SS.MS') AS "dateOfBirth"
                  FROM "Member" WHERE "id" LIKE 'dob-replay-%'
                 ORDER BY "id" COLLATE "C"`,
          // Sorted by `id` in C (byte) order — "correct" before "none".
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
      name: "add 12 hours instead of 13 — the interval the first version of this migration actually shipped",
      harm:
        "Silently abandons the entire New Zealand DAYLIGHT-time population. `date_trunc('day', t + N hours)` lands on day D + floor((H+N)/24), so at H=11 an interval of 12 reaches only 23:00 on the SAME day: those rows keep the wrong day and are rewritten to UTC midnight ON it, which is precisely the shape of a row that was always correct. Six of the ten affected members would be left a day early, permanently, with the evidence of the defect destroyed and no shape left to find them by — and the repair would report having fixed them. This is the most dangerous edit available here because it is not hypothetical: it is what was written first, and only an 11:00 row can tell the two apart.",
      find: `SET "dateOfBirth" = date_trunc('day', "dateOfBirth" + INTERVAL '13 hours')`,
      replace: `SET "dateOfBirth" = date_trunc('day', "dateOfBirth" + INTERVAL '12 hours')`,
    },
    {
      name: "add the offset back but forget to truncate",
      harm:
        "The mirror image, and it reads as the obvious implementation: 'just add the offset back'. It is exactly right for the 11:00 rows and leaves every 12:00 and 13:00 row an hour or two PAST midnight — the correct day, but no longer a date-only value. That re-creates a third stored shape on a column whose whole contract is UTC midnight (INV-DATE-024), so the next reader that formats it west of UTC, or compares it against a date-only bound, is wrong all over again.",
      find: `SET "dateOfBirth" = date_trunc('day', "dateOfBirth" + INTERVAL '13 hours')`,
      replace: `SET "dateOfBirth" = "dateOfBirth" + INTERVAL '13 hours'`,
    },
    {
      name: "truncate to the day without adding the offset at all",
      harm:
        "Turns the defect into a permanent one. Every affected member keeps the day they were WRONGLY recorded as born on, now stored at UTC midnight so it looks correct and is indistinguishable from a row that was always right. The repair would report success having destroyed the only evidence of what it was repairing.",
      find: `date_trunc('day', "dateOfBirth" + INTERVAL '13 hours')`,
      replace: `date_trunc('day', "dateOfBirth")`,
    },
    {
      name: "match a RANGE of hours instead of the three exact local-midnight offsets",
      harm:
        "This is the shortcut the issue explicitly forbids. `BETWEEN 11 AND 13` reads as generous and drops the claim the whole repair rests on — that a matched row is EXACTLY a local midnight. Any stored value inside those three hours would then be shifted by arithmetic derived from a shape it does not have, permanently, with no undo, on a member's personal data: 11:39, 12:20:56, the 12:30 New Zealand Mean Time shape and the non-zero minute at 13:01 all get swept in, and nothing in this statement can know what day any of them was meant to be.",
      find: `   AND date_part('hour', "dateOfBirth") IN (11, 12, 13)
   AND date_part('minute', "dateOfBirth") = 0
   AND date_part('second', "dateOfBirth") = 0;`,
      replace: `   AND date_part('hour', "dateOfBirth") BETWEEN 11 AND 13;`,
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
