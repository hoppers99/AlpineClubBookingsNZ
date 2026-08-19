import "server-only";

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  statfsSync,
  unlinkSync,
} from "fs";
import path from "path";

/**
 * Local (on-host) database backups: where they may be written, what is there,
 * how much room is left, and restoring one.
 *
 * WHY THIS IS ITS OWN MODULE, and why it is written defensively. Everything
 * here is driven by an operator-typed filesystem PATH, and the two operations
 * it enables are the two most dangerous a backup feature has:
 *
 *   * WRITING a full `pg_dump` of the entire club database to that path. Point
 *     it at a directory the web server serves and the whole database — members,
 *     addresses, payment records — is downloadable by anyone who guesses a
 *     filename. That is the same reasoning that already makes the S3
 *     destination Full-Admin-only in `backup-config.ts` ("repointing the
 *     destination exfiltrates the entire pg_dump"), and it applies here with
 *     less warning, because a local path looks harmless.
 *   * RESTORING one over the live database, which is an unrecoverable
 *     overwrite of production data and, since a `.sql` file is executable SQL,
 *     arbitrary statement execution if an attacker can drop a file in the
 *     directory.
 *
 * So the rules below are deliberately strict and stated rather than implied,
 * and the restore path never accepts a path from a client — only a filename it
 * then has to find in its own listing.
 */

/** Backups this app writes are named `tacbookings-<iso timestamp>.sql.gz`. */
const BACKUP_FILENAME_REGEX = /^tacbookings-[0-9TZ:.\-]+\.sql\.gz$/;

const MAX_PATH_LENGTH = 4096;

/**
 * Directory trees a database dump must never be written into.
 *
 * Two classes, for two different reasons. The system roots are where a stray
 * write can break the host or the database itself. `/proc`, `/sys` and `/dev`
 * are not storage at all — writing there pokes kernel state.
 */
const DENIED_ROOTS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  // The database's own data directory. A dump written inside it is both a
  // corruption hazard and a way to fill the volume the database needs to run.
  "/var/lib/postgresql",
];

/** Disk-space thresholds the admin screen colours on, in bytes. */
export const DISK_SPACE_WARNING_BYTES = 5 * 1024 * 1024 * 1024;
export const DISK_SPACE_CRITICAL_BYTES = 1 * 1024 * 1024 * 1024;

export type DiskSpaceLevel = "ok" | "warning" | "critical";

export interface LocalBackupDiskSpace {
  availableBytes: number;
  totalBytes: number;
  level: DiskSpaceLevel;
}

export interface LocalBackupFile {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
}

export class LocalBackupPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalBackupPathError";
  }
}

/**
 * Validate and canonicalise an operator-supplied backup directory.
 *
 * Returns the resolved absolute path, or throws `LocalBackupPathError` with a
 * message written for the operator reading it on the settings screen.
 *
 * THE APPLICATION DIRECTORY IS REFUSED, and that is the rule doing the most
 * work here: `public/` is served verbatim by Next.js, so a dump written
 * anywhere under the app root is one URL guess away from being the whole
 * database. Refusing the entire tree rather than just `public/` is deliberate —
 * `.next/`, `standalone/` and any future served directory are covered by the
 * same check, and no legitimate backup target lives inside the app bundle.
 */
