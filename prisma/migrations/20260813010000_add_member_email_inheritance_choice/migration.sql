-- Email inheritance becomes DIRECT-PARENT ONLY, and pointers re-resolve when an
-- address changes (#2716, owner decision on #2708, 9 Aug 2026).
--
-- Two things change together, and the order is load-bearing. A member with no
-- address of their own now inherits from a PARENT and nobody else — never from
-- a grandparent through a middle generation who also has no address. That makes
-- re-resolution a direct parent-to-child lookup rather than a walk up a tree,
-- which is what makes it safe to do automatically instead of behind an admin
-- prompt.
--
-- EXPAND ONLY, additive, old-code compatible. The new column is nullable and no
-- deployed code reads it; a draining old colour keeps reading and writing
-- "inheritEmailFromId" exactly as before. The one behaviour an old colour can
-- still produce — a fresh pointer with no choice beside it — is handled by the
-- new colour's reconciliation, which adopts a one-hop pointer and refuses a
-- transitive one, and which is idempotent and re-runnable over the whole table.
--
-- The backfill is deliberately two statements rather than one. Statement 2
-- records WHO WAS CHOSEN, judged against the pre-migration state (where
-- "inheritEmailChoiceId" is uniformly NULL, so the usability test reduces to
-- exactly the predicate the old resolver used). Statement 3 then derives the
-- EFFECTIVE pointer from that choice, and must see statement 2's writes to do
-- so — a single statement would read its own snapshot and judge every source as
-- if nobody had a choice recorded.

-- 1. The column: who the club CHOSE as this member's email source.
ALTER TABLE "Member" ADD COLUMN "inheritEmailChoiceId" TEXT;

CREATE INDEX "Member_inheritEmailChoiceId_idx" ON "Member"("inheritEmailChoiceId");

ALTER TABLE "Member" ADD CONSTRAINT "Member_inheritEmailChoiceId_fkey"
  FOREIGN KEY ("inheritEmailChoiceId") REFERENCES "Member"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Record the choice behind every pointer that exists today.
--
-- WHICH POINTERS GET RE-SEATED, and why the test is what it is. Only a pointer
-- the retired walk could have produced is moved: the walk climbed from a chosen
-- parent to the nearest ANCESTOR who could receive mail, so a transitive pointer
-- is one that names an ancestor who is not a direct parent, on a member who has
-- a parent link and whose pointer is marked as derived.
--
-- Testing "names an ancestor" rather than merely "is not a parent" is what keeps
-- this from moving somebody's contact of record without being asked. An admin
-- may hand-pick any adult as a member's email source, and on a member who also
-- has parent links such a pointer would otherwise look exactly like a transitive
-- one. Naming an unrelated adult is a pick the walk could never have made, so it
-- is left alone. A hand-pick that happens to name the member's own grandparent
-- is genuinely indistinguishable from a transitive resolution, and is re-seated:
-- the owner's rule is that a grandparent is not a route for a child's mail, so
-- that is the correct reading of the ambiguity rather than a loss.
--
-- "inheritParentEmail" is used here only to NARROW the candidate set, never to
-- widen it, because the column carries DEFAULT true and therefore reads true for
-- every member who was never a dependant at all. The ancestry test is what
-- actually carries the weight: a member with no parent links has no ancestors,
-- so a family-group login cluster — whose adults are pointed at the login holder
-- by hand and none of whom is anyone's parent — can never enter this branch, and
-- records the holder as its choice and keeps its mailbox. An explicit
-- "has a parent link" precondition was written here first and then removed: it
-- was implied by the ancestry test, and a clause that can never change an
-- outcome cannot be proven right by any fixture.
WITH RECURSIVE parent_edge AS (
  SELECT "id" AS child_id, "parentMemberId" AS parent_id
    FROM "Member" WHERE "parentMemberId" IS NOT NULL
  UNION ALL
  SELECT "id", "secondaryParentId"
    FROM "Member" WHERE "secondaryParentId" IS NOT NULL
),
ancestry AS (
  -- Bounded at three parent-links, which is the four-generation family cap
  -- (great-grandparent to child). The bound is also the cycle guard: existing
  -- data predates the cap and may contain a loop, and a bounded walk terminates
  -- on one instead of hanging the deploy.
  SELECT e.child_id AS member_id, e.parent_id AS ancestor_id, 1 AS depth
    FROM parent_edge e
  UNION ALL
  SELECT a.member_id, e.parent_id, a.depth + 1
    FROM ancestry a
    JOIN parent_edge e ON e.child_id = a.ancestor_id
   WHERE a.depth < 3
)
UPDATE "Member" m
SET "inheritEmailChoiceId" = CASE
      WHEN m."inheritParentEmail" = true
       AND m."inheritEmailFromId" IS DISTINCT FROM m."parentMemberId"
       AND m."inheritEmailFromId" IS DISTINCT FROM m."secondaryParentId"
       AND EXISTS (
             SELECT 1 FROM ancestry a
              WHERE a.member_id = m."id"
                AND a.ancestor_id = m."inheritEmailFromId"
           )
      -- TRANSITIVE: re-seat the decision on a DIRECT PARENT, preferring one who
      -- can actually receive mail, and falling back to the primary link when
      -- neither can. Recording the choice even where it currently resolves to
      -- nobody is what lets the pointer restore itself if that parent later
      -- gains an address — without it, a member left unreachable today would
      -- stay unreachable after the address arrived.
      THEN COALESCE(
        (
          SELECT p."id" FROM "Member" p
          WHERE p."id" = m."parentMemberId"
            AND p."ageTier" = 'ADULT'
            AND p."archivedAt" IS NULL
            AND p."inheritEmailFromId" IS NULL
            AND lower(btrim(p."email")) NOT LIKE '%@no-email.invalid'
            AND lower(btrim(p."email")) NOT LIKE '%@deleted.invalid'
        ),
        (
          SELECT s."id" FROM "Member" s
          WHERE s."id" = m."secondaryParentId"
            AND s."ageTier" = 'ADULT'
            AND s."archivedAt" IS NULL
            AND s."inheritEmailFromId" IS NULL
            AND lower(btrim(s."email")) NOT LIKE '%@no-email.invalid'
            AND lower(btrim(s."email")) NOT LIKE '%@deleted.invalid'
        ),
        m."parentMemberId",
        m."secondaryParentId"
      )
      -- EVERYTHING ELSE — already one hop, hand-picked, or naming somebody the
      -- walk could not have reached — keeps the decision it has. The pointer is
      -- the record of that decision, so it becomes the choice verbatim.
      ELSE m."inheritEmailFromId"
    END
WHERE m."inheritEmailFromId" IS NOT NULL;

-- 3. Derive the effective pointer from the choice.
--
-- This is the same total function the application applies from now on, written
-- once in SQL so the tree is already converged when the new colour starts:
--
--   inheritEmailFromId = the choice, while the chosen member can still receive
--                        mail; otherwise NULL.
--
-- A scalar subquery that matches no row yields NULL, so "cleared" and
-- "re-pointed" are the same statement rather than two that could disagree.
-- Members whose pointer clears here are the accepted cost of the one-hop rule:
-- they are reported on the admin "no reachable email address" surface rather
-- than dropped silently, and their choice above is retained so the pointer comes
-- back on its own if the parent's address does.
--
-- "inheritParentEmail" is deliberately NOT touched. It is the PROVENANCE of the
-- decision, not of the current pointer, and unlinking still reads it to decide
-- what to clear (INV-LIFE-052).
--
-- "cancelledAt" is not tested here although the application predicate tests it.
-- The cancellation sweep clears both the pointer and the choice naming a member
-- as it cancels them, so no pre-migration row can name a cancelled member, and a
-- clause that can never change an outcome cannot be proven right by any fixture.
-- The daily reconciliation applies the fuller predicate from the first run
-- onward.
UPDATE "Member" m
SET "inheritEmailFromId" = (
      SELECT c."id" FROM "Member" c
      WHERE c."id" = m."inheritEmailChoiceId"
        AND c."id" <> m."id"
        AND c."ageTier" = 'ADULT'
        AND c."archivedAt" IS NULL
        -- A member who themselves inherits is not a mailbox: their own "email"
        -- column is typically a stale copy of the address they inherit, so
        -- delivering a dependant's notifications to it would send them to
        -- somebody nobody chose. The application's version of this predicate
        -- tests the CHOICE column here as well, because after this migration a
        -- member can hold a choice with no pointer. Inside the migration that
        -- second test could never change an answer — statement 2 records a
        -- choice only where a pointer already exists — so it is not written.
        AND c."inheritEmailFromId" IS NULL
        AND lower(btrim(c."email")) NOT LIKE '%@no-email.invalid'
        AND lower(btrim(c."email")) NOT LIKE '%@deleted.invalid'
    )
WHERE m."inheritEmailFromId" IS NOT NULL
   OR m."inheritEmailChoiceId" IS NOT NULL;
