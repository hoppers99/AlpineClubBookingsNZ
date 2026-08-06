import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const arg = (name) => {
  const value = args.get(`--${name}`);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};
const safeId = (value, label) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
};
const hex = (value, label, revision = false) => {
  const pattern = revision ? /^[a-f0-9]{40,64}$/ : /^[a-f0-9]{64}$/;
  if (!pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
};
const file = (value, label) => {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const absolute = resolve(value);
  const stat = lstatSync(absolute);
  const real = realpathSync(absolute);
  const samePath = process.platform === "win32" ? real.toLowerCase() === absolute.toLowerCase() : real === absolute;
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath) throw new Error(`${label} is not a canonical regular file`);
  return absolute;
};
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const tarText = (buffer, offset, length) => {
  const zero = buffer.indexOf(0, offset);
  return buffer.subarray(offset, zero >= offset && zero < offset + length ? zero : offset + length).toString("utf8");
};
const gitArchiveRevision = (path) => {
  const archive = readFileSync(path);
  const revisions = new Set();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const checksumText = tarText(header, 148, 8).trim();
    if (!/^[0-7]+$/.test(checksumText)) throw new Error("source archive tar checksum field is invalid");
    const expected = Number.parseInt(checksumText, 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte), 0);
    if (expected !== actual) throw new Error("source archive tar checksum is invalid");
    const sizeText = tarText(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("source archive tar size is invalid");
    const size = Number.parseInt(sizeText, 8);
    const dataOffset = offset + 512;
    if (!Number.isSafeInteger(size) || dataOffset + size > archive.length) throw new Error("source archive is truncated");
    if (header[156] === 0x67) {
      const payload = archive.subarray(dataOffset, dataOffset + size).toString("utf8");
      for (let cursor = 0; cursor < payload.length;) {
        const space = payload.indexOf(" ", cursor);
        if (space < 0) throw new Error("source archive PAX record is invalid");
        const recordLength = Number.parseInt(payload.slice(cursor, space), 10);
        if (!Number.isSafeInteger(recordLength) || recordLength <= 0) throw new Error("source archive PAX length is invalid");
        const record = payload.slice(space + 1, cursor + recordLength);
        if (!record.endsWith("\n")) throw new Error("source archive PAX record is truncated");
        const equals = record.indexOf("=");
        if (record.slice(0, equals) === "comment") revisions.add(record.slice(equals + 1, -1));
        cursor += recordLength;
      }
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  if (revisions.size !== 1) throw new Error(`source archive must have one git revision, got ${revisions.size}`);
  return [...revisions][0];
};
const checked = (pathName, shaName, label) => {
  const path = file(arg(pathName), label);
  const expected = hex(arg(shaName), `${label} sha256`);
  const actual = sha(path);
  if (actual !== expected) throw new Error(`${label} checksum mismatch`);
  return { path, sha256: actual };
};
const runId = safeId(arg("run-id"), "run id");
const side = arg("side");
if (!new Set(["current", "baseline"]).has(side)) throw new Error("side must be current or baseline");
const source = checked("source-archive", "source-sha256", "source archive");
const database = checked("database-archive", "database-sha256", "database archive");
const census = checked("census", "census-sha256", "check census");
const producers = checked("producer-files", "producer-files-sha256", "producer file manifest");
const imageInspect = checked("image-inspect", "image-inspect-sha256", "image inspect");
const containerInspect = checked("container-inspect", "container-inspect-sha256", "container inspect");
const imageId = arg("image-id");
if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("image id is invalid");
const imageReference = arg("image-reference");
if (!/^sha256:[a-f0-9]{64}$/.test(imageReference) && !/^.+@sha256:[a-f0-9]{64}$/.test(imageReference)) {
  throw new Error("image reference is not immutable");
}
const fingerprint = hex(arg("database-fingerprint"), "database fingerprint");
const sourceCommit = hex(arg("source-commit"), "source commit", true);
const ociRevision = hex(arg("oci-revision"), "OCI revision", true);
const archiveRevision = gitArchiveRevision(source.path);
if (archiveRevision !== sourceCommit || sourceCommit !== ociRevision) throw new Error("source archive, source commit, and OCI revision differ");
const parsedImageInspect = JSON.parse(readFileSync(imageInspect.path, "utf8"));
if (parsedImageInspect?.id !== imageId || parsedImageInspect?.oci_revision !== ociRevision) {
  throw new Error("selected image inspection disagrees with immutable image identity");
}
const composeProject = safeId(arg("compose-project"), "compose project");
const parsedContainerInspect = JSON.parse(readFileSync(containerInspect.path, "utf8"));
if (parsedContainerInspect?.image_id !== imageId || parsedContainerInspect?.compose_project !== composeProject || parsedContainerInspect?.compose_service !== "app") {
  throw new Error("selected app-container inspection disagrees with image/project/service identity");
}
const result = {
  schema_version: 1,
  run_id: runId,
  side,
  source: { commit: sourceCommit, archive_path: source.path, archive_sha256: source.sha256 },
  image: {
    reference: imageReference,
    id: imageId,
    oci_revision: ociRevision,
    inspect_path: imageInspect.path,
    inspect_sha256: imageInspect.sha256,
  },
  container: { inspect_path: containerInspect.path, inspect_sha256: containerInspect.sha256 },
  database: { archive_path: database.path, archive_sha256: database.sha256, logical_fingerprint_before: fingerprint },
  environment: {
    base_url: arg("base-url"),
    compose_project: composeProject,
    release_id_sha256: hex(arg("release-id-sha256"), "release id sha256"),
  },
  check_census_path: census.path,
  check_census_sha256: census.sha256,
  producer_files_path: producers.path,
  producer_files_sha256: producers.sha256,
  created_at: new Date().toISOString(),
};
writeFileSync(resolve(arg("out")), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
