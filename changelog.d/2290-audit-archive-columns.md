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
  and this was checked against the live archive before the change. What changes
  is that it can no longer go wrong. The list of details to archive is now taken
  from the club's own data definition rather than kept by hand, so anything the
  software starts recording in future is archived automatically. Leaving a
  detail out is still possible, but only deliberately and with a written reason
  — an accidental omission now stops the build and fails the automated checks
  before it can reach a club.

  **Operators running an archive database should know one thing.** The archive
  table is created once, the first time the archive runs. If a future release
  adds a new detail to the audit trail, that release note will say so, and the
  archive table needs one `ALTER TABLE` before the next nightly run —
  `docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md` gives the exact command and a query
  to check the archive against the current definition. If it is missed, the
  nightly archive step stops with an error and archives nothing rather than
  archiving an incomplete copy, so nothing is lost while it waits to be
  corrected. Entries archived before a detail existed keep a blank for it; the
  archive is not rewritten.

  Clubs that have not set an archive database are unaffected — nothing about
  what is recorded, what members and administrators see, or how long anything is
  kept has changed.
