-- Store committee role contact aliases separately from linked member emails.
-- Public recipient keys still resolve through CommitteeAssignment; this column
-- is the server-side delivery address for a committee role.

ALTER TABLE "CommitteeRole"
  ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;

WITH legacy_role_email AS (
  SELECT
    COALESCE(
      NULLIF(trim(cm."contactKey"), ''),
      CASE
        WHEN lower(regexp_replace(trim(cm."role"), '[^a-zA-Z0-9]+', '-', 'g')) = ''
          THEN 'legacy-' || md5(trim(cm."role"))
        ELSE lower(regexp_replace(trim(cm."role"), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || left(md5(trim(cm."role")), 8)
      END
    ) AS key,
    min(NULLIF(trim(cm."email"), '')) AS email
  FROM "CommitteeMember" cm
  WHERE cm."email" IS NOT NULL
    AND NULLIF(trim(cm."email"), '') IS NOT NULL
  GROUP BY 1
)
UPDATE "CommitteeRole" cr
SET "contactEmail" = legacy.email
FROM legacy_role_email legacy
WHERE cr."key" = legacy.key
  AND cr."contactEmail" IS NULL
  AND legacy.email IS NOT NULL;
