- **Database backups can now be kept on the server as well as in Amazon S3, and
  restored from the admin screen.** Until now the only destination was an S3
  bucket, so a club without AWS had no working backup at all — the nightly job
  wrote to temporary storage that every deploy threw away.

  **Admin → Integrations → Database Backups** has been reorganised. The old
  **Configuration** and **Credentials** panels are now one panel called **AWS S3
  Backup** — nothing about how S3 works has changed, it is simply in one place —
  and there is a new **Local backup** panel beneath it.

  Press **Edit** on **Local backup**, tick **Enable local backups**, and enter
  the directory to store backup files in. The directory is required, and the
  save is refused if the application cannot write there, so a path that will not
  work is rejected while you are looking at the screen rather than at 3am. From
  then on the nightly job writes each backup to that directory, and deletes
  files older than the retention window you already set. A **Manual Backup**
  button runs one immediately.

  The panel shows how much disk space is left on that volume, turning **yellow
  below 5 GB** and **red below 1 GB**, so a directory quietly filling up is
  visible before it stops working.

  It can also **restore** a backup: choose one from the dropdown (it defaults to
  the most recent) and confirm. This replaces the live database and cannot be
  undone, so it is Full Admin only, refuses to run while a backup is in
  progress, and is written to the audit log before it starts as well as when it
  finishes — a restore stays traceable even if it fails part-way.

  **Two things to know before relying on local backups.** In Docker the
  directory must be a **mounted volume**, or the files disappear with the
  container on the next deploy. And a copy on the same machine as the database
  is not an off-site copy — it is a fast way to undo a bad change, not a
  replacement for S3.
