import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { readGitArchive } from "./git-archive.mjs";

const fail = (message) => { throw new Error(message); };
export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const OUTCOMES = Object.freeze(["PASS", "FAIL", "UNVERIFIED", "OWNER_DISPOSITION_NEEDED", "NOT_APPLICABLE"]);

const check = (id, requirementClass, requiredSides, allowedProducers) => Object.freeze({ id, requirement_class: requirementClass, required_sides: Object.freeze(requiredSides), allowed_producers: Object.freeze(allowedProducers) });
export const CORRECTNESS_CENSUS = Object.freeze([
  check("MC-01A", "mandatory_pass", ["current"], ["browser-suite"]), check("MC-01B", "mandatory_pass", ["current"], ["browser-suite"]),
  check("MC-02", "mandatory_pass", ["current"], ["browser-suite", "cms-lifecycle"]),
  check("MC-03A", "mandatory_pass", ["current"], ["cms-lifecycle"]), check("MC-03B", "mandatory_pass", ["current"], ["cms-lifecycle"]), check("MC-03C", "mandatory_pass", ["current"], ["cms-lifecycle"]),
  check("MC-03D", "owner_disposition", ["current"], ["source-census"]),
  check("MC-04A", "mandatory_pass", ["current"], ["public-layout-writers"]), check("MC-04B", "mandatory_pass", ["current"], ["public-layout-writers"]), check("MC-04C", "mandatory_pass", ["current"], ["public-layout-writers"]),
  check("MC-04D", "mandatory_pass", ["current"], ["source-census", "adult-hosting"]),
  check("MC-05", "mandatory_pass", ["current"], ["stored-404", "wire-security"]), check("MC-06", "mandatory_pass", ["current"], ["browser-suite", "wire-security"]),
  check("MC-07", "mandatory_pass", ["current"], ["cache-fault"]), check("MC-08A", "mandatory_pass", ["current"], ["cache-fault"]), check("MC-08B", "mandatory_pass", ["current"], ["phase2-evidence"]),
  check("MC-09", "mandatory_pass", ["current"], ["log-noise"]), check("MC-10", "mandatory_pass", ["current"], ["deploy-warmup"]),
  ...["MC-11A", "MC-11B", "MC-11C", "MC-11D", "MC-11E"].map((id) => check(id, "mandatory_pass", ["current"], ["browser-suite"])),
  check("BND-01", "supporting_required", ["current", "baseline"], ["route-manifests"]), check("BND-02", "supporting_required", ["current", "baseline"], ["cms-lifecycle", "phase2-evidence"]),
  check("BND-03", "supporting_required", ["current"], ["revalidation-300s"]),
  ...["BND-04", "BND-05", "BND-06", "BND-07"].map((id) => check(id, "supporting_required", ["current"], ["wire-security", "browser-suite"])),
  check("BND-08", "supporting_required", ["current"], ["warm-db"]), check("BND-09", "supporting_required", ["current", "baseline"], ["phase2-evidence"]),
  check("BND-10", "supporting_required", ["current"], ["setup-transition"]), check("BND-11", "supporting_required", ["current"], ["wire-security", "adult-hosting"]), check("BND-12", "supporting_required", ["current"], ["stored-404"]),
]);
export const MANDATORY_CORRECTNESS_CHECK_IDS = Object.freeze(CORRECTNESS_CENSUS.map(({ id }) => id));
export const REVIEWED_CHECK_CENSUS = Object.freeze({
  schema_version: 1,
  scope: "issue-2352-slice1-correctness",
  owner_anchors: Object.freeze({
    mandatory: "https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2352#issuecomment-5162689668",
    option_a: "https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2352#issuecomment-5165032474",
    d1_narrowing: "https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2352#issuecomment-5161243325",
    f1_f3: "https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2352#issuecomment-5148840794",
    stored_404_residual: "https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2570#issuecomment-5164422123",
    mc03d_disposition_request: "https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2352#issuecomment-5204133776",
  }),
  checks: CORRECTNESS_CENSUS,
});

