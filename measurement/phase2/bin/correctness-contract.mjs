import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

const fail = (message) => { throw new Error(message); };
export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const OUTCOMES = Object.freeze(["PASS", "FAIL", "UNVERIFIED", "OWNER_DISPOSITION_NEEDED", "NOT_APPLICABLE"]);

const MC = ["MC-01A", "MC-01B", "MC-02", "MC-03A", "MC-03B", "MC-03C", "MC-03D", "MC-04A", "MC-04B", "MC-04C", "MC-04D", "MC-05", "MC-06", "MC-07", "MC-08A", "MC-08B", "MC-09", "MC-10", "MC-11A", "MC-11B", "MC-11C", "MC-11D", "MC-11E"];
const BND = Array.from({ length: 12 }, (_, index) => `BND-${String(index + 1).padStart(2, "0")}`);
export const MANDATORY_CORRECTNESS_CHECK_IDS = Object.freeze([...MC, ...BND]);
const BOTH_SIDES = new Set(["BND-01", "BND-02", "BND-09"]);
export const CORRECTNESS_CENSUS = Object.freeze(MANDATORY_CORRECTNESS_CHECK_IDS.map((id) => Object.freeze({
  id,
  requirement_class: id === "MC-03D" ? "owner_disposition" : id.startsWith("MC-") ? "mandatory_pass" : "supporting_required",
  sides: Object.freeze(BOTH_SIDES.has(id) ? ["current", "baseline"] : ["current"]),
  owner_anchor: id.startsWith("MC-") ? "issue-2352-mandatory-correctness" : "issue-2352-option-a-binding",
  owner_disposition: null,
})));

export const expectedCheckIdsForSide = (side) => {
  if (!["current", "baseline"].includes(side)) fail(`invalid correctness side: ${side}`);
  return CORRECTNESS_CENSUS.filter((check) => check.sides.includes(side)).map((check) => check.id);
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

export function correctnessCensus(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) fail("run_id is invalid");
  return { schema_version: 1, run_id: runId, checks: CORRECTNESS_CENSUS.map((check) => ({ ...check, sides: [...check.sides] })) };
}

export function validateCensus(value, expectedRunId = null) {
  exactKeys(value, ["schema_version", "run_id", "checks"], "check census");
  if (value.schema_version !== 1 || (expectedRunId && value.run_id !== expectedRunId) || !Array.isArray(value.checks)) fail("check census identity is invalid");
  const expected = correctnessCensus(value.run_id);
  if (JSON.stringify(value) !== JSON.stringify(expected)) fail("check census differs from the exact reviewed MC/BND census");
  return value;
}

export function validateProducerFilesManifest(path) {
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) fail("producer-files manifest is empty");
  const seen = new Set();
  for (const [index, line] of lines.entries()) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) fail(`invalid producer-files manifest line ${index + 1}`);
    const absolute = resolve(match[2]);
    const folded = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (!isAbsolute(match[2]) || seen.has(folded) || !existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile() || sha256File(absolute) !== match[1]) fail(`producer source binding failed at line ${index + 1}`);
    seen.add(folded);
  }
  return lines.length;
}

