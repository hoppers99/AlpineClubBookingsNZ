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
-- without asking.
--
-- This migration therefore matches the EXACT STRINGS this project shipped, and
-- nothing else. It does NOT match a prefix family ("anything opening [only
-- when"). That was the first cut and three reviewers reproduced real club prose
-- being destroyed by it — "Ring the bell [whenever you arrive after 8pm].",
-- "the hut sits on [whenua administered by the rūnanga]", and, surviving even a
-- word-boundary fix, "Ring the lodge [when you are 30 minutes away].". The last
-- of those is ordinary New Zealand alpine-club wording that no boundary rule
-- can tell apart from "[when dates did not change]". What settles it is that
-- the damage is not recoverable in the product: the editor refuses to save
-- square brackets (#2320), so a club whose wording we delete cannot paste it
-- back — only a DBA reading the audit row can. A rule that can be wrong must
-- not be the one that writes.
--
-- The list of exact spans is SHIPPED_ANNOTATIONS in
-- src/lib/email-message-token-contract.ts: 38 strings, recovered by replaying
-- every historical revision of email-message-registry.ts,
-- email-message-audit-defaults.ts and email-message-notes.ts across every ref
-- and extracting every bracketed span on a non-comment line. They fall in four
-- families, though the families are documentation now rather than the rule:
--
--   [only when ...]        the conditional-line notes (the bulk of them)
--   [when ...]             their "and when it did not" siblings
--   [heading becomes ...]  the school attendee-confirmation subject note
--   [falls back to ...]    the school attendee-confirmation body note
--
-- THE ACCEPTED COST, stated plainly. A club that reflowed the whitespace inside
-- a shipped annotation, or retyped it with a different word, keeps it: this
-- migration does not heal that row. It is not abandoned either — #2320's
-- bracket banner and #2269's per-template indicator both still name it, and an
-- admin resolves it deliberately. That is the same choice made everywhere else
-- in this change: an ambiguous case goes to a person, never to a script.
--
-- Semantic drift that needs prose rewritten is NOT touched here, and the three
-- money lines the shipped defaults padded these notes onto are the reason that
-- matters:
--
--   Subtotal: {{subtotal}}                  [only when discountCents > 0]
--   Discount ({{promoCode}}): -{{discount}} [only when promoCode exists]
--   Discount: -{{discount}}                 [only when discount exists ...]
--
-- Stripping the brackets leaves those lines rendering "Discount (): -" on an
-- ordinary booking and "Discount (PEAK): -" on a promo that RAISED the price —
-- the #2267 incident verbatim, a member charged more being shown a "Discount"
-- line. The brackets were the only thing making an admin look. So this
-- migration does not ship on its own: #2269 also adds a `dangling_line` reason
-- to the admin editor's staleness computation
-- (src/app/api/admin/email-templates/route.ts), which runs guard 4
-- (findDanglingDefaultLines) over the SAVED override with every token the
-- sender can supply EMPTY and names the exact lines that render broken. The
-- rows this migration touches are therefore the rows that banner names.
--
-- HOW THE STRIP IS DEFINED
--
-- The "annotation" CTE below holds the alternation of the 38 exact spans, and
-- it is byte-identical to SHIPPED_ANNOTATION_PATTERN in
-- src/lib/email-message-token-contract.ts. The "patterns" CTE builds the six
-- ordered passes from it, mirroring SHIPPED_ANNOTATION_STRIP_PATTERNS.
-- src/lib/__tests__/email-message-annotation-strip.test.ts reads THIS FILE,
-- rebuilds the patterns the SQL will actually run, asserts they equal the
-- TypeScript list, and runs the fixture corpus through the ones lifted out of
-- this file. Guard 1 in the same module fails the registry test if an
-- annotation is ever put back into a shipped default, so the list cannot fall
-- behind the code going forward.
--
-- Every construct used means the same thing in PostgreSQL's ARE engine and in
-- JavaScript's (verified against postgres:16): an escape inside a bracket
-- expression, a lookahead, a fixed-width lookbehind, a non-capturing group with
-- a greedy repeat, and ^/$ as start/end of STRING (no n or m flag).
-- Deliberately NOT used: \y / \b, which do not mean the same thing in the two
-- engines and so cannot live in a shared pattern string. The alternation is
-- sorted longest-first, and no span is a prefix of another, so JavaScript's
-- leftmost-first alternation and ARE's preference for the longest match cannot
-- disagree.
--
--   pass 1  a run of whole-line annotations sitting between two BLANK lines
--           takes one of the blank lines with it, or the paragraph break either
--           side would add up to a stray empty line in the delivered email
--   pass 2  the same, for a run at the very start of the value
--   pass 3  any remaining annotation that occupies a whole line takes the line
--           with it
--   pass 4  the same, for an annotation on the very first line
--   pass 5  an annotation with content before it takes the whitespace that
--           separated it (the defaults padded them into a column)
--   pass 6  what is left is an annotation at the start of a line with content
--           after it, so it takes the whitespace that follows instead
--
-- Order matters twice: 1 before 3 and 2 before 4 (the blank-line-aware forms
-- are strictly more specific), and 5 before 6, or a padded end-of-line
-- annotation would be removed by 6 and leave its padding as trailing
-- whitespace.
--
-- IDEMPOTENT. The output of the strip contains no span matching the annotation
-- pattern, so a re-run selects no rows in "targets", changes nothing and writes
-- no second audit row. A row with no shipped annotation is never selected, is
-- never written, and gets no audit row.
--
-- NEVER LEAVES AN EMPTY STRING. A value the strip empties out is normalised to
-- NULL, because '' is a state the app never stores: the save route writes
-- `subject || null`, prepareEmailMessage reads NULL as "use the built-in
-- wording", and #2269's own staleContent would report a stored '' as "your
-- saved copy differs" and diff the whole default as removed.
--
-- AUDITED. Every mutated row gets one EMAIL_TEMPLATE_OVERRIDE_UPDATED entry
-- matching the convention in src/app/api/admin/email-templates/route.ts, with
-- the whole previous row and the whole new content in metadata plus the exact
-- annotations removed, so a club can see that we changed their copy, what we
-- changed, and can restore any of it. The actor is NULL: no member did this.
-- "updatedAt" moves to the migration time because the row's content really did
-- change; "updatedByMemberId" is left alone because it still truthfully names
-- the admin who authored the customisation that survives, and is echoed into
-- "newOverride" so the shape matches the app's own audit metadata for this
-- action.
--
-- NO SESSION CLOCK. "createdAt" is named explicitly and set from
-- timezone('UTC', statement_timestamp()), like "expiresAt" and "updatedAt".
-- Left out, it would take the column default CURRENT_TIMESTAMP, which writes
-- the SESSION's local wall clock into a naive timestamp column — measured 12
-- hours out on a Pacific/Auckland session. That is the #1627/#1656 class the
-- repo's session-clock gate polices; the gate stays quiet when the clock hides
-- in a column default, so this is called out here and asserted in the
-- blue/green ledger row.
--
-- Metadata timestamps are rendered with to_char(...'Z') rather than left to
-- jsonb_build_object, which emits a NAIVE "2026-01-01T00:00:00" that JavaScript
-- parses as LOCAL time; the app's sanitizer emits toISOString(), so this
-- matches it.
--
-- AUDIT ROWS ARE DRIVEN BY THE UPDATE, not written beside it (#2269 review).
-- A data-modifying CTE sees the snapshot taken at statement start, so an INSERT
-- running in parallel with the UPDATE cannot know whether the UPDATE actually
-- hit the row. docs/UPGRADING.md promises this migration is safe to run with
-- the previous app colour still serving, which is exactly the window in which
-- an admin presses Restore Default (a DELETE) or Save (an UPDATE) on the same
-- row: both were reproduced writing an audit entry for a row the migration
-- never changed, one of them naming an override that no longer exists. So the
-- UPDATE runs first, re-checks that subject and bodyText are STILL the values
-- the strip was computed from, and RETURNS the rows it really wrote; the
-- INSERT then selects from that. A row a concurrent admin deleted or re-saved
-- is skipped, gets no audit row, and is left entirely to the admin.
--
-- REMOVED ANNOTATIONS ARE COUNTED PER FIELD. Concatenating subject and body
-- before scanning invents spans that never existed: a subject ending
-- "Trailing opener [only when" plus a body starting "x]" produced a phantom
-- entry across the join (reproduced). Subject and body are scanned separately
-- and the two lists concatenated.
--
-- METADATA IS NOT PUT THROUGH sanitizeAuditMetadata, AND THAT IS A DELIBERATE
-- TRADE (#2269 review). SQL has no access to the app's sanitizer, and the
-- acceptance criterion is that a club can RECOVER its exact previous wording,
-- which the sanitizer's 1000-character truncation would defeat. What is
-- therefore skipped: the 1000-char per-string truncation, the 24 KB envelope
-- cap, and the secret/card-number redaction. The risk is real and this repo has
-- form — 20260710000100_redact_audit_log_door_codes exists because plaintext
-- door codes reached audit metadata — so: a club that typed a LITERAL door code
-- into its template body instead of {{doorCode}} now has that literal in an
-- unredacted AuditLog row retained for 7 years. The bound on the blast radius
-- is that "EmailTemplateOverride"."subject" and "bodyText" are capped at 500
-- and 10,000 characters by the save route, so no row can be enormous. This is
-- called out again in docs/UPGRADING.md and in the blue/green ledger row.
--
-- BLUE/GREEN. No DDL. Neither "EmailTemplateOverride" nor "AuditLog" is a hot
-- table. An old color reading a stripped override sends the same email minus
-- text it should never have sent, so old and new colors are both compatible in
-- both directions. Written as one statement, so it is all-or-nothing even
-- outside Prisma's own per-migration transaction.

WITH annotation AS (
  -- The exact shipped annotation spans, as one alternation. Dollar-quoted so
  -- the two spans containing an apostrophe need no doubling and the string is
  -- byte-identical to SHIPPED_ANNOTATION_PATTERN in
  -- src/lib/email-message-token-contract.ts, which the strip test asserts.
  SELECT $ann$(?:\[when the automatic refund could not complete inline: the refund could not complete and a durable recovery operation is queued — the payment recovery cron will retry it with backoff; watch the recovery queue and confirm the refund lands\. Failure detail: \{\{errorMessage\}\}\]|\[when the member's own linked booking is also unpaid: no payment link is sent and a human must chase payment for the whole booking, because the guest portion must not settle ahead of the member's own place\]|\[when the member's own linked booking is not settled: the member's own linked booking is not settled either \(it may be unpaid or already cancelled\), so review the whole booking\]|\[only when payment is still owing - states the amount owing and the internet-banking reference \{\{paymentReference\}\}\]|\[when your own linked booking is not settled: your own linked booking has not been changed by this cancellation\]|\[only when non-member guests are held provisionally as a split linked booking\]|\[falls back to "your school group's stay" when no school name is recorded\]|\[heading becomes "Reminder: Confirm Your Attendee List" on reminders\]|\[only when the booking is confirmed but payment is still owing\]|\[only when the club has a recorded fee amount for this season\]|\[only when your own linked booking reference is available\]|\[only when discount exists without promoCode\]|\[only when requestedAmountCents is truthy\]|\[only when the booking is already paid\]|\[only when additional payment is due\]|\[only when rejoinProcessText exists\]|\[only when adminNotes is non-empty\]|\[only when familyMemberCount > 0\]|\[when guest count did not change\]|\[only when xeroObjectUrl exists\]|\[only when guest count changed\]|\[only when reviewReason exists\]|\[only when a door code is set\]|\[only when changeFeeCents > 0\]|\[only when adminNotes exists\]|\[only when discountCents > 0\]|\[only when reviewNote exists\]|\[only when adminNote exists\]|\[only when choreLink exists\]|\[only when promoCode exists\]|\[only when localUrl exists\]|\[when dates did not change\]|\[when total did not change\]|\[only when dates changed\]|\[only when reason exists\]|\[only when total changed\]|\[only when chores exist\]|\[only when provided\])$ann$ AS "span"
),
patterns AS (
  -- The six ordered passes, built once from the alternation above. Same list,
  -- same order, as SHIPPED_ANNOTATION_STRIP_PATTERNS.
  SELECT
    '(?<=\n)(?:\n[ \t]*' || annotation."span" || '[ \t\r]*)+\n(?=\n)' AS "pass1",
    '^(?:[ \t]*' || annotation."span" || '[ \t\r]*\n)+\n' AS "pass2",
    '\n[ \t]*' || annotation."span" || '[ \t\r]*(?=\n|$)' AS "pass3",
    '^[ \t]*' || annotation."span" || '[ \t\r]*\n' AS "pass4",
    '(?<=[^ \t\r\n])[ \t]*' || annotation."span" AS "pass5",
    annotation."span" || '[ \t]*' AS "pass6"
  FROM annotation
),
targets AS (
  SELECT
    override."id",
    override."templateName",
    override."subject",
    override."bodyText",
    override."updatedByMemberId",
    override."createdAt",
    override."updatedAt"
  FROM "EmailTemplateOverride" AS override, annotation
  WHERE COALESCE(override."subject", '') ~ annotation."span"
     OR COALESCE(override."bodyText", '') ~ annotation."span"
),
pass1 AS (
  SELECT
    targets."id",
    targets."templateName",
    targets."updatedByMemberId",
    targets."createdAt",
    targets."updatedAt",
    targets."subject" AS "oldSubject",
    targets."bodyText" AS "oldBody",
    regexp_replace(targets."subject", patterns."pass1", '', 'g') AS "newSubject",
    regexp_replace(targets."bodyText", patterns."pass1", '', 'g') AS "newBody"
  FROM targets, patterns
),
pass2 AS (
  SELECT
    pass1."id",
    pass1."templateName",
    pass1."updatedByMemberId",
    pass1."createdAt",
    pass1."updatedAt",
    pass1."oldSubject",
    pass1."oldBody",
    regexp_replace(pass1."newSubject", patterns."pass2", '', 'g') AS "newSubject",
    regexp_replace(pass1."newBody", patterns."pass2", '', 'g') AS "newBody"
  FROM pass1, patterns
),
pass3 AS (
  SELECT
    pass2."id",
    pass2."templateName",
    pass2."updatedByMemberId",
    pass2."createdAt",
    pass2."updatedAt",
    pass2."oldSubject",
    pass2."oldBody",
    regexp_replace(pass2."newSubject", patterns."pass3", '', 'g') AS "newSubject",
    regexp_replace(pass2."newBody", patterns."pass3", '', 'g') AS "newBody"
  FROM pass2, patterns
),
pass4 AS (
  SELECT
    pass3."id",
    pass3."templateName",
    pass3."updatedByMemberId",
    pass3."createdAt",
    pass3."updatedAt",
    pass3."oldSubject",
    pass3."oldBody",
    regexp_replace(pass3."newSubject", patterns."pass4", '', 'g') AS "newSubject",
    regexp_replace(pass3."newBody", patterns."pass4", '', 'g') AS "newBody"
  FROM pass3, patterns
),
pass5 AS (
  SELECT
    pass4."id",
    pass4."templateName",
    pass4."updatedByMemberId",
    pass4."createdAt",
    pass4."updatedAt",
    pass4."oldSubject",
    pass4."oldBody",
    regexp_replace(pass4."newSubject", patterns."pass5", '', 'g') AS "newSubject",
    regexp_replace(pass4."newBody", patterns."pass5", '', 'g') AS "newBody"
  FROM pass4, patterns
),
pass6 AS (
  SELECT
    pass5."id",
    pass5."templateName",
    pass5."updatedByMemberId",
    pass5."createdAt",
    pass5."updatedAt",
    pass5."oldSubject",
    pass5."oldBody",
    regexp_replace(pass5."newSubject", patterns."pass6", '', 'g') AS "newSubject",
    regexp_replace(pass5."newBody", patterns."pass6", '', 'g') AS "newBody"
  FROM pass5, patterns
),
normalised AS (
  -- A value the strip empties out must become NULL, not ''. The save route
  -- stores `subject || null` / `bodyText || null` and prepareEmailMessage reads
  -- NULL as "use the built-in wording", so a stored '' is a state the app never
  -- creates: this change's own staleContent would report it as "your saved copy
  -- differs" and diff the entire default as removed. Whitespace-only counts as
  -- empty for the same reason (the save route trims).
  SELECT
    pass6."id",
    pass6."templateName",
    pass6."updatedByMemberId",
    pass6."createdAt",
    pass6."updatedAt",
    pass6."oldSubject",
    pass6."oldBody",
    CASE
      WHEN btrim(pass6."newSubject", E' \t\r\n') = '' THEN NULL
      ELSE pass6."newSubject"
    END AS "newSubject",
    CASE
      WHEN btrim(pass6."newBody", E' \t\r\n') = '' THEN NULL
      ELSE pass6."newBody"
    END AS "newBody"
  FROM pass6
),
changed AS (
  SELECT *
  FROM normalised
  WHERE "newSubject" IS DISTINCT FROM "oldSubject"
     OR "newBody" IS DISTINCT FROM "oldBody"
),
updated AS (
  -- The audit trail is driven BY this UPDATE, not written beside it. The
  -- IS NOT DISTINCT FROM guard makes the write conditional on the row still
  -- holding exactly the text the strip was computed from, so a Restore Default
  -- (DELETE) or a Save (UPDATE) that lands from the still-serving old colour in
  -- the same window is left alone rather than silently clobbered, and RETURNING
  -- yields only the rows this statement really wrote.
  UPDATE "EmailTemplateOverride" AS override
  SET
    "subject" = changed."newSubject",
    "bodyText" = changed."newBody",
    "updatedAt" = timezone('UTC', statement_timestamp())
  FROM changed
  WHERE override."id" = changed."id"
    AND override."subject" IS NOT DISTINCT FROM changed."oldSubject"
    AND override."bodyText" IS NOT DISTINCT FROM changed."oldBody"
  RETURNING changed.*
)
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
  "expiresAt",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  'EMAIL_TEMPLATE_OVERRIDE_UPDATED',
  updated."templateName",
  'EmailTemplateOverride',
  updated."templateName",
  'admin',
  'important',
  'success',
  'Email template override updated by upgrade: removed built-in authoring notes that were being emailed to recipients',
  jsonb_build_object(
    'templateName', updated."templateName",
    'previousOverride', jsonb_build_object(
      'id', updated."id",
      'templateName', updated."templateName",
      'subject', updated."oldSubject",
      'bodyText', updated."oldBody",
      'updatedByMemberId', updated."updatedByMemberId",
      'createdAt', to_char(updated."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(updated."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'newOverride', jsonb_build_object(
      'subject', updated."newSubject",
      'bodyText', updated."newBody",
      'updatedByMemberId', updated."updatedByMemberId"
    ),
    'removedAnnotations', COALESCE(found."annotations", '[]'::jsonb),
    'source', 'migration:20260801150000_strip_email_override_bracket_annotations',
    'issue', 2269
  ),
  'critical',
  timezone('UTC', statement_timestamp()) + interval '7 years',
  timezone('UTC', statement_timestamp())
FROM updated
CROSS JOIN annotation
LEFT JOIN LATERAL (
  -- Per FIELD, never over a concatenation of the two: scanning
  -- subject || newline || body invents spans that straddle the join.
  SELECT jsonb_agg(match."annotation"[1] ORDER BY field."rank", match."position")
    AS "annotations"
  FROM (VALUES (1, updated."oldSubject"), (2, updated."oldBody"))
    AS field("rank", "value")
  CROSS JOIN LATERAL regexp_matches(
    COALESCE(field."value", ''),
    annotation."span",
    'g'
  ) WITH ORDINALITY AS match("annotation", "position")
) AS found ON TRUE;
