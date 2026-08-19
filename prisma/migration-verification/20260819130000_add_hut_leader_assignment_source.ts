import type { DataMigrationVerification } from "./types";

/**
 * #2926 — the one-off backfill that gives EXISTING hut-leader assignments the
 * provenance the new `source` column carries from now on.
 *
 * WHY THIS ONE NEEDS A REAL DATABASE MORE THAN MOST. The whole point of the
 * column is to stop the teacher carve-out being derived from the member, because
 * `Member.role` is admin-writable and a membership edit was silently removing a
 * LIVE assignment from the hut-leader overlap predicate. This migration is the
 * ONE place that still reads the member — it has to, because rows already in the
 * table carry no provenance — so it is the one place the old defect could sneak
 * back in as a permanent, unrecoverable value. A row wrongly stamped
 * `SCHOOL_BOOKING` here stops blocking for the rest of its life and nothing
 * afterwards will notice.
 *
 * That is why the predicate is `role = 'SCHOOL' AND canLogin = false` rather than
 * `role = 'SCHOOL'`, and why the sharpest row below is `m-org`: a member an admin
 * reclassified as an organisation BEFORE this deploy, who still holds a real
 * hut-leader assignment. `role = 'SCHOOL'` is true of them. Only `canLogin` tells
 * them apart from a teacher — the member editor clears every access role when
 * canLogin is false, so `legacyRoleFromAccessRoles([])` returns `'USER'` and a
 * non-login member cannot come out of that editor holding `'SCHOOL'`. Mutant 1
 * drops that conjunct and this fixture must catch it.
 *
 * WHICH WAY THE PREDICATE ERRS, ON PURPOSE. A teacher row it MISSES stays
 * `MANUAL` and keeps blocking — today's behaviour, merely not yet improved. A row
 * it wrongly MATCHES stops blocking, which is the harm. Every case below is
 * chosen to pin that asymmetry rather than just "the teacher moved".
 *
 * `Member` rows name only the columns the initial migration made NOT NULL without
 * a default (`id`, `email`, `passwordHash`, `firstName`, `lastName`, `updatedAt`)
 * plus the ones under test. `HutLeaderAssignment` rows name `lodgeId` explicitly
 * rather than leaning on the `default_lodge_id()` database default, so the seed
 * does not depend on which lodge an install happens to hold.
 */

const LODGE_SEED = `
  INSERT INTO "Lodge" ("id", "name", "slug", "updatedAt")
  VALUES ('hl-2926-lodge', 'Provenance Lodge', 'hl-2926-lodge', TIMESTAMP '2026-08-19 00:00:00');
`;

/**
 * Five members, each a different answer to "is this a school teacher?".
 *
 *  - `m-teacher`   the shape `school-booking-request.ts` creates: SCHOOL, no login.
 *  - `m-contact`   the school CONTACT member, identical shape, and the reason
 *                  `Member.role` never identified teachers in the first place.
 *                  It owns no assignment, which is exactly the point.
 *  - `m-org`       an ordinary club member an admin reclassified as an
 *                  organisation. SCHOOL, but they can log in.
 *  - `m-user`      a plain member.
 *  - `m-dependant` a non-login adult (family dependant). Not SCHOOL, so the
 *                  `canLogin` half of the predicate cannot be the whole test.
 */
const MEMBER_SEED = `
  INSERT INTO "Member" (
    "id", "email", "passwordHash", "firstName", "lastName",
    "role", "ageTier", "active", "canLogin", "updatedAt"
  )
  VALUES
    ('hl-2926-m-teacher', 'teacher@example.test', 'hash', 'School', 'Teacher',
     'SCHOOL', 'ADULT', true, false, TIMESTAMP '2026-08-19 00:00:00'),
    ('hl-2926-m-contact', 'contact@example.test', 'hash', 'School', 'Contact',
     'SCHOOL', 'ADULT', true, false, TIMESTAMP '2026-08-19 00:00:00'),
    ('hl-2926-m-org', 'org@example.test', 'hash', 'Reclassified', 'Organisation',
     'SCHOOL', 'ADULT', true, true, TIMESTAMP '2026-08-19 00:00:00'),
    ('hl-2926-m-user', 'user@example.test', 'hash', 'Ordinary', 'Member',
     'USER', 'ADULT', true, true, TIMESTAMP '2026-08-19 00:00:00'),
    ('hl-2926-m-dependant', 'dependant@example.test', 'hash', 'Non', 'Login',
     'USER', 'ADULT', true, false, TIMESTAMP '2026-08-19 00:00:00');
`;

