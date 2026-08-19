import "server-only";

import { execFileSync } from "child_process";
import path from "path";

import { resolveBackupConfig } from "@/lib/backup-config";
import { resolveLocalBackupFile } from "@/lib/backup-local";
import {
  BACKUP_COMMAND_MAX_BUFFER_BYTES,
  BACKUP_COMMAND_TIMEOUT_MS,
  buildPostgresEnvironment,
  sanitizePostgresUrlForPgDump,
  splitPostgresPassword,
} from "@/lib/backup";

/**
 * Restoring a local backup over the LIVE database.
 *
 * Its own module rather than another export on `backup.ts`, and the separation
 * is the point rather than a filing decision: everything in `backup.ts` COPIES
 * data out, and this one thing writes it back, destructively. Keeping the only
 * operation in the codebase that can destroy the club's data in a file of its
 * own means nobody reaches it by accident, and its guards are read as a set.
 *
 * It borrows `backup.ts`'s postgres helpers deliberately — the password must be
 * lifted off argv into PGPASSWORD exactly as the dump path does, and a second
 * implementation of that is a second chance to leak a password into a process
 * listing.
 */

export interface LocalRestoreResult {
  filename: string;
  memberCount: number;
  bookingCount: number;
  paymentCount: number;
}

/**
 * Restore a local backup OVER THE LIVE DATABASE.
 *
 * This is the most destructive operation in the application: it drops the
 * public schema and replays a dump into it, so everything written since that
 * dump is gone, irreversibly, the moment it succeeds. It lives here rather than
 * in `backup-local.ts` so every `psql` invocation in this codebase sits in one
 * file, next to the password-off-argv handling it has to share.
 *
 * The guards, and which layer owns each:
 *   * WHO — Full Admin only, enforced by the route. Not a support:edit action
 *     even though running a backup is: taking a copy and overwriting production
 *     are not the same privilege.
 *   * WHAT — `resolveLocalBackupFile` accepts a FILENAME, never a path, and
 *     requires it to appear in the configured directory's own listing. A `.sql`
 *     file is executable SQL, so "restore this arbitrary path" would be remote
 *     code execution wearing a dropdown.
 *   * WHEN — the caller refuses while a backup run is in flight, so a dump and
 *     a restore can never interleave on the same database.
 *
 * The password is lifted off argv into PGPASSWORD exactly as the backup path
 * does, so it cannot appear in a process listing or in a persisted error.
 */
export async function restoreLocalBackup(filename: string): Promise<LocalRestoreResult> {
  const config = await resolveBackupConfig();
  if (!config.localPath) {
    throw new Error("No local backup directory is configured.");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  const sourcePath = resolveLocalBackupFile(config.localPath, filename);

  const { argvUrl, password } = splitPostgresPassword(
    sanitizePostgresUrlForPgDump(databaseUrl),
  );
  const env = buildPostgresEnvironment(password);

  // Decompress FIRST, before anything is dropped: a truncated or unreadable
  // archive then fails with the database still intact, rather than after the
  // schema has already gone.
  const sql = execFileSync("gunzip", ["-c", sourcePath], {
    timeout: BACKUP_COMMAND_TIMEOUT_MS,
    maxBuffer: BACKUP_COMMAND_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });

  execFileSync(
    "psql",
    [
      argvUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
    ],
    { timeout: BACKUP_COMMAND_TIMEOUT_MS, env, stdio: ["ignore", "pipe", "pipe"] },
  );

  execFileSync("psql", [argvUrl, "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    timeout: BACKUP_COMMAND_TIMEOUT_MS,
    maxBuffer: BACKUP_COMMAND_MAX_BUFFER_BYTES,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Read the restored row counts back, for the same reason the nightly
  // restore-validation does: "psql exited 0" says the statements ran, not that
  // the database now holds a club.
  const counts = execFileSync(
    "psql",
    [
      argvUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-F",
      "|",
      "-c",
      'SELECT (SELECT count(*) FROM "Member"), (SELECT count(*) FROM "Booking"), (SELECT count(*) FROM "Payment");',
    ],
    {
      encoding: "utf8",
      timeout: BACKUP_COMMAND_TIMEOUT_MS,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const [members, bookings, payments] = counts.trim().split("|");
  return {
    filename: path.basename(sourcePath),
    memberCount: Number.parseInt(members ?? "0", 10) || 0,
    bookingCount: Number.parseInt(bookings ?? "0", 10) || 0,
    paymentCount: Number.parseInt(payments ?? "0", 10) || 0,
  };
}
