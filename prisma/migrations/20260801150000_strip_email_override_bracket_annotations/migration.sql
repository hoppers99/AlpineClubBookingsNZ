-- Metadata-only data repair: strip the authoring annotations this project once
-- shipped inside its email default bodies out of every saved
-- EmailTemplateOverride (issue #2269, epic #2245 lane 3 wave 3, F3).
--
-- WHY THIS EXISTS
--
-- Until #2267 (F1) and #2268 (F2), the shipped default bodies carried
-- square-bracketed notes to whoever was reading the template — "Door code:
-- {{doorCode}} [only when a door code is set]". The render path has no
-- conditional syntax: renderTemplateString substitutes {{token}} spans and
-- copies everything else through, so those notes were always destined for a
-- recipient's inbox. F1 and F2 removed them from the code defaults, which heals
-- every club still on defaults, because the defaults are a compiled constant
-- and not seed data.
--
-- A club that had SAVED an override is not healed. prepareEmailMessage prefers
-- override.bodyText unconditionally, so a saved copy keeps its annotations for
-- ever. #2320 (F2's review) added a save-time refusal and an admin banner, so
-- the junk can no longer be re-saved and an admin can see which rows carry it —
-- but a row nobody re-saves keeps sending it. This migration is the other half.
--
-- WHAT IT TOUCHES, AND WHAT IT DELIBERATELY DOES NOT
--
-- #2320's detector treats ANY bracketed span as an authoring note. That is the
-- right rule for refusing a save and for a banner, where the admin decides.
-- It is the wrong rule for a migration that rewrites club-authored content
-- without asking: a club that typed "[see the noticeboard]" into its own
-- wording meant it. So this strips ONLY the four annotation families this
-- project itself shipped, recovered by replaying every historical revision of
-- email-message-registry.ts, email-message-audit-defaults.ts and
-- email-message-notes.ts:
--
--   [only when ...]        the conditional-line notes (the bulk of them)
--   [when ...]             their "and when it did not" siblings
--   [heading becomes ...]  the school attendee-confirmation subject note
--   [falls back to ...]    the school attendee-confirmation body note
--
-- Everything else bracketed survives and keeps appearing in #2320's banner for
-- an admin to resolve deliberately. Semantic drift that needs prose rewritten
-- (the "Discount: -{{discount}}" line #2267 replaced with {{promoSummary}}) is
-- likewise NOT touched here; #2269's staleContent surfaces it in the editor.
--
-- HOW THE STRIP IS DEFINED
--
-- The four regex passes below are the single source of truth, mirrored in
-- SHIPPED_ANNOTATION_STRIP_PATTERNS in src/lib/email-message-token-contract.ts;
-- src/lib/__tests__/email-message-annotation-strip.test.ts reads THIS FILE,
-- asserts the two lists are identical, and runs the fixture corpus through the
-- patterns lifted out of this file. Every construct used means the same thing
-- in PostgreSQL's ARE engine and in JavaScript's (verified against
-- postgres:16): an escape inside a bracket expression, a lookahead, a
-- fixed-width lookbehind, and ^/$ as start/end of STRING (no n or m flag).
--
--   pass 1  an annotation that occupies a whole line takes the line with it
--   pass 2  the same, for an annotation on the very first line
--   pass 3  an annotation with content before it takes the whitespace that
--           separated it (the defaults padded them into a column)
--   pass 4  what is left is an annotation at the start of a line with content
--           after it, so it takes the whitespace that follows instead
--
-- Pass 3 must precede pass 4 or a padded end-of-line annotation would leave its
-- padding behind as trailing whitespace.
--
-- IDEMPOTENT. The output of the strip contains no span matching the annotation
-- pattern, so a re-run selects no rows in "targets", changes nothing and writes
-- no second audit row. A row with no shipped annotation is never selected, is
-- never written, and gets no audit row.
--
-- AUDITED. Every mutated row gets one EMAIL_TEMPLATE_OVERRIDE_UPDATED entry
-- matching the convention in src/app/api/admin/email-templates/route.ts, with
-- the whole previous row and the whole new content in metadata plus the exact
-- annotations removed, so a club can see that we changed their copy, what we
-- changed, and can restore any of it. The actor is NULL: no member did this.
-- "updatedAt" moves to the migration time because the row's content really did
-- change; "updatedByMemberId" is left alone because it still truthfully names
-- the admin who authored the customisation that survives.
--
-- BLUE/GREEN. No DDL. Neither "EmailTemplateOverride" nor "AuditLog" is a hot
-- table. An old color reading a stripped override sends the same email minus
-- text it should never have sent, so old and new colors are both compatible in
-- both directions. Written as one statement, so it is all-or-nothing even
-- outside Prisma's own per-migration transaction.

WITH targets AS (
  SELECT
    "id",
    "templateName",
    "subject",
    "bodyText",
    "updatedByMemberId",
    "createdAt",
    "updatedAt"
  FROM "EmailTemplateOverride"
  WHERE COALESCE("subject", '') ~ '\[(?:only when|when|heading becomes|falls back to)[^\]]*\]'
     OR COALESCE("bodyText", '') ~ '\[(?:only when|when|heading becomes|falls back to)[^\]]*\]'
),
pass1 AS (
  SELECT
    "id",
    "templateName",
    "updatedByMemberId",
    "createdAt",
    "updatedAt",
    "subject" AS "oldSubject",
    "bodyText" AS "oldBody",
    regexp_replace("subject", '\n[ \t]*\[(?:only when|when|heading becomes|falls back to)[^\]]*\][ \t\r]*(?=\n|$)', '', 'g') AS "newSubject",
    regexp_replace("bodyText", '\n[ \t]*\[(?:only when|when|heading becomes|falls back to)[^\]]*\][ \t\r]*(?=\n|$)', '', 'g') AS "newBody"
  FROM targets
),
pass2 AS (
  SELECT
    "id",
    "templateName",
    "updatedByMemberId",
    "createdAt",
    "updatedAt",
    "oldSubject",
    "oldBody",
    regexp_replace("newSubject", '^[ \t]*\[(?:only when|when|heading becomes|falls back to)[^\]]*\][ \t\r]*\n', '', 'g') AS "newSubject",
    regexp_replace("newBody", '^[ \t]*\[(?:only when|when|heading becomes|falls back to)[^\]]*\][ \t\r]*\n', '', 'g') AS "newBody"
  FROM pass1
),
pass3 AS (
  SELECT
    "id",
    "templateName",
    "updatedByMemberId",
    "createdAt",
    "updatedAt",
    "oldSubject",
    "oldBody",
    regexp_replace("newSubject", '(?<=[^ \t\r\n])[ \t]*\[(?:only when|when|heading becomes|falls back to)[^\]]*\]', '', 'g') AS "newSubject",
    regexp_replace("newBody", '(?<=[^ \t\r\n])[ \t]*\[(?:only when|when|heading becomes|falls back to)[^\]]*\]', '', 'g') AS "newBody"
  FROM pass2
),
pass4 AS (
  SELECT
    "id",
    "templateName",
    "updatedByMemberId",
    "createdAt",
    "updatedAt",
    "oldSubject",
    "oldBody",
    regexp_replace("newSubject", '\[(?:only when|when|heading becomes|falls back to)[^\]]*\][ \t]*', '', 'g') AS "newSubject",
    regexp_replace("newBody", '\[(?:only when|when|heading becomes|falls back to)[^\]]*\][ \t]*', '', 'g') AS "newBody"
  FROM pass3
),
changed AS (
  SELECT *
  FROM pass4
  WHERE "newSubject" IS DISTINCT FROM "oldSubject"
     OR "newBody" IS DISTINCT FROM "oldBody"
),
audited AS (
  INSERT INTO "AuditLog" (
    "id",
    "action",
    "targetId",
    "entityType",
    "entityId",
    "category",
    "severity",
    "outcome",
    "summary",
    "metadata",
    "retentionClass",
    "expiresAt"
  )
  SELECT
    gen_random_uuid()::text,
    'EMAIL_TEMPLATE_OVERRIDE_UPDATED',
    changed."templateName",
    'EmailTemplateOverride',
    changed."templateName",
    'admin',
    'important',
    'success',
    'Email template override updated by upgrade: removed built-in authoring notes that were being emailed to recipients',
    jsonb_build_object(
      'templateName', changed."templateName",
      'previousOverride', jsonb_build_object(
        'id', changed."id",
        'templateName', changed."templateName",
        'subject', changed."oldSubject",
        'bodyText', changed."oldBody",
        'updatedByMemberId', changed."updatedByMemberId",
        'createdAt', changed."createdAt",
        'updatedAt', changed."updatedAt"
      ),
      'newOverride', jsonb_build_object(
        'subject', changed."newSubject",
        'bodyText', changed."newBody"
      ),
      'removedAnnotations', COALESCE(found."annotations", '[]'::jsonb),
      'source', 'migration:20260801150000_strip_email_override_bracket_annotations',
      'issue', 2269
    ),
    'critical',
    timezone('UTC', statement_timestamp()) + interval '7 years'
  FROM changed
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(match."annotation"[1]) AS "annotations"
    FROM regexp_matches(
      COALESCE(changed."oldSubject", '') || E'\n' || COALESCE(changed."oldBody", ''),
      '\[(?:only when|when|heading becomes|falls back to)[^\]]*\]',
      'g'
    ) AS match("annotation")
  ) AS found ON TRUE
  RETURNING 1
)
UPDATE "EmailTemplateOverride" AS override
SET
  "subject" = changed."newSubject",
  "bodyText" = changed."newBody",
  "updatedAt" = timezone('UTC', statement_timestamp())
FROM changed
WHERE override."id" = changed."id";