const ASSIGNMENT_COLUMNS = `
  "id", "memberId", "startDate", "endDate", "hutLeaderPin", "lodgeId",
  "createdAt", "updatedAt"
`;

const verification: DataMigrationVerification = {
  migration: "20260819130000_add_hut_leader_assignment_source",
  intent:
    "Give every existing HutLeaderAssignment a provenance value: SCHOOL_BOOKING for the rows the school-approval path created — recognised, this once only, by their member being a non-login SCHOOL record — and MANUAL for every other row, including a row held by a member an admin has since reclassified as an organisation. Change no other column on any row.",
  // The migration contains CREATE TYPE and ADD COLUMN, neither of which is
  // re-runnable, so this cannot be claimed. The DML half is convergent on its
  // own (its predicate does not depend on `source`), but the file as a whole
  // fails 42710/42701 before reaching it on a second run.
  idempotentReRun: false,
  cases: [
    {
      name: "a club with school teachers, a reclassified organisation member, a plain member and a non-login dependant all holding assignments",
      seed: `
        ${LODGE_SEED}
        ${MEMBER_SEED}
        INSERT INTO "HutLeaderAssignment" (${ASSIGNMENT_COLUMNS})
        VALUES
          ('hl-2926-a-teacher', 'hl-2926-m-teacher', DATE '2099-04-10', DATE '2099-04-20',
           'pin-teacher', 'hl-2926-lodge',
           TIMESTAMP '2026-08-01 01:02:03', TIMESTAMP '2026-08-02 04:05:06'),
          ('hl-2926-a-org', 'hl-2926-m-org', DATE '2099-04-10', DATE '2099-04-20',
           'pin-org', 'hl-2926-lodge',
           TIMESTAMP '2026-08-01 01:02:03', TIMESTAMP '2026-08-02 04:05:06'),
          ('hl-2926-a-user', 'hl-2926-m-user', DATE '2099-05-10', DATE '2099-05-20',
           'pin-user', 'hl-2926-lodge',
           TIMESTAMP '2026-08-01 01:02:03', TIMESTAMP '2026-08-02 04:05:06'),
          ('hl-2926-a-dependant', 'hl-2926-m-dependant', DATE '2099-06-10', DATE '2099-06-20',
           NULL, 'hl-2926-lodge',
           TIMESTAMP '2026-08-01 01:02:03', TIMESTAMP '2026-08-02 04:05:06');
      `,
      expectations: [
        {
          claim:
            "Only the teacher's row is stamped SCHOOL_BOOKING. The reclassified organisation member keeps MANUAL — their live assignment must stay in the overlap predicate — and so do the plain member and the non-login dependant.",
          sql: `
            SELECT "id", "source"::text AS "source"
            FROM "HutLeaderAssignment"
            WHERE "id" LIKE 'hl-2926-%'
            ORDER BY "id"
          `,
          rows: [
            { id: "hl-2926-a-dependant", source: "MANUAL" },
            { id: "hl-2926-a-org", source: "MANUAL" },
            { id: "hl-2926-a-teacher", source: "SCHOOL_BOOKING" },
            { id: "hl-2926-a-user", source: "MANUAL" },
          ],
        },
        {
          claim:
            "Exactly one row in the whole table is SCHOOL_BOOKING, so the statement reached no row this fixture did not name — the school CONTACT member, which shares the teacher's member shape exactly, owns no assignment for it to reach.",
          sql: `
            SELECT count(*)::int AS "schoolSourced"
            FROM "HutLeaderAssignment"
            WHERE "source" = 'SCHOOL_BOOKING'
          `,
          rows: [{ schoolSourced: 1 }],
        },
        {
          claim:
            "Every other column on the rewritten teacher row is byte-identical, updatedAt above all: raw SQL bypasses Prisma's @updatedAt, and moving it would make every teacher assignment look as though somebody had just edited the roster.",
          sql: `
            SELECT
              "memberId",
              to_char("startDate", 'YYYY-MM-DD') AS "startDate",
              to_char("endDate", 'YYYY-MM-DD') AS "endDate",
              "hutLeaderPin",
              "lodgeId",
              "bedId",
              to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
              to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
            FROM "HutLeaderAssignment"
            WHERE "id" = 'hl-2926-a-teacher'
          `,
          rows: [
            {
              memberId: "hl-2926-m-teacher",
              startDate: "2099-04-10",
              endDate: "2099-04-20",
              hutLeaderPin: "pin-teacher",
              lodgeId: "hl-2926-lodge",
              bedId: null,
              createdAt: "2026-08-01 01:02:03",
              updatedAt: "2026-08-02 04:05:06",
            },
          ],
        },
        {
          claim:
            "No member row is touched. The migration reads Member and writes only HutLeaderAssignment, so a reclassified member's own record is exactly as the club left it.",
          sql: `
            SELECT "id", "role"::text AS "role", "canLogin",
                   to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
            FROM "Member"
            WHERE "id" LIKE 'hl-2926-m-%'
            ORDER BY "id"
          `,
          rows: [
            { id: "hl-2926-m-contact", role: "SCHOOL", canLogin: false, updatedAt: "2026-08-19 00:00:00" },
            { id: "hl-2926-m-dependant", role: "USER", canLogin: false, updatedAt: "2026-08-19 00:00:00" },
            { id: "hl-2926-m-org", role: "SCHOOL", canLogin: true, updatedAt: "2026-08-19 00:00:00" },
            { id: "hl-2926-m-teacher", role: "SCHOOL", canLogin: false, updatedAt: "2026-08-19 00:00:00" },
            { id: "hl-2926-m-user", role: "USER", canLogin: true, updatedAt: "2026-08-19 00:00:00" },
          ],
        },
      ],
    },
    {
      name: "a club that has never taken a school booking",
      seed: `
        ${LODGE_SEED}
        INSERT INTO "Member" (
          "id", "email", "passwordHash", "firstName", "lastName",
          "role", "ageTier", "active", "canLogin", "updatedAt"
        )
        VALUES ('hl-2926-solo', 'solo@example.test', 'hash', 'Only', 'Leader',
                'USER', 'ADULT', true, true, TIMESTAMP '2026-08-19 00:00:00');
        INSERT INTO "HutLeaderAssignment" (${ASSIGNMENT_COLUMNS})
        VALUES ('hl-2926-a-solo', 'hl-2926-solo', DATE '2099-04-10', DATE '2099-04-20',
                'pin-solo', 'hl-2926-lodge',
                TIMESTAMP '2026-08-01 01:02:03', TIMESTAMP '2026-08-02 04:05:06');
      `,
      expectations: [
        {
          claim:
            "The one assignment stays MANUAL. An install with no school bookings gains the column and nothing else changes about it.",
          sql: `
            SELECT "id", "source"::text AS "source"
            FROM "HutLeaderAssignment"
            WHERE "id" LIKE 'hl-2926-%'
            ORDER BY "id"
          `,
          rows: [{ id: "hl-2926-a-solo", source: "MANUAL" }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "backfill on the member's role alone, dropping the canLogin conjunct",
      harm:
        "This is the defect #2926 exists to prevent, made permanent. A member an admin reclassified as an organisation before the deploy is stamped SCHOOL_BOOKING, so their LIVE hut-leader assignment leaves the overlap predicate forever and a second overlapping leader can be created for those nights at that lodge. Nothing afterwards re-derives the value, so nothing ever notices.",
      find: `  AND m."canLogin" = false;`,
      replace: `;`,
    },
    {
      name: "make SCHOOL_BOOKING the column default",
      harm:
        "Every assignment already in the table — every officer-assigned leader on the roster — stops blocking, so the overlap rule the club relies on is silently switched off for all historical rows.",
      find: `NOT NULL DEFAULT 'MANUAL'`,
      replace: `NOT NULL DEFAULT 'SCHOOL_BOOKING'`,
    },
    {
      name: "match a role no member holds, so the backfill reaches nothing",
      harm:
        "Existing teacher rows keep blocking. This is the SAFE direction and would not break anything — which is exactly why it needs a mutant: without one, a fixture could pass while proving only that the column was added.",
      find: `  AND m."role" = 'SCHOOL'`,
      replace: `  AND m."role" = 'ADMIN'`,
    },
    {
      name: "stamp the wrong provenance value",
      harm:
        "Teacher rows are recorded as cron-created. They keep blocking (so nothing looks broken today) while the column now lies about who created them, which is the one thing every later reader of it trusts.",
      find: `SET "source" = 'SCHOOL_BOOKING'`,
      replace: `SET "source" = 'CRON'`,
    },
  ],
};

export default verification;
