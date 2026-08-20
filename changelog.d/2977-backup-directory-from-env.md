- **Setting up a local backup directory no longer requires knowing how Docker
  works (#2977).** Two things went wrong for the first operator who tried
  it, and both are fixed.

  On a containerised deployment — which the shipped Docker Compose stack is —
  the backup directory is the path **inside the container**, not on the server,
  because that container has a read-only filesystem and can only write to a
  directory mounted into it. Entering a host path such as
  `/home/alpineclub/db_backup` failed with `Could not create that directory:
  ENOENT` — accurate and useless. The message now says so when the application
  really is containerised, names the mounted path when there is one, and
  otherwise gives the two steps needed to create it, including the ownership
  change most people would hit next. Running the application directly on a
  server? Nothing here changes for you.

  The directory is also configurable per deployment now, so each club can put it
  where their server has room. Set `BACKUP_LOCAL_HOST_DIR` in `.env` to a host
  directory and `docker compose up -d app`; it is bind-mounted at
  `BACKUP_LOCAL_DIR` (`/backups` by default), and the Backups page **fills that
  path in for you** — nothing to retype and nothing to mistype. Leave
  `BACKUP_LOCAL_HOST_DIR` empty and backups go to a named volume instead, which
  needs no setup at all but keeps the files inside Docker. A path saved on the
  Backups page still overrides both.

  Existing installations are unaffected: the default is the named volume, and no
  backup starts writing anywhere until an admin enables local backups.
