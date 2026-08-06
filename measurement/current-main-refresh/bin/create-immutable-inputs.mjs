import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readGitTarArchive } from "../lib/git-tar.mjs";
import { selectProducerSourceMembers } from "../lib/producer-source-set.mjs";
import { verifyRuntimeProvenanceDocument } from "./runtime-provenance.mjs";

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
const source = checked("app-source-archive", "app-source-sha256", "application source archive");
const producerSource = checked("producer-source-archive", "producer-source-sha256", "producer source archive");
const database = checked("database-archive", "database-sha256", "database archive");
const census = checked("census", "census-sha256", "check census");
const writerCensus = checked("writer-census", "writer-census-sha256", "public writer census");
const producers = checked("producer-files", "producer-files-sha256", "producer file manifest");
const imageInspect = checked("image-inspect", "image-inspect-sha256", "image inspect");
const containerInspect = checked("container-inspect", "container-inspect-sha256", "container inspect");
const imageBuildRaw = checked("image-build-raw", "image-build-raw-sha256", "raw image build scan");
const imageBuildEvidence = checked("image-build-evidence", "image-build-evidence-sha256", "typed image build evidence");
const imageBuildRuntime = checked("image-build-runtime", "image-build-runtime-sha256", "image build runtime environment proof");
const runtimeProvenance = checked("runtime-provenance", "runtime-provenance-sha256", "installed runtime provenance");
const stackIdentityBefore = checked("stack-identity-before", "stack-identity-before-sha256", "before-run stack identity");
const imageId = arg("image-id");
if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("image id is invalid");
const imageReference = arg("image-reference");
if (!/^sha256:[a-f0-9]{64}$/.test(imageReference) && !/^.+@sha256:[a-f0-9]{64}$/.test(imageReference)) {
  throw new Error("image reference is not immutable");
}
const fingerprint = hex(arg("database-fingerprint"), "database fingerprint");
const sourceCommit = hex(arg("app-source-commit"), "application source commit", true);
const producerSourceCommit = hex(arg("producer-source-commit"), "producer source commit", true);
const ociRevision = hex(arg("oci-revision"), "OCI revision", true);
if (sourceCommit === producerSourceCommit || source.sha256 === producerSource.sha256) throw new Error("application and producer source authorities must be distinct");
const appArchive = readGitTarArchive(source.path, sourceCommit);
if (appArchive.archive_sha256 !== source.sha256 || sourceCommit !== ociRevision) throw new Error("source archive, source commit, and OCI revision differ");
const producerArchive = readGitTarArchive(producerSource.path, producerSourceCommit);
if (producerArchive.archive_sha256 !== producerSource.sha256) throw new Error("producer archive checksum disagrees with parsed archive");
const producerManifestText = readFileSync(producers.path, "utf8");
const producerManifestLines = producerManifestText.trimEnd().split(/\r?\n/);
if (producerManifestLines[0] !== "# schema_version=1" || producerManifestLines[1] !== `# producer_source_archive_sha256=${producerSource.sha256}` || producerManifestLines[2] !== `# producer_source_commit=${producerSourceCommit}`) {
  throw new Error("producer file manifest does not have the exact archive-bound header");
}
const manifestRows = producerManifestLines.slice(3).map((line) => {
  const match = /^([a-f0-9]{64})  ([^/].*)$/.exec(line);
  if (!match) throw new Error("producer file manifest row is invalid");
  return { sha256: match[1], path: match[2] };
});
const expectedManifestRows = selectProducerSourceMembers(producerArchive);
const manifestMismatch = manifestRows.length !== expectedManifestRows.length || manifestRows.some((row, index) => row.path !== expectedManifestRows[index]?.path || row.sha256 !== expectedManifestRows[index]?.sha256);
if (manifestMismatch) {
  const index = Math.max(0, manifestRows.findIndex((row, rowIndex) => row.path !== expectedManifestRows[rowIndex]?.path || row.sha256 !== expectedManifestRows[rowIndex]?.sha256));
  throw new Error(`producer file manifest is not the exact complete archive-derived source set at row ${index}: actual=${JSON.stringify(manifestRows[index] ?? null)} expected=${JSON.stringify(expectedManifestRows[index] ?? null)}`);
}
for (const [label, path, expectedSha256] of [
  ["check census", "measurement/current-main-refresh/check-census.json", census.sha256],
  ["public writer census", "measurement/current-main-refresh/public-writer-census.json", writerCensus.sha256],
]) {
  if (producerArchive.members.get(path)?.sha256 !== expectedSha256) throw new Error(`${label} is not the exact producer source archive member`);
}
const parsedImageInspect = JSON.parse(readFileSync(imageInspect.path, "utf8"));
if (parsedImageInspect?.id !== imageId || parsedImageInspect?.oci_revision !== ociRevision) {
  throw new Error("selected image inspection disagrees with immutable image identity");
}
const parsedImageBuildEvidence = JSON.parse(readFileSync(imageBuildEvidence.path, "utf8"));
if (parsedImageBuildEvidence?.schema_version !== 1 || parsedImageBuildEvidence?.image_id !== imageId || parsedImageBuildEvidence?.oci_revision !== ociRevision || parsedImageBuildEvidence?.verdict !== "passed" || parsedImageBuildEvidence?.public_sentry_dsn_literal_count !== 0 || parsedImageBuildEvidence?.runtime_env?.blank !== true) {
  throw new Error("typed image build evidence does not prove the selected image safe");
}
const parsedRuntimeProvenance = JSON.parse(readFileSync(runtimeProvenance.path, "utf8"));
const runtimeFile = (value) => isAbsolute(value?.path ?? "") && Number.isSafeInteger(value?.size_bytes) && value.size_bytes >= 0 && /^[a-f0-9]{64}$/.test(value?.sha256 ?? "");
const runtimePackages = ["@playwright/test", "playwright", "playwright-core", "axe-core"];
const packageEvidenceValid = runtimePackages.every((name) => {
  const value = parsedRuntimeProvenance?.packages?.[name];
  return typeof value?.version === "string" && value.version.length > 0 && isAbsolute(value?.package_json_path ?? "") && /^[a-f0-9]{64}$/.test(value?.package_json_sha256 ?? "") &&
    /^sha512-[A-Za-z0-9+/=]+$/.test(value?.root_lock_integrity ?? "") && value.installed_lock_integrity === value.root_lock_integrity;
});
if (parsedRuntimeProvenance?.schema_version !== 1 || !/^v\d+(?:\.\d+){2}$/.test(parsedRuntimeProvenance?.node?.version ?? "") || !runtimeFile(parsedRuntimeProvenance?.node?.executable) ||
    !runtimeFile(parsedRuntimeProvenance?.root_package) || !runtimeFile(parsedRuntimeProvenance?.root_lock) || parsedRuntimeProvenance?.root_lock?.lockfile_version !== 3 ||
    !runtimeFile(parsedRuntimeProvenance?.installed_lock) || parsedRuntimeProvenance?.installed_lock?.lockfile_version !== 3 || Object.keys(parsedRuntimeProvenance?.packages ?? {}).sort().join("|") !== [...runtimePackages].sort().join("|") || !packageEvidenceValid ||
    !/^\d+(?:\.\d+){2,3}$/.test(parsedRuntimeProvenance?.chromium?.browser_version ?? "") || !/^\d+$/.test(parsedRuntimeProvenance?.chromium?.revision ?? "") || !runtimeFile(parsedRuntimeProvenance?.chromium?.registry) || !runtimeFile(parsedRuntimeProvenance?.chromium?.executable)) {
  throw new Error("installed runtime provenance schema is invalid");
}
await verifyRuntimeProvenanceDocument(parsedRuntimeProvenance, process.cwd());
const parsedStackIdentity = JSON.parse(readFileSync(stackIdentityBefore.path, "utf8"));
if (parsedStackIdentity?.schema_version !== 1 || parsedStackIdentity?.stage !== "before" || parsedStackIdentity?.compose_project !== arg("compose-project") || parsedStackIdentity?.image_id !== imageId || parsedStackIdentity?.database?.logical_fingerprint !== fingerprint || parsedStackIdentity?.verified !== true) {
  throw new Error("before-run stack identity is invalid");
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
  producer_source: { commit: producerSourceCommit, archive_path: producerSource.path, archive_sha256: producerSource.sha256 },
  image: {
    reference: imageReference,
    id: imageId,
    oci_revision: ociRevision,
    inspect_path: imageInspect.path,
    inspect_sha256: imageInspect.sha256,
    build_evidence: {
      raw_path: imageBuildRaw.path,
      raw_sha256: imageBuildRaw.sha256,
      typed_path: imageBuildEvidence.path,
      typed_sha256: imageBuildEvidence.sha256,
      runtime_path: imageBuildRuntime.path,
      runtime_sha256: imageBuildRuntime.sha256,
    },
  },
  container: { inspect_path: containerInspect.path, inspect_sha256: containerInspect.sha256 },
  runtime_provenance: { path: runtimeProvenance.path, sha256: runtimeProvenance.sha256 },
  stack_identity_before: { path: stackIdentityBefore.path, sha256: stackIdentityBefore.sha256 },
  database: { archive_path: database.path, archive_sha256: database.sha256, logical_fingerprint_before: fingerprint },
  environment: {
    base_url: arg("base-url"),
    compose_project: composeProject,
    release_id_sha256: hex(arg("release-id-sha256"), "release id sha256"),
  },
  check_census_path: census.path,
  check_census_sha256: census.sha256,
  writer_census_path: writerCensus.path,
  writer_census_sha256: writerCensus.sha256,
  producer_files_path: producers.path,
  producer_files_sha256: producers.sha256,
  created_at: new Date().toISOString(),
};
writeFileSync(resolve(arg("out")), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
