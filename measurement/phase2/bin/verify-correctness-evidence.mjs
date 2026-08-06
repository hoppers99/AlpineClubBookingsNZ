import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { actualCorrectnessCensus, expectedCorrectnessCensus, sha256File, validateCorrectnessReport, validateImmutableInputs, validateRawManifest } from "./correctness-contract.mjs";
import { verifyCorrectnessRouteEvidence } from "./correctness-route-evidence.mjs";
import { compareStackIdentities, verifyStackIdentity } from "./correctness-stack-identity.mjs";
import { verifySecretScan } from "./scan-evidence-secrets.mjs";

const fail = (message) => { throw new Error(message); };
export function verifyCorrectnessCompletion(completionPath, { requirePassed = true } = {}) {
  const absolute = resolve(completionPath);
  const root = dirname(absolute);
  if (absolute !== join(root, "COMPLETED.json")) fail("correctness completion must be the root COMPLETED.json");
  const completion = JSON.parse(readFileSync(absolute, "utf8"));
  const immutablePath = join(root, "inputs", "immutable-inputs.json");
  const rawPath = join(root, "raw-evidence-manifest.json");
  const scanPath = join(root, "secret-scan.json");
  const reportPath = join(root, "correctness-report.json");
  const routePath = join(root, "route-expectations.json");
  const immutable = validateImmutableInputs(JSON.parse(readFileSync(immutablePath, "utf8")), root);
  const stackOptions = { imageId: immutable.image.id, composeProject: immutable.environment.compose_project, databaseFingerprint: immutable.database.logical_fingerprint_before };
  const stackBefore = verifyStackIdentity(root, "inputs/stack-identity-before.json", { ...stackOptions, stage: "before" });
  const stackAfter = verifyStackIdentity(root, "postcondition-evidence/stack-identity-after.json", { ...stackOptions, stage: "after" });
  compareStackIdentities(stackBefore, stackAfter);
  if (Date.parse(stackBefore.aggregate.captured_at) > Date.parse(immutable.created_at) || Date.parse(stackAfter.aggregate.captured_at) < Date.parse(immutable.created_at)) fail("correctness stack identity capture chronology is invalid");
  const rawManifest = JSON.parse(readFileSync(rawPath, "utf8"));
  const rawEntries = validateRawManifest(rawManifest, root, immutable);
  const postconditions = JSON.parse(readFileSync(join(root, "postconditions.json"), "utf8"));
  if (Date.parse(postconditions.completed_at) < Date.parse(stackAfter.aggregate.captured_at)) fail("correctness postconditions precede the after-run stack identity capture");
  const routeEvidence = verifyCorrectnessRouteEvidence(root, immutable, rawEntries);
  const routeExpectations = JSON.parse(readFileSync(routePath, "utf8"));
  const expectedRoutes = { schema_version: 1, run_id: immutable.run_id, side: immutable.side, evidence_path: routeEvidence.evidencePath, evidence_sha256: routeEvidence.evidenceSha256, routes: routeEvidence.routes };
  if (JSON.stringify(routeExpectations) !== JSON.stringify(expectedRoutes)) fail("sealed route expectations differ from independently parsed correctness responses");
  const secretScan = verifySecretScan({ root, report: JSON.parse(readFileSync(scanPath, "utf8")), manifest: rawPath });
  const report = validateCorrectnessReport(JSON.parse(readFileSync(reportPath, "utf8")), root, immutable, rawEntries, secretScan);
  const expected = {
    schema_version: 1, status: "COMPLETE", run_id: immutable.run_id, side: immutable.side,
    completed_at: completion.completed_at,
    artifact_count: expectedCorrectnessCensus(root, rawManifest).files.length - 1,
    sealed_file_count: expectedCorrectnessCensus(root, rawManifest).files.length,
    sealed_directory_count: expectedCorrectnessCensus(root, rawManifest).directories.length,
    immutable_inputs_sha256: sha256File(immutablePath), check_census_sha256: immutable.check_census_sha256, writer_census_sha256: immutable.writer_census_sha256,
    producer_files_sha256: immutable.producer_files_sha256, producer_source_archive_sha256: immutable.producer_source.archive_sha256,
    producer_source_commit: immutable.producer_source.commit, raw_evidence_manifest_sha256: sha256File(rawPath),
    postconditions_sha256: sha256File(join(root, "postconditions.json")),
    secret_scan_sha256: sha256File(scanPath), route_expectations_sha256: sha256File(routePath),
    stack_identity_before_sha256: stackBefore.aggregate_sha256, stack_identity_after_sha256: stackAfter.aggregate_sha256,
    correctness_report_sha256: sha256File(reportPath), overall_result: report.result,
  };
  if (!Number.isFinite(Date.parse(completion.completed_at)) || JSON.stringify(completion) !== JSON.stringify(expected)) fail("correctness completion hash chain/census is invalid");
  const actual = actualCorrectnessCensus(root);
  const census = expectedCorrectnessCensus(root, rawManifest);
  if (JSON.stringify(actual) !== JSON.stringify(census)) fail("correctness sealed-tree exact census failed");
  if (requirePassed && report.result !== "pre_timing_passed") fail(`correctness evidence is complete but not pre-timing ready: ${report.result}`);
  return { root, completion, immutable, report, routeExpectations };
}

if (import.meta.filename === process.argv[1]) {
  const path = process.argv[2];
  if (!path) fail("usage: verify-correctness-evidence.mjs <COMPLETED.json>");
  const verified = verifyCorrectnessCompletion(path);
  console.log(JSON.stringify({ schema_version: 1, verified: true, side: verified.immutable.side, result: verified.report.result, completion_sha256: sha256File(path) }));
}
