// Fail-closed verifier for the immutable inputs used by one measurement side.
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyCorrectnessCompletion } from "./verify-correctness-evidence.mjs";

function fail(message) { throw new Error(message); }
function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}
function requiredFile(path, label) {
  const absolute = resolve(path);
  try { if (!statSync(absolute).isFile()) fail(`${label} is not a file: ${absolute}`); }
  catch { fail(`${label} is missing: ${absolute}`); }
  return absolute;
}
function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) fail(`--${name} is required`);
  return process.argv[index + 1];
}
function expectHex(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) fail(`${label} must be a lowercase SHA-256`);
}
function tarText(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end >= offset && end < offset + length ? end : offset + length).toString("utf8");
}
function gitArchiveRevision(path) {
  const archive = readFileSync(path);
  const revisions = new Set();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const checksumText = tarText(header, 148, 8).trim();
    if (!/^[0-7]+$/.test(checksumText)) fail("source archive contains an invalid tar checksum field");
    const expectedChecksum = Number.parseInt(checksumText, 8);
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte), 0);
    if (actualChecksum !== expectedChecksum) fail("source archive contains an invalid tar header checksum");
    const sizeText = tarText(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) fail("source archive contains an invalid tar size field");
    const size = Number.parseInt(sizeText, 8);
    const dataOffset = offset + 512;
    if (!Number.isSafeInteger(size) || dataOffset + size > archive.length) fail("source archive contains a truncated tar member");
    if (header[156] === 0x67) {
      const payload = archive.subarray(dataOffset, dataOffset + size).toString("utf8");
      for (let cursor = 0; cursor < payload.length;) {
        const space = payload.indexOf(" ", cursor);
        if (space < 0) fail("source archive contains an invalid PAX record");
        const lengthText = payload.slice(cursor, space);
        if (!/^[1-9][0-9]*$/.test(lengthText)) fail("source archive contains an invalid PAX record length");
        const recordLength = Number.parseInt(lengthText, 10);
        const record = payload.slice(space + 1, cursor + recordLength);
        if (record.length !== cursor + recordLength - space - 1 || !record.endsWith("\n")) {
          fail("source archive contains a truncated PAX record");
        }
        const equals = record.indexOf("=");
        if (equals > 0 && record.slice(0, equals) === "comment") revisions.add(record.slice(equals + 1, -1));
        cursor += recordLength;
      }
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  if (revisions.size !== 1) fail(`source archive must contain exactly one git archive revision, found ${revisions.size}`);
  const [revision] = revisions;
  if (!/^[a-f0-9]{40,64}$/.test(revision)) fail("source archive git revision is invalid");
  return revision;
}

const manifestPath = requiredFile(arg("manifest"), "correctness manifest");
const inspectPath = requiredFile(arg("image-inspect"), "image inspect");
const imageReference = arg("image-reference");
const side = arg("side");
const out = resolve(arg("out"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schema_version !== 1 || manifest.harness_scope !== "issue-2352-phase2") {
  fail("unsupported correctness manifest schema/scope");
}
const binding = manifest.sides?.[side];
if (!binding) fail(`correctness manifest has no ${side} binding`);
if (!/^(sha256:[a-f0-9]{64}|.+@sha256:[a-f0-9]{64})$/.test(binding.image_reference ?? "")) {
  fail(`${side}.image_reference must be an immutable image ID or repo digest`);
}
if (binding.image_reference !== imageReference) {
  fail(`image reference mismatch: manifest binds ${binding.image_reference}, runner received ${imageReference}`);
}
const image = JSON.parse(readFileSync(inspectPath, "utf8"));
if (!Array.isArray(image) || image.length !== 1) fail("image inspect must contain exactly one image");
const inspected = image[0];
if (!/^sha256:[a-f0-9]{64}$/.test(binding.image_id ?? "")) fail(`${side}.image_id is not immutable`);
if (inspected.Id !== binding.image_id) fail(`image id mismatch: expected ${binding.image_id}, got ${inspected.Id}`);
const revision = inspected.Config?.Labels?.["org.opencontainers.image.revision"];
if (!/^[a-f0-9]{40,64}$/.test(binding.oci_revision ?? "")) fail(`${side}.oci_revision is invalid`);
if (revision !== binding.oci_revision) fail(`OCI revision mismatch: expected ${binding.oci_revision}, got ${revision ?? "absent"}`);

for (const [field, label] of [["source_archive", "source archive"], ["correctness_completion", "correctness completion"]]) {
  const entry = binding[field];
  if (!entry?.path) fail(`${side}.${field}.path is required`);
  expectHex(entry.sha256, `${side}.${field}.sha256`);
  const path = requiredFile(entry.path, label);
  const actual = sha256(path);
  if (actual !== entry.sha256) fail(`${label} checksum mismatch: expected ${entry.sha256}, got ${actual}`);
}
const archiveRevision = gitArchiveRevision(resolve(binding.source_archive.path));
if (archiveRevision !== binding.oci_revision) fail(`${side} source archive revision ${archiveRevision} does not match OCI revision ${binding.oci_revision}`);
let correctness;
try {
  correctness = verifyCorrectnessCompletion(resolve(binding.correctness_completion.path));
} catch (error) {
  fail(`${side} correctness completion chain did not verify as pre-timing ready: ${error.message}`);
}
expectHex(manifest.canonical_database?.archive_sha256, "canonical_database.archive_sha256");
const archive = requiredFile(manifest.canonical_database?.archive_path, "canonical database archive");
const archiveSha = sha256(archive);
if (archiveSha !== manifest.canonical_database.archive_sha256) {
  fail(`canonical database archive checksum mismatch: expected ${manifest.canonical_database.archive_sha256}, got ${archiveSha}`);
}

const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => JSON.stringify(canonicalize(value));
if (canonicalJson(binding.routes) !== canonicalJson(correctness.routeExpectations.routes)) {
  fail(`${side}.routes differs from the independently parsed sealed correctness route evidence`);
}
if (
  correctness.immutable.side !== side ||
  correctness.immutable.image.id !== binding.image_id ||
  correctness.immutable.image.oci_revision !== binding.oci_revision ||
  correctness.immutable.source.archive_sha256 !== binding.source_archive.sha256 ||
  correctness.immutable.database.archive_sha256 !== archiveSha
) {
  fail(`${side} correctness completion chain is not bound to the exact image, source archive, and database archive`);
}

const result = {
  schema_version: 1,
  side,
  manifest_path: manifestPath,
  manifest_sha256: sha256(manifestPath),
  image_id: inspected.Id,
  image_reference: binding.image_reference,
  repo_digests: inspected.RepoDigests ?? [],
  oci_revision: revision,
  source_archive_sha256: binding.source_archive.sha256,
  source_archive_revision: archiveRevision,
  producer_source_archive_sha256: correctness.immutable.producer_source.archive_sha256,
  producer_source_commit: correctness.immutable.producer_source.commit,
  correctness_completion_sha256: binding.correctness_completion.sha256,
  correctness_report_sha256: correctness.completion.correctness_report_sha256,
  correctness_result: correctness.report.result,
  canonical_database_archive_sha256: archiveSha,
  verified: true,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`verified immutable ${side} binding -> ${out}`);
