import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { actualCorrectnessCensus, expectedCorrectnessCensus, sha256File, validateCorrectnessReport, validateImmutableInputs, validateRawManifest } from "./correctness-contract.mjs";
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
  const immutable = validateImmutableInputs(JSON.parse(readFileSync(immutablePath, "utf8")), root);
  const rawManifest = JSON.parse(readFileSync(rawPath, "utf8"));
  const rawEntries = validateRawManifest(rawManifest, root, immutable);
  const secretScan = verifySecretScan({ root, report: JSON.parse(readFileSync(scanPath, "utf8")), manifest: rawPath });
  const report = validateCorrectnessReport(JSON.parse(readFileSync(reportPath, "utf8")), root, immutable, rawEntries, secretScan);
  const expected = {
    schema_version: 1, status: "COMPLETE", run_id: immutable.run_id, side: immutable.side,
    completed_at: completion.completed_at,
    artifact_count: expectedCorrectnessCensus(root, rawManifest).files.length - 1,
    sealed_file_count: expectedCorrectnessCensus(root, rawManifest).files.length,
    sealed_directory_count: expectedCorrectnessCensus(root, rawManifest).directories.length,
    immutable_inputs_sha256: sha256File(immutablePath), check_census_sha256: immutable.check_census_sha256,
    producer_files_sha256: immutable.producer_files_sha256, raw_evidence_manifest_sha256: sha256File(rawPath),
    postconditions_sha256: sha256File(join(root, "postconditions.json")),
    secret_scan_sha256: sha256File(scanPath), correctness_report_sha256: sha256File(reportPath), overall_result: report.result,
  };
  if (!Number.isFinite(Date.parse(completion.completed_at)) || JSON.stringify(completion) !== JSON.stringify(expected)) fail("correctness completion hash chain/census is invalid");
  const actual = actualCorrectnessCensus(root);
  const census = expectedCorrectnessCensus(root, rawManifest);
  if (JSON.stringify(actual) !== JSON.stringify(census)) fail("correctness sealed-tree exact census failed");
  if (requirePassed && report.result !== "passed") fail(`correctness evidence is complete but not passed: ${report.result}`);
  return { root, completion, immutable, report };
}

if (import.meta.filename === process.argv[1]) {
  const path = process.argv[2];
  if (!path) fail("usage: verify-correctness-evidence.mjs <COMPLETED.json>");
  const verified = verifyCorrectnessCompletion(path);
  console.log(JSON.stringify({ schema_version: 1, verified: true, side: verified.immutable.side, result: verified.report.result, completion_sha256: sha256File(path) }));
}