export const REVIEWED_PRODUCER_IDS = Object.freeze(["route-manifests", "cms-lifecycle", "cache-fault", "source-census", "browser-suite", "wire-security", "stored-404", "public-layout-writers", "revalidation-300s", "warm-db", "adult-hosting", "deploy-warmup", "setup-transition", "log-noise"]);
export const FINALIZER_OWNED_PRODUCER_IDS = Object.freeze(["phase2-evidence"]);
export const PRODUCER_SOURCE_REGISTRY = Object.freeze({
  "route-manifests": "measurement/current-main-refresh/run-route-manifests.sh",
  "cms-lifecycle": "measurement/current-main-refresh/run-cms-lifecycle.sh",
  "cache-fault": "measurement/current-main-refresh/run-cache-fault.sh",
  "source-census": "measurement/current-main-refresh/run-source-census.sh",
  "browser-suite": "measurement/current-main-refresh/run-browser-suite.sh",
  "wire-security": "measurement/current-main-refresh/run-wire-security.sh",
  "stored-404": "measurement/current-main-refresh/run-stored-404.sh",
  "public-layout-writers": "measurement/current-main-refresh/run-public-layout-writers.sh",
  "revalidation-300s": "measurement/current-main-refresh/run-revalidation-300s.sh",
  "warm-db": "measurement/current-main-refresh/run-warm-db.sh",
  "adult-hosting": "measurement/current-main-refresh/run-adult-hosting-producer.sh",
  "deploy-warmup": "measurement/current-main-refresh/run-deploy-warmup.sh",
  "setup-transition": "measurement/current-main-refresh/run-setup-transition.sh",
  "log-noise": "measurement/current-main-refresh/run-log-noise.sh",
});
export const PRODUCER_CHECK_SCHEMA = Object.freeze({
  current: Object.freeze({
    "route-manifests": Object.freeze(["BND-01"]),
    "cms-lifecycle": Object.freeze(["MC-02", "MC-03A", "MC-03B", "MC-03C", "BND-02"]),
    "cache-fault": Object.freeze(["MC-07", "MC-08A"]),
    "source-census": Object.freeze(["MC-03D", "MC-04D"]),
    "browser-suite": Object.freeze(["MC-01A", "MC-01B", "MC-06", "MC-11A", "MC-11B", "MC-11C", "MC-11D", "MC-11E"]),
    "wire-security": Object.freeze(["MC-05", "MC-06", "BND-04", "BND-05", "BND-06", "BND-07", "BND-11"]),
    "stored-404": Object.freeze(["MC-05", "BND-12"]),
    "public-layout-writers": Object.freeze(["MC-04A", "MC-04B", "MC-04C"]),
    "revalidation-300s": Object.freeze(["BND-03"]),
    "warm-db": Object.freeze(["BND-08"]),
    "adult-hosting": Object.freeze(["MC-04D", "BND-11"]),
    "deploy-warmup": Object.freeze(["MC-10"]),
    "setup-transition": Object.freeze(["BND-10"]),
    "log-noise": Object.freeze(["MC-09"]),
  }),
  baseline: Object.freeze({
    "route-manifests": Object.freeze(["BND-01"]),
    "cms-lifecycle": Object.freeze(["BND-02"]),
  }),
});
export const EXPECTED_PRODUCER_SOURCE_PATHS = Object.freeze([
  "measurement/current-main-refresh/README.md",
  "measurement/current-main-refresh/bin/analyse-deploy-warmup.mjs", "measurement/current-main-refresh/bin/analyse-log-noise.mjs", "measurement/current-main-refresh/bin/analyse-route-manifests.mjs",
  "measurement/current-main-refresh/bin/analyse-stored-404.mjs", "measurement/current-main-refresh/bin/build-canonical-contract.mjs", "measurement/current-main-refresh/bin/build-producer-manifest.mjs",
  "measurement/current-main-refresh/bin/build-route-response-evidence.mjs", "measurement/current-main-refresh/bin/build-stack-identity.mjs", "measurement/current-main-refresh/bin/create-immutable-inputs.mjs",
  "measurement/current-main-refresh/bin/generate-source-census.mjs", "measurement/current-main-refresh/bin/observe-stored-404-browser.mjs", "measurement/current-main-refresh/bin/run-browser-suite.mjs",
  "measurement/current-main-refresh/bin/scan-image-build.mjs", "measurement/current-main-refresh/bin/validate-image-build-scan.mjs",
  "measurement/current-main-refresh/check-census.json", "measurement/current-main-refresh/lib/producer.sh", "measurement/current-main-refresh/lib/write-producer-result.mjs",
  "measurement/current-main-refresh/public-writer-census.json", "measurement/current-main-refresh/run-adult-hosting-invalidation.sh", "measurement/current-main-refresh/run-adult-hosting-producer.sh",
  "measurement/current-main-refresh/run-browser-suite.sh", "measurement/current-main-refresh/run-cache-fault.sh", "measurement/current-main-refresh/run-cms-lifecycle.sh",
  "measurement/current-main-refresh/run-correctness-producers.sh", "measurement/current-main-refresh/run-deploy-warmup.sh", "measurement/current-main-refresh/run-log-noise.sh",
  "measurement/current-main-refresh/run-public-layout-writers.sh", "measurement/current-main-refresh/run-revalidation-300s.sh", "measurement/current-main-refresh/run-route-manifests.sh",
  "measurement/current-main-refresh/run-setup-transition.sh", "measurement/current-main-refresh/run-source-census.sh", "measurement/current-main-refresh/run-stored-404.sh", "measurement/current-main-refresh/run-warm-db.sh", "measurement/current-main-refresh/run-wire-security.sh",
  "measurement/current-main-refresh/self-test.mjs", "measurement/stack/docker-compose.measure.yml", "measurement/stack/measure-stack.sh",
].sort((left, right) => left.localeCompare(right)));

