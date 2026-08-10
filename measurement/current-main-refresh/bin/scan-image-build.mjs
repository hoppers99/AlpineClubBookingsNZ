import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { posix, resolve } from "node:path";

const [imageId, ociRevision] = process.argv.slice(2);
if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? "")) throw new Error("image id is invalid");
if (!/^[a-f0-9]{40,64}$/.test(ociRevision ?? "")) throw new Error("OCI revision is invalid");

const roots = ["/app/.next/server", "/app/.next/static"];
const files = [];
for (const root of roots) {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== resolve(root)) {
    throw new Error(`compiled root is not a canonical directory: ${root}`);
  }
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = posix.join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`compiled artifact is a symlink: ${path}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path, size: stat.size });
      else throw new Error(`compiled artifact has an unsupported file type: ${path}`);
    }
  };
  walk(root);
}
files.sort((left, right) => left.path.localeCompare(right.path));
if (files.length === 0) throw new Error("compiled image scan found no files");

const aggregate = createHash("sha256");
const dsnPattern = /https?:\/\/[A-Za-z0-9_-]{8,}@[A-Za-z0-9.-]+(?::\d+)?\/\d+/g;
const locations = [];
let bytes = 0;
let dsnLiteralCount = 0;
let identifierCount = 0;
for (const file of files) {
  const body = readFileSync(file.path);
  const fileHash = createHash("sha256").update(body).digest("hex");
  aggregate.update(file.path).update("\0").update(fileHash).update("\0").update(String(file.size)).update("\n");
  bytes += file.size;
  const text = body.toString("utf8");
  const dsnCount = text.match(dsnPattern)?.length ?? 0;
  const publicIdentifierCount = text.match(/NEXT_PUBLIC_SENTRY_DSN/g)?.length ?? 0;
  dsnLiteralCount += dsnCount;
  identifierCount += publicIdentifierCount;
  if (dsnCount > 0 || publicIdentifierCount > 0) {
    locations.push({ path: file.path, sha256: fileHash, dsn_literal_count: dsnCount, public_identifier_count: publicIdentifierCount });
  }
}

process.stdout.write(JSON.stringify({
  schema_version: 1,
  image_id: imageId,
  oci_revision: ociRevision,
  scanned_roots: roots,
  scanned_file_count: files.length,
  scanned_bytes: bytes,
  filesystem_aggregate_sha256: aggregate.digest("hex"),
  public_sentry_dsn_literal_count: dsnLiteralCount,
  public_sentry_identifier_count: identifierCount,
  locations,
}, null, 2) + "\n");