export function resolveLocalBackupDirectory(
  input: string,
  options: { applicationRoot?: string } = {},
): string {
  const raw = (input ?? "").trim();
  if (raw.length === 0) {
    throw new LocalBackupPathError("Enter the directory to store backups in.");
  }
  if (raw.length > MAX_PATH_LENGTH) {
    throw new LocalBackupPathError("That path is too long.");
  }
  // A NUL byte truncates the path at the syscall boundary, so what is checked
  // here would not be what is opened. Refuse rather than sanitise.
  if (raw.includes("\0")) {
    throw new LocalBackupPathError("That path contains an invalid character.");
  }
  // `~` is shell expansion, not a path. Node would create a literal directory
  // called "~", which is never what the operator meant.
  if (raw.startsWith("~")) {
    throw new LocalBackupPathError(
      "Enter a full path starting with / — ~ is not expanded here.",
    );
  }
  if (!path.posix.isAbsolute(raw) && !path.isAbsolute(raw)) {
    throw new LocalBackupPathError(
      "Enter a full path starting with / (a relative path is not allowed).",
    );
  }

  // NORMALISE THE WAY THE DEPLOYMENT TARGET DOES, not the way the developer's
  // machine does. `path.resolve("/etc")` on Windows answers `D:\etc`, which
  // matches none of the denied roots below — so a validator written with the
  // native helper passes its own tests on Windows while the rule it exists to
  // enforce quietly does nothing on the Linux container that actually runs it.
  const looksPosix = raw.startsWith("/");
  const resolved = looksPosix ? path.posix.normalize(raw) : path.resolve(raw);

  // `normalize` already collapses `..`, so a surviving segment means something
  // pathological; check the INPUT so a traversal attempt is refused loudly
  // rather than silently normalised into a different directory.
  if (raw.split(/[\/]+/).includes("..")) {
    throw new LocalBackupPathError("That path may not contain '..'.");
  }

  if (resolved === "/" || /^[A-Za-z]:[\/]?$/.test(resolved)) {
    throw new LocalBackupPathError("Choose a directory, not the filesystem root.");
  }

  // Only meaningful for a POSIX path, which is what production uses. A Windows
  // path can only occur on a developer machine, where these roots do not exist.
  if (looksPosix) {
    const trimmed = resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
    for (const denied of DENIED_ROOTS) {
      if (trimmed === denied || trimmed.startsWith(`${denied}/`)) {
        throw new LocalBackupPathError(
          `${denied} is a system directory and cannot hold backups. Choose a data directory such as /var/backups/tacbookings.`,
        );
      }
    }
  }

  // Compared through the NATIVE resolver on both sides, so the two paths are
  // spelled the same way whichever platform this runs on.
  const appRoot = path.resolve(options.applicationRoot ?? process.cwd());
  const nativeResolved = path.resolve(resolved);
  if (
    nativeResolved === appRoot ||
    nativeResolved.startsWith(appRoot + path.sep)
  ) {
    throw new LocalBackupPathError(
      "That path is inside the application directory, where backup files could be served over the web. Choose a directory outside it.",
    );
  }

  return resolved;
}

