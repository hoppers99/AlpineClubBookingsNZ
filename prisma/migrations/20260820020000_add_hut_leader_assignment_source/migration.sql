-- #2926: give every hut-leader assignment a PROVENANCE the roster owns, so the
-- overlap predicate can exclude school-teacher rows without asking the member
-- what they are today.
--
-- WHY A COLUMN AND NOT A MEMBER LOOKUP. The predicate needs to answer "was this
-- row created as part of a school booking?". Every property of the MEMBER that
-- correlates with that answer today is admin-writable:
--   * `Member.role` is DERIVED. `legacyRoleFromAccessRoles` (src/lib/access-roles.ts)
--     maps the ORG access role to the legacy value 'SCHOOL', and the member
--     editor's User Type control grants ORG through `accessRoleTokensForUserType`
--     — a `membership:edit` admin, no Full Admin needed.
--   * The access roles themselves are that same control's output, and picking
--     "organisation" returns exactly `["ORG"]`, DROPPING `USER`.
-- So both candidate member-side discriminators break identically: reclassify a
-- plain member who holds a live hut-leader assignment as an organisation, and
-- that live assignment DISAPPEARS from the overlap check for every writer — an
-- admin or the cron can then create a second overlapping leader for those nights
-- at that lodge. A membership edit would break a roster invariant it never
-- touched. The first attempt at #2887 shipped exactly that and was reverted.
--
-- `source` is written ONCE, by whichever writer inserted the row, and by nothing
-- afterwards. There is no UPDATE of it anywhere in `src/`, so no membership edit
-- can move it.
--
-- STATEMENT 1 — the enum. `CREATE TYPE` is additive: it introduces a type the
-- draining old colour has never heard of and cannot be asked about.
--
-- STATEMENT 2 — the column. NOT NULL with a CONSTANT default, which PostgreSQL
-- 11+ stores as catalog metadata (`pg_attribute.atthasmissing`) and does NOT
-- rewrite the heap for. The brief ACCESS EXCLUSIVE lock is the catalog change
-- only. "HutLeaderAssignment" holds one row per leader per stay — hundreds, not
-- millions — and is absent from HOT_TABLE_SQL_REGEX.
--   MANUAL is the right default for the same reason it is the right default in
--   `schema.prisma`: an unstamped row is one this release did not create, and
--   "assume an officer put it there" is the answer that keeps it BLOCKING. The
--   safe direction for this whole change is to over-block, never to under-block.
--
-- STATEMENT 3 — the backfill, and the one place this migration relies on the
-- very derivation the column exists to escape. SAY IT PLAINLY: existing rows
-- carry no provenance, so the only way to recognise a teacher row already in the
-- table is the member's CURRENT classification. That is acceptable HERE and
-- nowhere else, because it is a one-off point-in-time snapshot rather than a
-- live predicate: whatever an admin does to a member afterwards, this row's
-- `source` never moves again.
--   THE PREDICATE IS DELIBERATELY NARROWER THAN `role = 'SCHOOL'`. It also
--   requires `canLogin = false`, which is the shape the school-approval path
--   creates (`src/lib/school-booking-request.ts` — teachers are created
--   `role: "SCHOOL", canLogin: false`) and a shape the member editor CANNOT
--   produce: `resolveWriteAccessRoleTokens` clears every access role when
--   canLogin is false, so `legacyRoleFromAccessRoles([])` returns 'USER' and a
--   non-login member cannot come out of the editor holding 'SCHOOL'. The
--   codebase already treats the pair this way — `admin-members-service.ts`
--   resolves the ORG member-list filter to `{ role: "SCHOOL", canLogin: true }`.
--   And the admin POST could never have created a row for a canLogin=false
--   member in the first place: it requires `hasAccessRole(member, "USER")`,
--   which is empty for a non-login member.
--   WHICH WAY IT ERRS, ON PURPOSE. A row this predicate MISSES stays 'MANUAL'
--   and keeps blocking — today's behaviour, merely not yet improved. A row it
--   wrongly MATCHES stops blocking, which is the actual harm. So the predicate
--   is written to miss rather than to over-reach.
--   THE SCHOOL CONTACT IS NOT A CONCERN HERE even though it shares the
--   `role='SCHOOL', canLogin=false` shape: the contact member is the booking
--   OWNER and is never given a hut-leader assignment, so it owns no row for this
--   statement to match.
--
-- NOT TOUCHED: `updatedAt`. Raw SQL bypasses Prisma's `@updatedAt`, and moving
-- it would make every teacher assignment look as though somebody had just edited
-- the roster. The fixture asserts every other column is byte-identical.
--
-- NO SESSION CLOCK: no `now()` and no `CURRENT_TIMESTAMP` anywhere, so the
-- #1627 DML gate is satisfied.
--
-- OLD-COLOUR COMPATIBLE IN BOTH DIRECTIONS. Forward: the previously deployed
-- Prisma client does not know `source`, so it neither selects it nor writes it;
-- its omitted-column INSERT takes the database default 'MANUAL', and its overlap
-- predicate keeps matching on dates and lodge exactly as it does today — which
-- means the old colour keeps letting teacher rows block, the behaviour it has
-- always had. Reverse: dropping the column and the type returns the schema to
-- its previous shape and loses only the provenance, which nothing older reads.
--
-- DATA VERIFICATION:
-- prisma/migration-verification/20260820020000_add_hut_leader_assignment_source.ts

CREATE TYPE "HutLeaderAssignmentSource" AS ENUM ('MANUAL', 'CRON', 'SCHOOL_BOOKING');

ALTER TABLE "HutLeaderAssignment"
  ADD COLUMN "source" "HutLeaderAssignmentSource" NOT NULL DEFAULT 'MANUAL';

UPDATE "HutLeaderAssignment" AS a
SET "source" = 'SCHOOL_BOOKING'
FROM "Member" AS m
WHERE m."id" = a."memberId"
  AND m."role" = 'SCHOOL'
  AND m."canLogin" = false;
