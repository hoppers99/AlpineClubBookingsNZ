import { existsSync, lstatSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { actualCorrectnessCensus, buildRawManifest, deriveCorrectnessReport, expectedCorrectnessCensus, sha256File, validateImmutableInputs, validateRawManifest, verifyLiveProducerSource } from "./correctness-contract.mjs";
import { verifyCorrectnessRouteEvidence } from "./correctness-route-evidence.mjs";
import { compareStackIdentities, verifyStackIdentity } from "./correctness-stack-identity.mjs";
import { scanEvidence } from "./scan-evidence-secrets.mjs";

const fail = (message) => { throw new Error(message); };
export function finalizeCorrectnessEvidence(rootInput, { runtimeContext = null, liveSourceRoot = null } = {}) {
const root = resolve(rootInput);
if (!statSync(root).isDirectory()) fail("correctness run root is not a directory");
const paths = Object.fromEntries(["raw-evidence-manifest.json", "route-expectations.json", "secret-scan.json", "correctness-report.json", "COMPLETED.json"].map((name) => [name, join(root, name)]));
for (const path of Object.values(paths)) if (existsSync(path)) fail(`refusing correctness finalization collision: ${path}`);
try {
const immutablePath = join(root, "inputs", "immutable-inputs.json");
const immutable = validateImmutableInputs(JSON.parse(readFileSync(immutablePath, "utf8")), root, { runtimeContext });
const producerSourceVerification = {
  producerManifestPath: immutable.producer_files_path,
  producerArchivePath: immutable.producer_source.archive_path,
  producerCommit: immutable.producer_source.commit,
  repoRoot: liveSourceRoot === null ? resolve(import.meta.dirname, "../../..") : resolve(liveSourceRoot),
};
verifyLiveProducerSource(producerSourceVerification);
const stackOptions = { imageId: immutable.image.id, composeProject: immutable.environment.compose_project, databaseFingerprint: immutable.database.logical_fingerprint_before };
const stackBefore = verifyStackIdentity(root, "inputs/stack-identity-before.json", { ...stackOptions, stage: "before" });
const stackAfter = verifyStackIdentity(root, "postcondition-evidence/stack-identity-after.json", { ...stackOptions, stage: "after" });
compareStackIdentities(stackBefore, stackAfter);
if (Date.parse(stackBefore.aggregate.captured_at) > Date.parse(immutable.created_at) || Date.parse(stackAfter.aggregate.captured_at) < Date.parse(immutable.created_at)) fail("correctness stack identity capture chronology is invalid");

const rawManifest = buildRawManifest(root, immutable);
const postconditions = JSON.parse(readFileSync(join(root, "postconditions.json"), "utf8"));
if (Date.parse(postconditions.completed_at) < Date.parse(stackAfter.aggregate.captured_at)) fail("correctness postconditions precede the after-run stack identity capture");
writeFileSync(paths["raw-evidence-manifest.json"], `${JSON.stringify(rawManifest, null, 2)}\n`, { flag: "wx" });
const rawEntries = validateRawManifest(rawManifest, root, immutable);
const routeEvidence = verifyCorrectnessRouteEvidence(root, immutable, rawEntries);
const routeExpectations = { schema_version: 1, run_id: immutable.run_id, side: immutable.side, evidence_path: routeEvidence.evidencePath, evidence_sha256: routeEvidence.evidenceSha256, routes: routeEvidence.routes };
writeFileSync(paths["route-expectations.json"], `${JSON.stringify(routeExpectations, null, 2)}\n`, { flag: "wx" });

const secretScan = scanEvidence({ root, out: paths["secret-scan.json"], manifest: paths["raw-evidence-manifest.json"] });
if (!secretScan.passed) fail("correctness raw evidence secret scan failed");
const report = deriveCorrectnessReport(root, immutable, rawEntries, secretScan);
writeFileSync(paths["correctness-report.json"], `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });

const beforeCompletion = actualCorrectnessCensus(root);
const expected = expectedCorrectnessCensus(root, rawManifest);
const expectedBefore = { files: expected.files.filter((file) => file !== "COMPLETED.json"), directories: expected.directories };
if (JSON.stringify(beforeCompletion) !== JSON.stringify(expectedBefore)) fail("correctness tree contains missing/extra files or directories before completion");
const completion = {
  schema_version: 1,
  status: "COMPLETE",
  run_id: immutable.run_id,
  side: immutable.side,
  completed_at: new Date().toISOString(),
  artifact_count: expected.files.length - 1,
  sealed_file_count: expected.files.length,
  sealed_directory_count: expected.directories.length,
  immutable_inputs_sha256: sha256File(immutablePath),
  check_census_sha256: immutable.check_census_sha256,
  writer_census_sha256: immutable.writer_census_sha256,
  runtime_provenance_sha256: immutable.runtime_provenance.sha256,
  producer_files_sha256: immutable.producer_files_sha256,
  producer_source_archive_sha256: immutable.producer_source.archive_sha256,
  producer_source_commit: immutable.producer_source.commit,
  raw_evidence_manifest_sha256: sha256File(paths["raw-evidence-manifest.json"]),
  postconditions_sha256: sha256File(join(root, "postconditions.json")),
  secret_scan_sha256: sha256File(paths["secret-scan.json"]),
  route_expectations_sha256: sha256File(paths["route-expectations.json"]),
  stack_identity_before_sha256: stackBefore.aggregate_sha256,
  stack_identity_after_sha256: stackAfter.aggregate_sha256,
  correctness_report_sha256: sha256File(paths["correctness-report.json"]),
  overall_result: report.result,
};
verifyLiveProducerSource(producerSourceVerification);
writeFileSync(paths["COMPLETED.json"], `${JSON.stringify(completion, null, 2)}\n`, { flag: "wx" });
return completion;
} catch (error) {
  for (const path of Object.values(paths)) {
    if (!existsSync(path)) continue;
    const stats = lstatSync(path);
    if (stats.isFile() || stats.isSymbolicLink()) unlinkSync(path);
  }
  throw error;
}
}

if (import.meta.filename === process.argv[1]) {
  const index = process.argv.indexOf("--dir");
  if (index < 0 || !process.argv[index + 1]) fail("usage: finalize-correctness-evidence.mjs --dir <correctness-run-root>");
  console.log(JSON.stringify(finalizeCorrectnessEvidence(process.argv[index + 1])));
}