/** True when the path passes {@link resolveLocalBackupDirectory}. */
export function isValidLocalBackupPath(
  input: string,
  options: { applicationRoot?: string } = {},
): boolean {
  try {
    resolveLocalBackupDirectory(input, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure the directory exists and this process can write to it.
 *
 * Called at save time so an unusable path is refused while the operator is
 * looking at the screen, rather than at 3am by the cron job.
 */
export function ensureLocalBackupDirectory(directory: string): void {
  const resolved = resolveLocalBackupDirectory(directory);
  try {
    mkdirSync(resolved, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LocalBackupPathError(
      `Could not create that directory: ${message}`,
    );
  }
  const probe = path.join(resolved, `.tacbookings-write-test-${process.pid}`);
  try {
    // An actual write, not an `access()` check: the container may run as a user
    // whose permission bits say yes on a read-only mount.
    copyFileSync("/dev/null", probe);
    unlinkSync(probe);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LocalBackupPathError(
      `That directory is not writable by the application: ${message}`,
    );
  }
}

/**
 * Validate a submitted local-backup selection and return the path to store.
 *
 * Lives here rather than inline in the config route because the two fields are
 * ONE rule, not two: a switch with no directory behind it is a tick that
 * silently does nothing, and the state that matters is the one the save leaves
 * behind — so enabling without a path in the same request has to consult what
 * is already stored. `storedPath` is a thunk so that read only happens on the
 * branch that needs it.
 *
 * Returns the path to persist, or `undefined` when the request either clears
 * the directory or does not mention it.
 */
export async function resolveLocalBackupSelection(params: {
  localEnabled?: boolean;
  localPath?: string;
  storedPath: () => Promise<string | null>;
}): Promise<string | undefined> {
  let resolved: string | undefined;
  if (params.localPath !== undefined && params.localPath.trim() !== "") {
    // An actual mkdir + write probe, so an unusable path is refused while the
    // operator is looking at the screen rather than at 3am by the cron job.
    ensureLocalBackupDirectory(params.localPath);
    resolved = params.localPath.trim();
  }
  if (params.localEnabled === true) {
    const pathAfterSave =
      params.localPath !== undefined
        ? params.localPath.trim()
        : ((await params.storedPath()) ?? "");
    if (pathAfterSave === "") {
      throw new LocalBackupPathError(
        "Enter the directory to store backups in before enabling local backups.",
      );
    }
  }
  return resolved;
}

/** Free space on the volume holding `directory`, with its warning level. */
export function getLocalBackupDiskSpace(directory: string): LocalBackupDiskSpace {
  const stats = statfsSync(directory);
  // `bavail` — blocks available to an UNPRIVILEGED process — not `bfree`, which
  // counts the root-reserved margin this app can never use.
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  return {
    availableBytes,
    totalBytes,
    level: diskSpaceLevel(availableBytes),
  };
}

export function diskSpaceLevel(availableBytes: number): DiskSpaceLevel {
  if (availableBytes < DISK_SPACE_CRITICAL_BYTES) return "critical";
  if (availableBytes < DISK_SPACE_WARNING_BYTES) return "warning";
  return "ok";
}

/**
 * The backups in `directory`, newest first.
 *
 * Only files matching this app's own backup naming are listed, which is also
 * the allowlist the restore path validates against: an unrelated `.sql.gz` an
 * operator dropped in the directory is not offered, and neither is a symlink or
 * a subdirectory.
 */
export function listLocalBackups(directory: string): LocalBackupFile[] {
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: LocalBackupFile[] = [];
  for (const entry of entries) {
    // `isFile()` on a Dirent follows nothing — a symlink reports as a symlink,
    // so a link pointing at /etc/passwd is never listed or restorable.
    if (!entry.isFile()) continue;
    if (!BACKUP_FILENAME_REGEX.test(entry.name)) continue;
    const stats = statSync(path.join(directory, entry.name));
    files.push({
      filename: entry.name,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * Resolve a client-supplied FILENAME to a file inside `directory`.
 *
 * The client never sends a path, and this never joins one blindly: the name has
 * to appear in the directory's own listing, and the joined result has to still
 * sit directly inside the resolved directory. Two checks for one question,
 * because this feeds `psql`.
 */
export function resolveLocalBackupFile(
  directory: string,
  filename: string,
): string {
  const resolvedDirectory = resolveLocalBackupDirectory(directory);
  const candidate = (filename ?? "").trim();
  if (!BACKUP_FILENAME_REGEX.test(candidate)) {
    throw new LocalBackupPathError("That is not a recognised backup filename.");
  }
  const known = listLocalBackups(resolvedDirectory).some(
    (file) => file.filename === candidate,
  );
  if (!known) {
    throw new LocalBackupPathError("That backup no longer exists.");
  }
  const filepath = path.join(resolvedDirectory, candidate);
  if (path.dirname(path.resolve(filepath)) !== resolvedDirectory) {
    throw new LocalBackupPathError("That is not a recognised backup filename.");
  }
  return filepath;
}

/** Copy a finished dump into the local backup directory. Returns its path. */
export function storeLocalBackup(sourcePath: string, directory: string): string {
  const resolved = resolveLocalBackupDirectory(directory);
  mkdirSync(resolved, { recursive: true });
  const destination = path.join(resolved, path.basename(sourcePath));
  copyFileSync(sourcePath, destination);
  return destination;
}

/**
 * Delete local backups older than the retention window.
 *
 * The SAME retention the S3 destination uses, by owner instruction — one number
 * for the whole feature rather than a second one to keep in step. Returns the
 * filenames removed so the run summary can say what it deleted rather than
 * leaving an operator to notice files vanishing.
 */
export function pruneLocalBackups(
  directory: string,
  retentionDays: number,
): string[] {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const file of listLocalBackups(directory)) {
    if (new Date(file.modifiedAt).getTime() >= cutoff) continue;
    try {
      unlinkSync(path.join(directory, file.filename));
      removed.push(file.filename);
    } catch {
      // A file we cannot delete is not a reason to fail the backup that just
      // succeeded; the next run tries again and the disk-space warning on the
      // screen is what makes a directory that never drains visible.
    }
  }
  return removed;
}