export const expectedCheckIdsForSide = (side) => {
  if (!["current", "baseline"].includes(side)) fail(`invalid correctness side: ${side}`);
  return CORRECTNESS_CENSUS.filter((check) => check.required_sides.includes(side)).map((check) => check.id);
};
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail(`${label} has an invalid schema`);
};
export const canonicalRelative = (value, label) => {
  if (typeof value !== "string" || value === "" || isAbsolute(value) || value.includes("\\") || /[\0\r\n\t]/.test(value) || posix.normalize(value) !== value || value === ".." || value.startsWith("../")) fail(`${label} is not a canonical relative path`);
  return value;
};
const validUtc = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const safeCount = (value, positive = false) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0);

function validateImageBuildEvidence(value, root, immutableImage) {
  const expectedRoots = ["/app/.next/server", "/app/.next/static"];
  const rawPath = join(root, "inputs", "image-build-scan.raw.json");
  const typedPath = join(root, "inputs", "image-build-identity.json");
  const runtimePath = join(root, "inputs", "image-build-runtime-env.json");
  const same = (left, right) => process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
  exactKeys(value, ["raw_path", "raw_sha256", "typed_path", "typed_sha256", "runtime_path", "runtime_sha256"], "image build evidence binding");
  if (!same(value.raw_path, rawPath) || !same(value.typed_path, typedPath) || !same(value.runtime_path, runtimePath)) fail("image build evidence paths are not canonical run inputs");
  if (!hex(value.raw_sha256) || !hex(value.typed_sha256) || !hex(value.runtime_sha256) || sha256File(rawPath) !== value.raw_sha256 || sha256File(typedPath) !== value.typed_sha256 || sha256File(runtimePath) !== value.runtime_sha256) fail("image build evidence checksum binding failed");
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  exactKeys(raw, ["schema_version", "image_id", "oci_revision", "scanned_roots", "scanned_file_count", "scanned_bytes", "filesystem_aggregate_sha256", "public_sentry_dsn_literal_count", "public_sentry_identifier_count", "locations"], "raw image build scan");
  if (raw.schema_version !== 1 || raw.image_id !== immutableImage.id || raw.oci_revision !== immutableImage.oci_revision || JSON.stringify(raw.scanned_roots) !== JSON.stringify(expectedRoots) || !safeCount(raw.scanned_file_count, true) || !safeCount(raw.scanned_bytes, true) || !hex(raw.filesystem_aggregate_sha256) || raw.public_sentry_dsn_literal_count !== 0 || !safeCount(raw.public_sentry_identifier_count) || !Array.isArray(raw.locations)) fail("raw image build scan identity/verdict is invalid");
  const locations = new Set();
  let identifierCount = 0;
  for (const [index, location] of raw.locations.entries()) {
    exactKeys(location, ["path", "sha256", "dsn_literal_count", "public_identifier_count"], `raw image build location ${index}`);
    if (typeof location.path !== "string" || !expectedRoots.some((prefix) => location.path.startsWith(`${prefix}/`)) || locations.has(location.path) || !hex(location.sha256) || !safeCount(location.dsn_literal_count) || !safeCount(location.public_identifier_count) || location.dsn_literal_count + location.public_identifier_count < 1 || location.dsn_literal_count !== 0) fail(`raw image build location is invalid: ${index}`);
    locations.add(location.path); identifierCount += location.public_identifier_count;
  }
  if (identifierCount !== raw.public_sentry_identifier_count) fail("raw image build scan identifier count is inconsistent");
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  exactKeys(runtime, ["schema_version", "image_id", "present", "blank"], "image build runtime environment");
  if (runtime.schema_version !== 1 || runtime.image_id !== immutableImage.id || typeof runtime.present !== "boolean" || runtime.blank !== true) fail("image build runtime environment did not prove a blank public Sentry DSN");
  const typed = JSON.parse(readFileSync(typedPath, "utf8"));
  exactKeys(typed, ["schema_version", "image_id", "oci_revision", "raw_scan_path", "raw_scan_sha256", "scanned_roots", "scanned_file_count", "scanned_bytes", "filesystem_aggregate_sha256", "public_sentry_dsn_literal_count", "runtime_env", "safe_build_input_evidence", "verdict"], "typed image build identity");
  exactKeys(typed.runtime_env, ["present", "blank"], "typed image build runtime environment");
  exactKeys(typed.safe_build_input_evidence, ["status", "reason"], "typed safe build-input evidence");
  const expectedTyped = {
    schema_version: 1, image_id: immutableImage.id, oci_revision: immutableImage.oci_revision,
    raw_scan_path: "inputs/image-build-scan.raw.json", raw_scan_sha256: value.raw_sha256,
    scanned_roots: expectedRoots, scanned_file_count: raw.scanned_file_count, scanned_bytes: raw.scanned_bytes,
    filesystem_aggregate_sha256: raw.filesystem_aggregate_sha256, public_sentry_dsn_literal_count: 0,
    runtime_env: { present: runtime.present, blank: true },
    safe_build_input_evidence: { status: "unavailable", reason: "OCI image metadata does not retain Docker build-argument values; the compiled filesystem scan is authoritative" },
    verdict: "passed",
  };
  if (JSON.stringify(typed) !== JSON.stringify(expectedTyped)) fail("typed image build identity differs from the independently checked raw scan/runtime evidence");
}

