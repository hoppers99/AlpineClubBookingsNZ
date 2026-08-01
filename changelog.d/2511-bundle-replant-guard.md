- **Restoring an old configuration bundle can no longer quietly put back content
  a cleanup removed (#2511).** Earlier releases removed three pieces of starter
  content that belonged to the club this project began as: the front-page hero
  that advertised guest booking, the footer's affiliations line naming the
  Ruapehu Mountain Clubs Association, and a lodge address. Each was cleaned up by
  a one-off database change. But a configuration bundle you exported *before*
  upgrading still contains the old value, and importing such a bundle — including
  the unattended import that runs when an install is rebuilt from a bundle for
  disaster recovery — used to write it straight back onto your public site, with
  nothing to warn you.

  The import now recognises those exact removed values. When a bundle would
  restore one, the importer leaves the cleaned value in place instead of writing
  the old one, and the import preview shows a warning saying so. Everything else
  in the bundle imports normally, and a value your club has customised itself is
  never affected — only a byte-for-byte match of the specific removed text is
  skipped. The unattended rebuild-from-bundle path is protected the same way and
  now writes the same warning to the boot log naming what it skipped, so a
  recovery can no longer silently reintroduce the old content.

  You should still re-export your configuration bundle after upgrading and
  replace any archived copy you would restore from; doing so also clears the
  warning.
