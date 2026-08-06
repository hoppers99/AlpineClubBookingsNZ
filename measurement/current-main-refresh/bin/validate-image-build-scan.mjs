import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative as relativePath, resolve, sep } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const arg = (name) => {
  const value = args.get(`--${name}`);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};
const regular = (name) => {
  const path = resolve(arg(name));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} is not a regular file`);
  return path;
};
const parse = (path, label) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
};
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const imageId = arg("image-id");
const ociRevision = arg("oci-revision");
if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("image id is invalid");
if (!/^[a-f0-9]{40,64}$/.test(ociRevision)) throw new Error("OCI revision is invalid");
const rawPath = regular("raw");
const runtimePath = regular("runtime-env");
const raw = parse(rawPath, "raw image build scan");
const runtime = parse(runtimePath, "runtime environment proof");
const roots = ["/app/.next/server", "/app/.next/static"];
if (raw?.schema_version !== 1 || raw.image_id !== imageId || raw.oci_revision !== ociRevision) throw new Error("raw image build scan identity is invalid");
if (JSON.stringify(raw.scanned_roots) !== JSON.stringify(roots)) throw new Error("raw image build scan roots are incomplete");
if (!Number.isSafeInteger(raw.scanned_file_count) || raw.scanned_file_count <= 0 || !Number.isSafeInteger(raw.scanned_bytes) || raw.scanned_bytes <= 0) throw new Error("raw image build scan counts are invalid");
if (!/^[a-f0-9]{64}$/.test(raw.filesystem_aggregate_sha256 ?? "")) throw new Error("raw image build aggregate is invalid");
if (raw.public_sentry_dsn_literal_count !== 0) throw new Error("compiled image contains a public Sentry DSN literal");
if (!Number.isSafeInteger(raw.public_sentry_identifier_count) || raw.public_sentry_identifier_count < 0 || !Array.isArray(raw.locations)) throw new Error("raw image build occurrence evidence is invalid");
for (const location of raw.locations) {
  if (typeof location?.path !== "string" || !roots.some((root) => location.path.startsWith(`${root}/`)) || !/^[a-f0-9]{64}$/.test(location.sha256 ?? "") || !Number.isSafeInteger(location.dsn_literal_count) || !Number.isSafeInteger(location.public_identifier_count)) {
    throw new Error("raw image build location is invalid");
  }
}
if (runtime?.schema_version !== 1 || runtime.image_id !== imageId || typeof runtime.present !== "boolean" || runtime.blank !== true) {
  throw new Error("runtime NEXT_PUBLIC_SENTRY_DSN proof is invalid");
}
const runRoot = resolve(arg("run-root"));
const relative = (path) => {
  const normalized = resolve(path);
  const rel = relativePath(runRoot, normalized);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("image evidence path escapes run root");
  return rel.split(sep).join("/");
};
writeFileSync(resolve(arg("out")), JSON.stringify({
  schema_version: 1,
  image_id: imageId,
  oci_revision: ociRevision,
  raw_scan_path: relative(rawPath),
  raw_scan_sha256: sha(rawPath),
  scanned_roots: roots,
  scanned_file_count: raw.scanned_file_count,
  scanned_bytes: raw.scanned_bytes,
  filesystem_aggregate_sha256: raw.filesystem_aggregate_sha256,
  public_sentry_dsn_literal_count: 0,
  runtime_env: { present: runtime.present, blank: true },
  safe_build_input_evidence: {
    status: "unavailable",
    reason: "OCI image metadata does not retain Docker build-argument values; the compiled filesystem scan is authoritative",
  },
  verdict: "passed",
}, null, 2) + "\n", { flag: "wx" });