export function correctnessCensus() {
  return JSON.parse(JSON.stringify(REVIEWED_CHECK_CENSUS));
}

export function validateCensus(value) {
  exactKeys(value, ["schema_version", "scope", "owner_anchors", "checks"], "check census");
  if (value.schema_version !== 1 || !Array.isArray(value.checks)) fail("check census identity is invalid");
  const expected = correctnessCensus();
  if (JSON.stringify(value) !== JSON.stringify(expected)) fail("check census differs from the exact reviewed MC/BND census");
  return value;
}

export function validateProducerFilesManifest(path, sourceArchivePath, expectedPaths = EXPECTED_PRODUCER_SOURCE_PATHS) {
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) fail("producer-files manifest is empty");
  const archive = readGitArchive(sourceArchivePath);
  const seen = new Set();
  const paths = [];
  for (const [index, line] of lines.entries()) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) fail(`invalid producer-files manifest line ${index + 1}`);
    const sourcePath = canonicalRelative(match[2], `producer source line ${index + 1}`);
    const folded = process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
    const member = archive.files.get(sourcePath);
    if (seen.has(folded) || !member || sha256Bytes(member) !== match[1]) fail(`producer source archive binding failed at line ${index + 1}`);
    seen.add(folded); paths.push(sourcePath);
  }
  if (JSON.stringify(paths) !== JSON.stringify([...expectedPaths].sort((left, right) => left.localeCompare(right)))) fail("producer source manifest differs from the exact reviewed source-path census");
  if (expectedPaths === EXPECTED_PRODUCER_SOURCE_PATHS) {
    if (JSON.stringify(Object.keys(PRODUCER_SOURCE_REGISTRY).sort()) !== JSON.stringify([...REVIEWED_PRODUCER_IDS].sort())) fail("internal producer registry is incomplete");
    for (const [producerId, sourcePath] of Object.entries(PRODUCER_SOURCE_REGISTRY)) {
      if (!seen.has(process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath)) fail(`reviewed producer source is absent from the frozen census: ${producerId}`);
    }
  }
  return { count: lines.length, archiveRevision: archive.revision, paths };
}

