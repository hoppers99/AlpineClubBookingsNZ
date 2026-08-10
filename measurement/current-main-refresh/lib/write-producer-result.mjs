import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const fail = (message) => {
  throw new Error(`write-producer-result: ${message}`);
};

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) fail("arguments must be --key value pairs");
  args.set(key.slice(2), value);
}

const required = (name) => {
  const value = args.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
};

const runRoot = realpathSync(required("run-root"));
const runId = required("run-id");
const producerId = required("producer-id");
const side = required("side");
const startedAt = required("started-at");
const endedAt = required("ended-at");
const exitCode = Number(required("exit-code"));
const observationsPath = resolve(required("observations"));
const censusPath = resolve(required("census"));
const out = resolve(required("out"));
const cleanupEvidence = required("cleanup-evidence").split(",").filter(Boolean);

if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) fail("run id has an unsafe shape");
if (!/^[a-z0-9][a-z0-9-]*$/.test(producerId)) fail("producer id has an unsafe shape");
if (!new Set(["current", "baseline"]).has(side)) fail("side must be current or baseline");
if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) fail("exit code is invalid");
for (const [label, value] of [["started-at", startedAt], ["ended-at", endedAt]]) {
  if (!Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO timestamp`);
}
if (Date.parse(endedAt) < Date.parse(startedAt)) fail("ended-at precedes started-at");

const relativeEvidencePath = (candidate, label) => {
  if (typeof candidate !== "string" || candidate.length === 0 || isAbsolute(candidate)) {
    fail(`${label} must be a non-empty relative path`);
  }
  const absolute = resolve(runRoot, candidate);
  const rel = relative(runRoot, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`${label} escapes the run root`);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must name a regular non-symlink file`);
  const real = realpathSync(absolute);
  const samePath = process.platform === "win32"
    ? real.toLowerCase() === absolute.toLowerCase()
    : real === absolute;
  if (!samePath) fail(`${label} resolves through a link`);
  return rel.split(sep).join("/");
};

const census = JSON.parse(readFileSync(censusPath, "utf8"));
if (census.schema_version !== 1 || !Array.isArray(census.checks)) fail("unsupported check census");
const checks = new Map(census.checks.map((check) => [check.id, check]));
if (checks.size !== census.checks.length) fail("check census contains duplicate ids");

const observations = JSON.parse(readFileSync(observationsPath, "utf8"));
if (!Array.isArray(observations) || observations.length === 0) fail("observations must be a non-empty array");
const allowedOutcomes = new Set(["PASS", "FAIL", "UNVERIFIED", "OWNER_DISPOSITION_NEEDED"]);
const normalizedObservations = observations.map((observation, index) => {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) fail(`observation ${index} is invalid`);
  const check = checks.get(observation.check_id);
  if (!check) fail(`observation ${index} has unknown check id ${observation.check_id}`);
  if (!check.required_sides.includes(side)) fail(`${observation.check_id} is not required for ${side}`);
  if (!check.allowed_producers.includes(producerId)) fail(`${producerId} is not allowed to report ${observation.check_id}`);
  if (!allowedOutcomes.has(observation.outcome)) fail(`${observation.check_id} has invalid outcome ${observation.outcome}`);
  if (!Array.isArray(observation.assertions) || observation.assertions.length === 0 || observation.assertions.some((value) => typeof value !== "string" || !value)) {
    fail(`${observation.check_id} assertions must be non-empty strings`);
  }
  if (!Array.isArray(observation.evidence_paths) || observation.evidence_paths.length === 0) {
    fail(`${observation.check_id} must reference evidence`);
  }
  return {
    check_id: observation.check_id,
    outcome: observation.outcome,
    assertions: observation.assertions,
    evidence_paths: observation.evidence_paths.map((path, evidenceIndex) =>
      relativeEvidencePath(path, `${observation.check_id}.evidence_paths[${evidenceIndex}]`)),
  };
});

const normalizedCleanup = cleanupEvidence.map((path, index) =>
  relativeEvidencePath(path, `cleanup-evidence[${index}]`));
if (normalizedCleanup.length === 0) fail("at least one cleanup evidence path is required");

const expectedOut = resolve(runRoot, "producer-results", `${producerId}.json`);
if (out !== expectedOut) fail(`output must be ${expectedOut}`);

const rawRoot = resolve(runRoot, "raw", producerId);
const rawRootStat = lstatSync(rawRoot);
if (!rawRootStat.isDirectory() || rawRootStat.isSymbolicLink() || realpathSync(rawRoot) !== rawRoot) fail("producer raw root is not a canonical directory");
const ownedArtifacts = [];
const walkOwned = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) fail(`owned artifact is a symlink: ${absolute}`);
    if (stat.isDirectory()) walkOwned(absolute);
    else if (stat.isFile()) {
      const path = relativeEvidencePath(relative(runRoot, absolute), "owned artifact");
      if (!path.startsWith(`raw/${producerId}/`)) fail(`owned artifact escapes raw/${producerId}`);
      ownedArtifacts.push({
        path,
        sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
        size_bytes: stat.size,
      });
    } else fail(`owned artifact has an unsupported file type: ${absolute}`);
  }
};
walkOwned(rawRoot);
ownedArtifacts.sort((left, right) => left.path.localeCompare(right.path));
if (ownedArtifacts.length === 0 || new Set(ownedArtifacts.map((row) => row.path)).size !== ownedArtifacts.length) fail("owned artifact manifest is empty or duplicated");

const result = {
  schema_version: 1,
  run_id: runId,
  producer_id: producerId,
  side,
  started_at: new Date(startedAt).toISOString(),
  ended_at: new Date(endedAt).toISOString(),
  exit_code: exitCode,
  cleanup: { status: "passed", evidence_paths: normalizedCleanup },
  observations: normalizedObservations,
  owned_artifacts: ownedArtifacts,
};

writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