export function validateImmutableInputs(value, root) {
  exactKeys(value, ["schema_version", "run_id", "side", "source", "image", "database", "environment", "check_census_sha256", "producer_files_sha256", "created_at"], "immutable inputs");
  exactKeys(value.source, ["commit", "archive_path", "archive_sha256"], "immutable source");
  exactKeys(value.image, ["reference", "id", "oci_revision"], "immutable image");
  exactKeys(value.database, ["archive_path", "archive_sha256", "logical_fingerprint"], "immutable database");
  exactKeys(value.environment, ["base_url", "compose_project", "release_id_sha256"], "immutable environment");
  if (value.schema_version !== 1 || !["current", "baseline"].includes(value.side) || !validUtc(value.created_at)) fail("immutable inputs identity is invalid");
  if (!/^[a-f0-9]{40,64}$/.test(value.source.commit ?? "") || value.image.oci_revision !== value.source.commit || !/^sha256:[a-f0-9]{64}$/.test(value.image.id ?? "") || typeof value.image.reference !== "string" || !value.image.reference.includes("sha256:")) fail("immutable source/image binding is invalid");
  if (![value.source.archive_sha256, value.database.archive_sha256, value.database.logical_fingerprint, value.environment.release_id_sha256, value.check_census_sha256, value.producer_files_sha256].every(hex)) fail("immutable inputs contain an invalid checksum");
  if (value.environment.base_url !== "http://127.0.0.1:8027" || value.environment.compose_project !== "tacbookings-measure") fail("immutable environment is not the isolated measurement stack");
  for (const [entry, label] of [[value.source, "source archive"], [value.database, "database archive"]]) {
    if (!isAbsolute(entry.archive_path) || !existsSync(entry.archive_path) || lstatSync(entry.archive_path).isSymbolicLink() || !statSync(entry.archive_path).isFile() || sha256File(entry.archive_path) !== entry.archive_sha256) fail(`${label} immutable binding failed`);
  }
  const censusPath = join(root, "inputs", "check-census.json");
  const producersPath = join(root, "inputs", "producer-files.sha256");
  if (sha256File(censusPath) !== value.check_census_sha256 || sha256File(producersPath) !== value.producer_files_sha256) fail("immutable inputs do not bind the census/producer manifest");
  validateCensus(JSON.parse(readFileSync(censusPath, "utf8")), value.run_id);
  validateProducerFilesManifest(producersPath);
  return value;
}

export function validateProducerResult(value, { runId, side, producerId }) {
  exactKeys(value, ["schema_version", "run_id", "producer_id", "side", "started_at", "ended_at", "exit_code", "cleanup", "observations"], `producer result ${producerId}`);
  exactKeys(value.cleanup, ["status", "evidence_paths"], `producer cleanup ${producerId}`);
  if (value.schema_version !== 1 || value.run_id !== runId || value.side !== side || value.producer_id !== producerId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(producerId)) fail(`producer result identity failed: ${producerId}`);
  if (!validUtc(value.started_at) || !validUtc(value.ended_at) || Date.parse(value.ended_at) < Date.parse(value.started_at) || !Number.isInteger(value.exit_code)) fail(`producer chronology/exit is invalid: ${producerId}`);
  if (!['passed', 'failed'].includes(value.cleanup.status) || !Array.isArray(value.cleanup.evidence_paths) || !Array.isArray(value.observations)) fail(`producer cleanup/observations are invalid: ${producerId}`);
  const paths = new Set(value.cleanup.evidence_paths.map((path, index) => canonicalRelative(path, `${producerId} cleanup path ${index}`)));
  for (const observation of value.observations) {
    exactKeys(observation, ["check_id", "outcome", "assertions", "evidence_paths"], `producer observation ${producerId}`);
    if (!MANDATORY_CORRECTNESS_CHECK_IDS.includes(observation.check_id) || !["PASS", "FAIL", "UNVERIFIED"].includes(observation.outcome) || !Array.isArray(observation.assertions) || !observation.assertions.length || observation.assertions.some((item) => typeof item !== "string" || !item) || !Array.isArray(observation.evidence_paths) || !observation.evidence_paths.length) fail(`producer observation is invalid: ${producerId}:${observation.check_id}`);
    for (const [index, rawPath] of observation.evidence_paths.entries()) paths.add(canonicalRelative(rawPath, `${producerId} evidence path ${index}`));
  }
  return { value, referencedPaths: paths };
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
  return files.sort();
}

