- **Three security hardenings found by reading the code-scanning backlog, and the
  security alert list is trustworthy again (#2841).** Nothing in the backlog was
  exploitable by an outsider, but reading all seventeen alerts turned up three
  real gaps worth closing.

  The snow-report fetch now re-checks its host allowlist on every redirect,
  instead of only on the address it starts from. Because that report is cached and
  shown publicly, a redirect chosen by the upstream site could previously have
  been followed anywhere and the result read off the public page.

  The Image Manager now refuses a folder named `.` or `..`. Those are not names —
  the filesystem treats them as "this folder" and "the folder above" — so
  creating or renaming a folder with one produced a confusing error instead of a
  clear "invalid name", and only a second safety check stopped it doing anything
  worse.

  The MiroTalk meeting key (`MIRO_JWT_KEY`) now has a documented strength
  requirement: at least 32 generated characters, and never the example value
  MiroTalk ships. That key both signs every meeting join link and protects the
  host password inside it, so a guessable one lets anybody start a meeting as
  host. If yours looks weak the server logs one warning and **meeting links keep
  working** — nothing stops, but it is worth rotating. `docs/guides/calendar.md`
  explains how.

  Finally, a tooling fix that matters more than it sounds: findings the code
  scanner had already been told to ignore were being filed as security alerts
  nobody could ever close. A real new finding would have arrived in that list
  looking exactly like the known-harmless ones. Those are no longer published, so
  the list means something again.
