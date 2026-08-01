- **Old audit history kept in the archive is now guaranteed to carry every
  detail the club records, and to keep doing so as the software grows
  (#2290).** Audit entries older than twelve months are copied into the
  optional archive database and then removed from the main one, so the archive
  copy becomes the only surviving record of what happened. Which details got
  copied across was maintained by hand in three separate places, and nothing
  checked that the list was complete — so if a future release started recording
  a new detail on every audit entry, that detail would simply not be copied.
  Everything older than a year would quietly lack it, and nobody would find out
  until someone went looking, months or years later, for exactly the thing that
  was missing.

  Nothing was actually lost: all twenty-two details are copied correctly today,
  and an automated check now proves that on every build. What changes is that
  it can no longer go wrong. The list of details to archive is now taken
  from the club's own data definition rather than kept by hand, so anything the
  software starts recording in future is archived automatically. Leaving a
  detail out is still possible, but only deliberately and with a written reason
  — an accidental omission now stops the build and fails the automated checks
  before it can reach a club.

  **Operators running an archive database should know one thing.** The archive
  table is created once, the first time the archive runs. If a future release
  adds a new detail to the audit trail, that release note will say so, and the
  archive table needs one `ALTER TABLE` before the next nightly run —
  `docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md` gives the exact command, plus two
  queries (one per database, needing nothing but database access) that show
  whether the archive is missing a column.

  If it is missed, the nightly job stops with an error rather than archiving an
  incomplete copy — and it stops **completely**: nothing is archived, and no
  expired audit entries are deleted from either database until the archive
  table is corrected. That is deliberate. Deleting expired entries does not
  check whether they reached the archive first, so carrying on with the
  deletions while archiving is broken would destroy history permanently, where
  keeping entries a little longer than the policy says is undone the moment the
  archive is fixed. The nightly run catches up on both by itself. The cron
  failure message says all of this, so nothing about it should be a surprise
  at 3am. Entries archived before a detail existed keep a blank for it; the
  archive is not rewritten.

  Clubs that have not set an archive database are unaffected — nothing about
  what is recorded, what members and administrators see, or how long anything is
  kept has changed.
