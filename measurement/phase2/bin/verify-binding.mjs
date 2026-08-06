// Fail-closed verifier for the immutable inputs used by one measurement side.
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

for (const [field, label] of [["source_archive", "source archive"], ["correctness_report", "correctness report"]]) {
  const entry = binding[field];
  if (!entry?.path) fail(`${side}.${field}.path is required`);
  expectHex(entry.sha256, `${side}.${field}.sha256`);
  const path = requiredFile(entry.path, label);
  const actual = sha256(path);
  if (actual !== entry.sha256) fail(`${label} checksum mismatch: expected ${entry.sha256}, got ${actual}`);
}
if (binding.correctness_report.result !== "passed") {
  fail(`${side} correctness report must be explicitly recorded as passed before timing`);
}
expectHex(manifest.canonical_database?.archive_sha256, "canonical_database.archive_sha256");
const archive = requiredFile(manifest.canonical_database?.archive_path, "canonical database archive");
const archiveSha = sha256(archive);
if (archiveSha !== manifest.canonical_database.archive_sha256) {
  fail(`canonical database archive checksum mismatch: expected ${manifest.canonical_database.archive_sha256}, got ${archiveSha}`);
}

const routes = binding.routes;
for (const route of ["/about", "/", "/join", "/contact"]) {
  const expected = routes?.[route];
  if (!expected) fail(`${side}.routes[${JSON.stringify(route)}] is required`);
  const allowed = side === "current" && route === "/about" ? ["HIT"] : ["ABSENT"];
  if (!allowed.includes(expected.next_cache)) {
    fail(`${side} ${route} next_cache must be ${allowed.join(" or ")}, got ${expected.next_cache}`);
  }
  if (side === "current" && route === "/about") {
    expectHex(expected.body_sha256, `${side} ${route} body_sha256`);
    if (!expected.etag) fail(`${side} ${route} etag is required`);
  } else if (expected.body_sha256 !== null || expected.etag !== null) {
    fail(`${side} ${route} is dynamic; body_sha256 and etag must be null rather than pretending per-request nonce output is stable`);
  }
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
  correctness_report_sha256: binding.correctness_report.sha256,
  correctness_result: binding.correctness_report.result,
  canonical_database_archive_sha256: archiveSha,
  verified: true,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`verified immutable ${side} binding -> ${out}`);