export function validateImmutableInputs(value, root) {
  exactKeys(value, ["schema_version", "run_id", "side", "source", "producer_source", "image", "container", "stack_identity_before", "database", "environment", "check_census_path", "check_census_sha256", "producer_files_path", "producer_files_sha256", "created_at"], "immutable inputs");
  exactKeys(value.source, ["commit", "archive_path", "archive_sha256"], "immutable source");
  exactKeys(value.producer_source, ["commit", "archive_path", "archive_sha256"], "immutable producer source");
  exactKeys(value.image, ["reference", "id", "oci_revision", "inspect_path", "inspect_sha256", "build_evidence"], "immutable image");
  exactKeys(value.container, ["inspect_path", "inspect_sha256"], "immutable container");
  exactKeys(value.stack_identity_before, ["path", "sha256"], "before-run stack identity binding");
  exactKeys(value.database, ["archive_path", "archive_sha256", "logical_fingerprint_before"], "immutable database");
  exactKeys(value.environment, ["base_url", "compose_project", "release_id_sha256"], "immutable environment");
  if (value.schema_version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.run_id ?? "") || !["current", "baseline"].includes(value.side) || !validUtc(value.created_at)) fail("immutable inputs identity is invalid");
  if (!/^[a-f0-9]{40,64}$/.test(value.source.commit ?? "") || value.image.oci_revision !== value.source.commit || !/^sha256:[a-f0-9]{64}$/.test(value.image.id ?? "") || typeof value.image.reference !== "string" || !value.image.reference.includes("sha256:")) fail("immutable source/image binding is invalid");
  if (!/^[a-f0-9]{40,64}$/.test(value.producer_source.commit ?? "") || ![value.source.archive_sha256, value.producer_source.archive_sha256, value.image.inspect_sha256, value.container.inspect_sha256, value.database.archive_sha256, value.database.logical_fingerprint_before, value.environment.release_id_sha256, value.check_census_sha256, value.producer_files_sha256].every(hex)) fail("immutable inputs contain an invalid checksum");
  if (value.environment.base_url !== "http://127.0.0.1:8027" || value.environment.compose_project !== "tacbookings-measure") fail("immutable environment is not the isolated measurement stack");
  for (const [entry, label] of [[value.source, "app source archive"], [value.producer_source, "producer source archive"], [value.database, "database archive"]]) {
    if (!isAbsolute(entry.archive_path) || !existsSync(entry.archive_path) || lstatSync(entry.archive_path).isSymbolicLink() || !statSync(entry.archive_path).isFile() || sha256File(entry.archive_path) !== entry.archive_sha256) fail(`${label} immutable binding failed`);
  }
  const censusPath = join(root, "inputs", "check-census.json");
  const producersPath = join(root, "inputs", "producer-files.sha256");
  const imageInspectPath = join(root, "inputs", "image-inspect.json");
  const containerInspectPath = join(root, "inputs", "container-inspect.json");
  const stackIdentityPath = join(root, "inputs", "stack-identity-before.json");
  const same = (left, right) => process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
  if (!same(value.check_census_path, censusPath) || !same(value.producer_files_path, producersPath) || !same(value.image.inspect_path, imageInspectPath) || !same(value.container.inspect_path, containerInspectPath) || !same(value.stack_identity_before.path, stackIdentityPath)) fail("immutable input evidence paths are not the canonical run inputs");
  if (sha256File(censusPath) !== value.check_census_sha256 || sha256File(producersPath) !== value.producer_files_sha256) fail("immutable inputs do not bind the census/producer manifest");
  if (sha256File(imageInspectPath) !== value.image.inspect_sha256 || sha256File(containerInspectPath) !== value.container.inspect_sha256) fail("immutable inputs do not bind image/container inspection evidence");
  if (!hex(value.stack_identity_before.sha256) || sha256File(stackIdentityPath) !== value.stack_identity_before.sha256) fail("immutable inputs do not bind the before-run stack identity");
  validateCensus(JSON.parse(readFileSync(censusPath, "utf8")));
  const appArchive = readGitArchive(value.source.archive_path);
  if (appArchive.revision !== value.source.commit) fail("app source archive revision differs from the immutable app/image source commit");
  const producerManifest = validateProducerFilesManifest(producersPath, value.producer_source.archive_path);
  if (producerManifest.archiveRevision !== value.producer_source.commit) fail("producer source archive revision differs from the immutable producer source commit");
  if (value.producer_source.archive_path === value.source.archive_path || value.producer_source.archive_sha256 === value.source.archive_sha256) fail("app and producer source archives must remain explicit non-swappable identities");
  const imageInspect = JSON.parse(readFileSync(imageInspectPath, "utf8"));
  exactKeys(imageInspect, ["id", "oci_revision"], "image inspection");
  if (imageInspect.id !== value.image.id || imageInspect.oci_revision !== value.image.oci_revision) fail("image inspection differs from immutable image identity");
  const containerInspect = JSON.parse(readFileSync(containerInspectPath, "utf8"));
  exactKeys(containerInspect, ["id", "image_id", "compose_project", "compose_service"], "app container inspection");
  if (!/^[a-f0-9]{64}$/.test(containerInspect.id ?? "") || containerInspect.image_id !== value.image.id || containerInspect.compose_project !== value.environment.compose_project || containerInspect.compose_service !== "app") fail("app container inspection differs from the isolated immutable stack");
  validateImageBuildEvidence(value.image.build_evidence, root, value.image);
  return value;
}