export function collectProducerState(root, immutable) {
  const resultFiles = walkFiles(root, "producer-results");
  const rawFiles = walkFiles(root, "raw");
  const orchestratorHealthPath = "raw/orchestrator/app-health.json";
  if (!resultFiles.length) fail("no correctness producer results exist");
  const producers = new Map();
  const coveredRaw = new Set();
  for (const path of resultFiles) {
    const match = /^producer-results\/([a-z0-9][a-z0-9-]{0,63})\.json$/.exec(path);
    if (!match) fail(`producer result path is not canonical: ${path}`);
    const producerId = match[1];
    const parsed = validateProducerResult(JSON.parse(readFileSync(join(root, ...path.split("/")), "utf8")), { runId: immutable.run_id, side: immutable.side, producerId });
    for (const rawPath of parsed.referencedPaths) {
      if (!rawPath.startsWith(`raw/${producerId}/`)) fail(`producer references evidence outside its create-only directory: ${producerId}:${rawPath}`);
      coveredRaw.add(rawPath);
    }
    const owned = rawFiles.filter((rawPath) => rawPath.startsWith(`raw/${producerId}/`));
    if (!owned.length) fail(`zero-artifact producer is forbidden: ${producerId}`);
    producers.set(producerId, { ...parsed, resultPath: path, owned });
  }
  const unknownRaw = rawFiles.filter((path) => path !== orchestratorHealthPath && !coveredRaw.has(path));
  if (unknownRaw.length) fail(`raw evidence is unreferenced by its producer: ${unknownRaw.join(",")}`);
  for (const rawPath of coveredRaw) if (!rawFiles.includes(rawPath)) fail(`producer references missing raw evidence: ${rawPath}`);
  return { producers, files: [...rawFiles, ...resultFiles].sort(), orchestratorHealthPath: rawFiles.includes(orchestratorHealthPath) ? orchestratorHealthPath : null };
}

export function validatePostconditions(value, root, immutable, producerState) {
  exactKeys(value, ["schema_version", "run_id", "side", "database_fingerprint_before", "database_fingerprint_after", "database_unchanged", "app_health", "completed_at"], "correctness postconditions");
  exactKeys(value.app_health, ["status", "evidence_paths"], "correctness app-health postcondition");
  if (value.schema_version !== 1 || value.run_id !== immutable.run_id || value.side !== immutable.side || !validUtc(value.completed_at)) fail("correctness postconditions identity is invalid");
  if (!hex(value.database_fingerprint_before) || value.database_fingerprint_before !== immutable.database.logical_fingerprint || value.database_fingerprint_after !== value.database_fingerprint_before || value.database_unchanged !== true) fail("correctness database postcondition changed or is unbound");
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
  const census = validateCensus(JSON.parse(readFileSync(join(root, "inputs", "check-census.json"), "utf8")), immutable.run_id);
  const state = collectProducerState(root, immutable);
  const checks = census.checks.filter((check) => check.sides.includes(immutable.side)).map((check) => {
    const observations = [...state.producers.values()].flatMap((producer) => producer.value.observations.map((observation) => ({ ...observation, producer_id: producer.value.producer_id, producer_ok: producer.value.exit_code === 0 && producer.value.cleanup.status === "passed" }))).filter((observation) => observation.check_id === check.id);
    let outcome;
    if (check.id === "MC-03D" && !check.owner_disposition) outcome = "OWNER_DISPOSITION_NEEDED";
    else if (observations.some((item) => item.outcome === "FAIL" || !item.producer_ok)) outcome = "FAIL";
    else if (observations.length && observations.every((item) => item.outcome === "PASS" && item.producer_ok)) outcome = "PASS";
    else outcome = "UNVERIFIED";
    const evidencePaths = [...new Set(observations.flatMap((item) => item.evidence_paths))].sort();
    const evidence = evidencePaths.map((path) => {
      const entry = rawEntries.get(path);
      if (!entry || !entry.check_ids.includes(check.id)) fail(`report evidence is not bound to the check in the raw manifest: ${check.id}:${path}`);
      return { path, sha256: entry.sha256 };
    });
    return { id: check.id, requirement_class: check.requirement_class, applicability: check.id === "MC-03D" && !check.owner_disposition ? "owner_disposition_needed" : "required", outcome, producer_ids: [...new Set(observations.map((item) => item.producer_id))].sort(), evidence, owner_disposition: check.owner_disposition };
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
      source_archive_sha256: immutable.source.archive_sha256,
      image_id: immutable.image.id,
      oci_revision: immutable.image.oci_revision,
      canonical_database_archive_sha256: immutable.database.archive_sha256,
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
  const files = ["inputs/check-census.json", "inputs/immutable-inputs.json", "inputs/producer-files.sha256", ...rawManifest.entries.map((entry) => entry.path), "postconditions.json", "raw-evidence-manifest.json", "secret-scan.json", "correctness-report.json", "COMPLETED.json"].sort();
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