export function validateProducerResult(value, { immutable, producerId }) {
  exactKeys(value, ["schema_version", "run_id", "producer_id", "side", "started_at", "ended_at", "exit_code", "cleanup", "observations", "owned_artifacts"], `producer result ${producerId}`);
  exactKeys(value.cleanup, ["status", "evidence_paths"], `producer cleanup ${producerId}`);
  const expectedChecks = PRODUCER_CHECK_SCHEMA[immutable.side]?.[producerId];
  if (!expectedChecks || !REVIEWED_PRODUCER_IDS.includes(producerId) || !PRODUCER_SOURCE_REGISTRY[producerId]) fail(`producer is outside the reviewed registry: ${producerId}`);
  if (value.schema_version !== 1 || value.run_id !== immutable.run_id || value.side !== immutable.side || value.producer_id !== producerId) fail(`producer result identity failed: ${producerId}`);
  if (!validUtc(value.started_at) || !validUtc(value.ended_at) || Date.parse(value.started_at) < Date.parse(immutable.created_at) || Date.parse(value.ended_at) < Date.parse(value.started_at) || value.exit_code !== 0) fail(`producer chronology/exit is invalid: ${producerId}`);
  if (value.cleanup.status !== "passed" || !Array.isArray(value.cleanup.evidence_paths) || !value.cleanup.evidence_paths.length || !Array.isArray(value.observations) || !Array.isArray(value.owned_artifacts) || !value.owned_artifacts.length) fail(`producer cleanup/observations/artifacts are invalid: ${producerId}`);
  const paths = new Set(value.cleanup.evidence_paths.map((path, index) => canonicalRelative(path, `${producerId} cleanup path ${index}`)));
  const seenChecks = new Set();
  for (const observation of value.observations) {
    exactKeys(observation, ["check_id", "outcome", "assertions", "evidence_paths"], `producer observation ${producerId}`);
    const checkDefinition = CORRECTNESS_CENSUS.find((candidate) => candidate.id === observation.check_id);
    const allowedOutcomes = observation.check_id === "MC-03D" ? ["OWNER_DISPOSITION_NEEDED"] : ["PASS", "FAIL", "UNVERIFIED"];
    if (!checkDefinition?.required_sides.includes(immutable.side) || !checkDefinition.allowed_producers.includes(producerId) || !allowedOutcomes.includes(observation.outcome) || seenChecks.has(observation.check_id) || !Array.isArray(observation.assertions) || !observation.assertions.length || observation.assertions.some((item) => typeof item !== "string" || !item) || !Array.isArray(observation.evidence_paths) || !observation.evidence_paths.length) fail(`producer observation is invalid: ${producerId}:${observation.check_id}`);
    seenChecks.add(observation.check_id);
    for (const [index, rawPath] of observation.evidence_paths.entries()) paths.add(canonicalRelative(rawPath, `${producerId} evidence path ${index}`));
  }
  if (JSON.stringify(value.observations.map((observation) => observation.check_id)) !== JSON.stringify(expectedChecks)) fail(`producer check schema differs from the reviewed census: ${producerId}`);
  const ownedPaths = new Set();
  for (const [index, artifact] of value.owned_artifacts.entries()) {
    exactKeys(artifact, ["path", "sha256", "size_bytes"], `${producerId} owned artifact ${index}`);
    const path = canonicalRelative(artifact.path, `${producerId} owned artifact ${index}`);
    if (!path.startsWith(`raw/${producerId}/`) || ownedPaths.has(path) || !hex(artifact.sha256) || !Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes < 0) fail(`owned artifact schema is invalid: ${producerId}:${path}`);
    ownedPaths.add(path);
  }
  if (JSON.stringify([...ownedPaths]) !== JSON.stringify([...ownedPaths].sort((left, right) => left.localeCompare(right)))) fail(`owned artifacts are not sorted: ${producerId}`);
  for (const path of paths) if (!ownedPaths.has(path)) fail(`semantic evidence is absent from the owned artifact census: ${producerId}:${path}`);
  return { value, referencedPaths: paths, ownedPaths };
}

function walkFiles(root, subdir) {
  const base = join(root, subdir);
  if (!existsSync(base) || !statSync(base).isDirectory()) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) fail(`correctness evidence contains a symbolic link: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
      else fail(`unsupported correctness evidence entry: ${path}`);
    }
  };
  visit(base);
  return files.sort((left, right) => left.localeCompare(right));
}

export function collectProducerState(root, immutable) {
  const resultFiles = walkFiles(root, "producer-results");
  const rawFiles = walkFiles(root, "raw");
  const orchestratorHealthPath = "raw/orchestrator/app-health.json";
  if (!resultFiles.length) fail("no correctness producer results exist");
  const producers = new Map();
  const coveredRaw = new Set();
  const ownedRaw = new Set();
  for (const path of resultFiles) {
    const match = /^producer-results\/([a-z0-9][a-z0-9-]{0,63})\.json$/.exec(path);
    if (!match) fail(`producer result path is not canonical: ${path}`);
    const producerId = match[1];
    const parsed = validateProducerResult(JSON.parse(readFileSync(join(root, ...path.split("/")), "utf8")), { immutable, producerId });
    for (const rawPath of parsed.referencedPaths) {
      if (!rawPath.startsWith(`raw/${producerId}/`)) fail(`producer references evidence outside its create-only directory: ${producerId}:${rawPath}`);
      coveredRaw.add(rawPath);
    }
    const owned = rawFiles.filter((rawPath) => rawPath.startsWith(`raw/${producerId}/`));
    if (!owned.length) fail(`zero-artifact producer is forbidden: ${producerId}`);
    if (JSON.stringify(owned) !== JSON.stringify([...parsed.ownedPaths])) fail(`owned artifact census differs from the exact filesystem: ${producerId}`);
    for (const [index, artifact] of parsed.value.owned_artifacts.entries()) {
      const absolute = join(root, ...artifact.path.split("/"));
      if (sha256File(absolute) !== artifact.sha256 || statSync(absolute).size !== artifact.size_bytes) fail(`owned artifact checksum/size mismatch: ${producerId}:${index}`);
      ownedRaw.add(artifact.path);
    }
    producers.set(producerId, { ...parsed, resultPath: path, owned });
  }
  const expectedProducerIds = Object.keys(PRODUCER_CHECK_SCHEMA[immutable.side]).sort();
  if (JSON.stringify([...producers.keys()].sort()) !== JSON.stringify(expectedProducerIds)) fail(`producer result census differs from the reviewed ${immutable.side} registry`);
  const unknownRaw = rawFiles.filter((path) => path !== orchestratorHealthPath && !ownedRaw.has(path));
  if (unknownRaw.length) fail(`raw evidence is outside the authoritative producer ownership census: ${unknownRaw.join(",")}`);
  for (const rawPath of coveredRaw) if (!ownedRaw.has(rawPath)) fail(`producer references missing raw evidence: ${rawPath}`);
  return { producers, files: [...rawFiles, ...resultFiles].sort(), orchestratorHealthPath: rawFiles.includes(orchestratorHealthPath) ? orchestratorHealthPath : null };
}

export function validatePostconditions(value, root, immutable, producerState) {
  exactKeys(value, ["schema_version", "run_id", "side", "database_fingerprint_before", "database_fingerprint_after", "database_unchanged", "app_health", "completed_at"], "correctness postconditions");
  exactKeys(value.app_health, ["status", "evidence_paths"], "correctness app-health postcondition");
  if (value.schema_version !== 1 || value.run_id !== immutable.run_id || value.side !== immutable.side || !validUtc(value.completed_at)) fail("correctness postconditions identity is invalid");
  if (!hex(value.database_fingerprint_before) || value.database_fingerprint_before !== immutable.database.logical_fingerprint_before || value.database_fingerprint_after !== value.database_fingerprint_before || value.database_unchanged !== true) fail("correctness database postcondition changed or is unbound");
  if ([...producerState.producers.values()].some((producer) => Date.parse(producer.value.ended_at) > Date.parse(value.completed_at))) fail("correctness postconditions precede a producer completion");
  if (value.app_health.status !== "passed" || !Array.isArray(value.app_health.evidence_paths) || !value.app_health.evidence_paths.length) fail("correctness app-health postcondition did not pass with evidence");
  const allowed = new Set([...producerState.producers.values()].flatMap((producer) => producer.owned));
  if (producerState.orchestratorHealthPath) allowed.add(producerState.orchestratorHealthPath);
  for (const [index, raw] of value.app_health.evidence_paths.entries()) {
    const path = canonicalRelative(raw, `app-health evidence ${index}`);
    if (!allowed.has(path) || !existsSync(join(root, ...path.split("/")))) fail(`app-health postcondition evidence is not producer-owned: ${path}`);
  }
  return value;
}

export function buildRawManifest(root, immutable) {
  const state = collectProducerState(root, immutable);
  validatePostconditions(JSON.parse(readFileSync(join(root, "postconditions.json"), "utf8")), root, immutable, state);
  const entries = state.files.map((path) => {
    const resultMatch = /^producer-results\/([a-z0-9-]+)\.json$/.exec(path);
    const producerId = resultMatch?.[1] ?? /^raw\/([a-z0-9-]+)\//.exec(path)?.[1];
    const producer = state.producers.get(producerId);
    if (!producer && path !== "raw/orchestrator/app-health.json") fail(`raw evidence owner has no producer result: ${path}`);
    const checkIds = producer ? [...new Set(producer.value.observations.filter((observation) => resultMatch || observation.evidence_paths.includes(path)).map((observation) => observation.check_id))].sort() : [];
    const absolute = join(root, ...path.split("/"));
    return { path, sha256: sha256File(absolute), bytes: statSync(absolute).size, media_type: path.endsWith(".json") ? "application/json" : "application/octet-stream", producer_id: producerId, side: immutable.side, check_ids: checkIds, publication: "review_required" };
  });
  return { schema_version: 1, run_id: immutable.run_id, immutable_inputs_sha256: sha256File(join(root, "inputs", "immutable-inputs.json")), postconditions_sha256: sha256File(join(root, "postconditions.json")), entries };
}

export function validateRawManifest(value, root, immutable) {
  exactKeys(value, ["schema_version", "run_id", "immutable_inputs_sha256", "postconditions_sha256", "entries"], "raw evidence manifest");
  if (value.schema_version !== 1 || value.run_id !== immutable.run_id || value.immutable_inputs_sha256 !== sha256File(join(root, "inputs", "immutable-inputs.json")) || !Array.isArray(value.entries) || !value.entries.length) fail("raw evidence manifest identity is invalid");
  const expected = buildRawManifest(root, immutable);
  if (JSON.stringify(value) !== JSON.stringify(expected)) fail("raw evidence manifest differs from the exact filesystem/producer census");
  return new Map(value.entries.map((entry) => [entry.path, entry]));
}

export function deriveCorrectnessReport(root, immutable, rawEntries, secretScan) {
  const census = validateCensus(JSON.parse(readFileSync(join(root, "inputs", "check-census.json"), "utf8")));
  const state = collectProducerState(root, immutable);
  const checks = census.checks.filter((check) => check.required_sides.includes(immutable.side)).map((check) => {
    const observations = [...state.producers.values()].flatMap((producer) => producer.value.observations.map((observation) => ({ ...observation, producer_id: producer.value.producer_id, producer_ok: producer.value.exit_code === 0 && producer.value.cleanup.status === "passed" }))).filter((observation) => observation.check_id === check.id);
    let outcome;
    if (check.id === "MC-03D") outcome = "OWNER_DISPOSITION_NEEDED";
    else if (observations.some((item) => item.outcome === "FAIL" || !item.producer_ok)) outcome = "FAIL";
    else if (observations.some((item) => item.outcome === "PASS" && item.producer_ok)) outcome = "PASS";
    else outcome = "UNVERIFIED";
    const evidencePaths = [...new Set(observations.flatMap((item) => item.evidence_paths))].sort();
    const evidence = evidencePaths.map((path) => {
      const entry = rawEntries.get(path);
      if (!entry || !entry.check_ids.includes(check.id)) fail(`report evidence is not bound to the check in the raw manifest: ${check.id}:${path}`);
      return { path, sha256: entry.sha256 };
    });
    return { id: check.id, requirement_class: check.requirement_class, applicability: check.id === "MC-03D" ? "owner_disposition_needed" : "required", outcome, producer_ids: [...new Set(observations.map((item) => item.producer_id))].sort(), evidence, owner_disposition: null };
  });
  let result = "passed";
  if (checks.some((check) => check.outcome === "FAIL")) result = "failed";
  else if (checks.some((check) => check.outcome === "OWNER_DISPOSITION_NEEDED")) result = "owner_disposition_needed";
  else if (checks.some((check) => check.outcome !== "PASS" && check.outcome !== "NOT_APPLICABLE")) result = "unverified";
  if (!secretScan.passed || secretScan.findings.length) result = "failed";
  return {
    schema_version: 2,
    run_id: immutable.run_id,
    side: immutable.side,
    result,
    bindings: {
      immutable_inputs_sha256: sha256File(join(root, "inputs", "immutable-inputs.json")),
      check_census_sha256: immutable.check_census_sha256,
      producer_files_sha256: immutable.producer_files_sha256,
      raw_evidence_manifest_sha256: sha256File(join(root, "raw-evidence-manifest.json")),
      postconditions_sha256: sha256File(join(root, "postconditions.json")),
      secret_scan_sha256: sha256File(join(root, "secret-scan.json")),
      route_expectations_sha256: sha256File(join(root, "route-expectations.json")),
      stack_identity_before_sha256: sha256File(join(root, "inputs", "stack-identity-before.json")),
      stack_identity_after_sha256: sha256File(join(root, "postcondition-evidence", "stack-identity-after.json")),
      source_archive_sha256: immutable.source.archive_sha256,
      producer_source_archive_sha256: immutable.producer_source.archive_sha256,
      producer_source_commit: immutable.producer_source.commit,
      image_id: immutable.image.id,
      oci_revision: immutable.image.oci_revision,
      canonical_database_archive_sha256: immutable.database.archive_sha256,
      canonical_database_fingerprint: immutable.database.logical_fingerprint_before,
    },
    checks,
  };
}

export function validateCorrectnessReport(report, root, immutable, rawEntries, secretScan) {
  const expected = deriveCorrectnessReport(root, immutable, rawEntries, secretScan);
  if (JSON.stringify(report) !== JSON.stringify(expected)) fail("correctness report differs from independently re-derived outcomes/evidence");
  const expectedIds = expectedCheckIdsForSide(immutable.side);
  if (JSON.stringify(report.checks.map((check) => check.id)) !== JSON.stringify(expectedIds)) fail("correctness report exact check census failed");
  return report;
}

export function expectedCorrectnessCensus(root, rawManifest) {
  const files = [
    "inputs/app-container-inspect.json", "inputs/check-census.json", "inputs/container-inspect.json", "inputs/database-fingerprint.json",
    "inputs/image-build-identity.json", "inputs/image-build-runtime-env.json", "inputs/image-build-scan.raw.json", "inputs/image-inspect.json",
    "inputs/immutable-inputs.json", "inputs/postgres-container-inspect.json", "inputs/postgres-server-version.json", "inputs/producer-files.sha256", "inputs/stack-identity-before.json",
    ...rawManifest.entries.map((entry) => entry.path),
    "postcondition-evidence/app-container-inspect.json", "postcondition-evidence/database-fingerprint.json", "postcondition-evidence/postgres-container-inspect.json",
    "postcondition-evidence/postgres-server-version.json", "postcondition-evidence/stack-identity-after.json",
    "postconditions.json", "raw-evidence-manifest.json", "route-expectations.json", "secret-scan.json", "correctness-report.json", "COMPLETED.json",
  ].sort();
  const directories = new Set();
  for (const file of files) for (let parent = posix.dirname(file); parent !== "."; parent = posix.dirname(parent)) directories.add(parent);
  return { files, directories: [...directories].sort() };
}

export function actualCorrectnessCensus(root) {
  const rootReal = realpathSync.native(root);
  const files = [], directories = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) fail(`correctness tree contains a symbolic link/junction: ${path}`);
      const rel = relative(rootReal, path).split(sep).join("/");
      if (entry.isDirectory()) { directories.push(rel); visit(path); }
      else if (entry.isFile()) files.push(rel);
      else fail(`unsupported correctness tree entry: ${path}`);
    }
  };
  visit(rootReal);
  return { files: files.sort(), directories: directories.sort() };
}
