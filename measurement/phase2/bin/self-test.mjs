import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../../..");
const bin = resolve(import.meta.dirname);
const fixtureRoot = resolve(import.meta.dirname, "../test-fixtures");
const aggregateSource = readFileSync(join(bin, "aggregate-pairs.mjs"), "utf8");
const { conventionalMedian, rankedQuantile } = await import("./statistics.mjs");
const { verifyRevalidationEvidence } = await import("./revalidation-evidence.mjs");
assert.equal(conventionalMedian([4, 1, 3, 2]), 2.5);
assert.equal(conventionalMedian([3, 1, 2]), 2);
assert.equal(rankedQuantile([1, 2, 3, 4], 0.95), 4);
for (const contract of [
  "At least three contemporaneous current/baseline pairs are required.",
  "Preferred CPU reduction is at least 80%; below roughly 50% is the explicit stop condition; 50-80% requires owner review.",
  "approximately_300_ms_guidance_interpretation: \"OWNER_REVIEW_REQUIRED\"",
  "binding_p95_gate: null",
  "autonomous_progression_authorised: false",
  "--verify-json",
  "refusing aggregate output collision",
  ".output-manifest.sha256",
  ".COMPLETED.json",
  "orchestration_output_manifest_sha256",
]) assert.match(aggregateSource, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const temp = mkdtempSync(join(tmpdir(), "issue-2352-phase2-selftest-"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const run = (script, args, options = {}) => execFileSync(process.execPath, [join(bin, script), ...args], { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
function rejects(script, args, pattern) {
  assert.throws(() => run(script, args), pattern);
}
const harnessPaths = [
  ...readdirSync(bin).map((name) => join(bin, name)).filter((path) => statSync(path).isFile()),
  join(root, "docker-compose.yml"),
  join(root, "Caddyfile.staging"),
  join(root, "measurement/stack/docker-compose.measure.yml"),
  join(root, "measurement/stack/measure-stack.sh"),
].sort();
const harnessManifestPath = join(temp, "harness-files.sha256");
writeFileSync(harnessManifestPath, `${harnessPaths.map((path) => `${sha(readFileSync(path))}  ${path}`).join("\n")}\n`);
run("verify-harness-manifest.mjs", [harnessManifestPath]);
const incompleteHarnessManifestPath = join(temp, "incomplete-harness-files.sha256");
writeFileSync(incompleteHarnessManifestPath, `${harnessPaths.slice(1).map((path) => `${sha(readFileSync(path))}  ${path}`).join("\n")}\n`);
rejects("verify-harness-manifest.mjs", [incompleteHarnessManifestPath], /exact complete reviewed harness file set/);

const body = Buffer.from("bound fixture body\n");
const bodyPath = join(temp, "body.txt");
const headersPath = join(temp, "headers.txt");
const sourcePath = join(temp, "source.tar");
const reportPath = join(temp, "correctness.json");
const archivePath = join(temp, "canonical.dump");
writeFileSync(bodyPath, body);
writeFileSync(headersPath, 'HTTP/1.1 200 OK\r\nETag: "fixture-etag"\r\nX-Nextjs-Cache: HIT\r\nCache-Control: private, no-store\r\n\r\n');
writeFileSync(archivePath, "canonical database fixture");
const imageId = `sha256:${"a".repeat(64)}`;
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
execFileSync("git", ["archive", "--format=tar", `--output=${sourcePath}`, revision], { cwd: root });
const route = { next_cache: "ABSENT", etag: null, body_sha256: null };
const currentRoutes = { "/about": { next_cache: "HIT", etag: '"fixture-etag"', body_sha256: sha(body) }, "/": route, "/join": route, "/contact": route };
writeFileSync(reportPath, `${JSON.stringify({ schema_version: 1, result: "passed", side: "current", image_id: imageId, oci_revision: revision, source_archive_sha256: sha(readFileSync(sourcePath)), canonical_database_archive_sha256: sha(readFileSync(archivePath)), routes: currentRoutes })}\n`);
const manifest = {
  schema_version: 1,
  harness_scope: "issue-2352-phase2",
  canonical_database: { archive_path: archivePath, archive_sha256: sha(readFileSync(archivePath)) },
  sides: {
    current: {
      image_reference: `fixture@${imageId}`,
      image_id: imageId,
      oci_revision: revision,
      source_archive: { path: sourcePath, sha256: sha(readFileSync(sourcePath)) },
      correctness_report: { path: reportPath, sha256: sha(readFileSync(reportPath)) },
      routes: currentRoutes,
    },
  },
};
const manifestPath = join(temp, "manifest.json");
const imageInspectPath = join(temp, "image-inspect.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
writeFileSync(imageInspectPath, `${JSON.stringify([{ Id: imageId, RepoDigests: ["fixture@sha256:immutable"], Config: { Labels: { "org.opencontainers.image.revision": revision } } }])}\n`);

run("verify-binding.mjs", ["--manifest", manifestPath, "--side", "current", "--image-reference", `fixture@${imageId}`, "--image-inspect", imageInspectPath, "--out", join(temp, "binding.json")]);
const failedReportPath = join(temp, "failed-correctness.json");
const failedReport = JSON.parse(readFileSync(reportPath, "utf8"));
failedReport.result = "failed";
writeFileSync(failedReportPath, JSON.stringify(failedReport));
const failedManifest = structuredClone(manifest);
failedManifest.sides.current.correctness_report = { path: failedReportPath, sha256: sha(readFileSync(failedReportPath)) };
const failedManifestPath = join(temp, "failed-correctness-manifest.json");
writeFileSync(failedManifestPath, JSON.stringify(failedManifest));
rejects("verify-binding.mjs", ["--manifest", failedManifestPath, "--side", "current", "--image-reference", `fixture@${imageId}`, "--image-inspect", imageInspectPath, "--out", join(temp, "failed-result-binding.json")], /bound correctness report payload must have schema_version 1 and result passed/);
run("verify-http-proof.mjs", ["--manifest", manifestPath, "--side", "current", "--route", "/about", "--phase", "valid", "--headers", headersPath, "--body", bodyPath, "--out", join(temp, "proof.json")]);
const warmEvidence = join(temp, "warm-evidence");
mkdirSync(warmEvidence);
for (const sample of [1, 2]) {
  writeFileSync(join(warmEvidence, `sample-${sample}.headers`), readFileSync(headersPath));
  writeFileSync(join(warmEvidence, `sample-${sample}.body`), body);
}
const warmCsv = join(temp, "warm.csv");
writeFileSync(warmCsv, "200,0.001,0.002\n200,0.003,0.004\n");
run("verify-warm-block.mjs", ["--manifest", manifestPath, "--side", "current", "--route", "/about", "--evidence-dir", warmEvidence, "--timing-csv", warmCsv, "--samples", "2", "--out", join(temp, "warm-proof.json")]);
writeFileSync(join(warmEvidence, "sample-2.headers"), readFileSync(join(fixtureRoot, "wrong-cache.headers")));
rejects("verify-warm-block.mjs", ["--manifest", manifestPath, "--side", "current", "--route", "/about", "--evidence-dir", warmEvidence, "--timing-csv", warmCsv, "--samples", "2", "--out", join(temp, "warm-cache-rejected.json")], /sample 2 cache classification changed/);
writeFileSync(join(warmEvidence, "sample-2.headers"), readFileSync(headersPath));
writeFileSync(join(warmEvidence, "sample-2.body"), readFileSync(join(fixtureRoot, "mutated-body.txt")));
rejects("verify-warm-block.mjs", ["--manifest", manifestPath, "--side", "current", "--route", "/about", "--evidence-dir", warmEvidence, "--timing-csv", warmCsv, "--samples", "2", "--out", join(temp, "warm-body-rejected.json")], /sample 2 body checksum changed/);

rejects("verify-http-proof.mjs", ["--manifest", manifestPath, "--side", "current", "--route", "/about", "--phase", "wrong-cache", "--headers", join(fixtureRoot, "wrong-cache.headers"), "--body", bodyPath, "--out", join(temp, "wrong-cache.json")], /expected X-Nextjs-Cache HIT/);
rejects("verify-http-proof.mjs", ["--manifest", manifestPath, "--side", "current", "--route", "/about", "--phase", "mutated-body", "--headers", headersPath, "--body", join(fixtureRoot, "mutated-body.txt"), "--out", join(temp, "mutated-body.json")], /body checksum changed/);

const revalidationDir = join(temp, "revalidation-evidence");
mkdirSync(revalidationDir);
const revalidationHeaders = (cache) => `HTTP/1.1 200 OK\r\nETag: "fixture-etag"\r\nX-Nextjs-Cache: ${cache}\r\n\r\n`;
const revalidationProof = (phase, cache, accepted) => ({ schema_version: 1, side: "current", route: "/about", phase, status: 200, next_cache: cache, accepted_cache_values: accepted, etag: '"fixture-etag"', body_sha256: sha(body), verified: true });
writeFileSync(join(revalidationDir, "first.csv"), "200,0.001,0.002\n");
writeFileSync(join(revalidationDir, "window-cpu-usec.csv"), "/about,1,1,2,1\n");
writeFileSync(join(revalidationDir, "first.headers"), revalidationHeaders("STALE"));
writeFileSync(join(revalidationDir, "first.body"), body);
writeFileSync(join(revalidationDir, "first-proof.json"), JSON.stringify(revalidationProof("revalidation-first", "STALE", ["STALE"])));
for (const [attempt, cache] of [[1, "STALE"], [2, "HIT"]]) {
  writeFileSync(join(revalidationDir, `attempt-${attempt}.headers`), revalidationHeaders(cache));
  writeFileSync(join(revalidationDir, `attempt-${attempt}.body`), body);
  writeFileSync(join(revalidationDir, `attempt-${attempt}-proof.json`), JSON.stringify(revalidationProof(`revalidation-attempt-${attempt}`, cache, ["STALE", "HIT"])));
}
const finalHitProof = readFileSync(join(revalidationDir, "attempt-2-proof.json"));
writeFileSync(join(revalidationDir, "regenerated-proof.json"), finalHitProof);
assert.equal(verifyRevalidationEvidence({ root: revalidationDir, side: "current", expected: currentRoutes["/about"] }).attempts.length, 2);
unlinkSync(join(revalidationDir, "regenerated-proof.json"));
assert.throws(() => verifyRevalidationEvidence({ root: revalidationDir, side: "current", expected: currentRoutes["/about"] }), /missing regenerated-proof/);
writeFileSync(join(revalidationDir, "regenerated-proof.json"), finalHitProof);
writeFileSync(join(revalidationDir, "first.headers"), revalidationHeaders("MISS"));
assert.throws(() => verifyRevalidationEvidence({ root: revalidationDir, side: "current", expected: currentRoutes["/about"] }), /revalidation-first raw status\/cache proof failed/);
writeFileSync(join(revalidationDir, "first.headers"), revalidationHeaders("STALE"));

const badManifest = structuredClone(manifest);
badManifest.canonical_database.archive_sha256 = "0".repeat(64);
const badManifestPath = join(temp, "bad-manifest.json");
writeFileSync(badManifestPath, JSON.stringify(badManifest));
rejects("verify-binding.mjs", ["--manifest", badManifestPath, "--side", "current", "--image-reference", `fixture@${imageId}`, "--image-inspect", imageInspectPath, "--out", join(temp, "bad-binding.json")], /canonical database archive checksum mismatch/);

const sealed = join(temp, "sealed");
mkdirSync(sealed);
writeFileSync(join(sealed, "evidence.txt"), "immutable evidence\n");
run("finalize-run.mjs", ["--dir", sealed, "--side", "current", "--pair-id", "fixture-pair"]);
run("verify-completed-run.mjs", [sealed]);
writeFileSync(join(sealed, "evidence.txt"), "mutated evidence\n");
rejects("verify-completed-run.mjs", [sealed], /manifest mismatch/);

function runAsync(script, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(bin, script), ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => code === 0 ? resolvePromise(stdout) : rejectPromise(new Error(stderr)));
  });
}
const server = createServer((request, response) => {
  if (request.url === "/hang") return;
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});
await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
try {
  const address = server.address();
  const ok = JSON.parse(await runAsync("load.mjs", ["--url", `http://127.0.0.1:${address.port}/ok`, "--concurrency", "2", "--duration", "0.1", "--timeout-ms", "500"]));
  assert.equal(ok.schema_version, 2);
  assert.ok(ok.actual_elapsed_ms >= 100);
  assert.ok(ok.requests > 0 && ok.rps > 0);
  assert.deepEqual(ok.error_classes, {});
  const timedOut = JSON.parse(await runAsync("load.mjs", ["--url", `http://127.0.0.1:${address.port}/hang`, "--concurrency", "1", "--duration", "0.05", "--timeout-ms", "25"]));
  assert.equal(timedOut.requests, 0);
  assert.ok(timedOut.errors > 0);
  assert.ok((timedOut.error_classes.timeout ?? 0) > 0);
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

// Build a tiny but fully checksummed four-pair set. This catches schema drift in
// the aggregator without preserving or fabricating real measurement results.
const orchestration = join(temp, "orchestration-fixture");
mkdirSync(orchestration);
const timing = (value) => ({ samples: 2, ttfb_ms: { median: value, p95: value + 1 }, total_ms: { median: value + 2, p95: value + 3 } });
const pairRecords = [];
for (let index = 1; index <= 4; index += 1) {
  const pairId = `fixture-p${index}`;
  const order = index % 2 ? "current-baseline" : "baseline-current";
  const pairDir = join(orchestration, `pair-${index}`);
  mkdirSync(pairDir);
  const sideRecords = [];
  for (const side of order.split("-")) {
    const sideDir = join(pairDir, side);
    mkdirSync(sideDir);
    const current = side === "current";
    const warmValue = current ? 100 + index : 200 + index;
    const summary = {
      schema_version: 2,
      context: { side, pair_id: pairId, order, parameters: { runs: 2, warmup: 1, cold_runs: 1, idle_cycles: 1, idle_seconds: 1, revalidation_seconds: 300, concurrency: 1, duration_seconds: 1, request_timeout_seconds: 1 } },
      immutable_binding: { correctness_result: "passed", manifest_sha256: "c".repeat(64), canonical_database_archive_sha256: "d".repeat(64) },
      database_fingerprint_after: "e".repeat(64),
      environment_identity: { compose_uninterpolated_sha256: "f".repeat(64), app_resource_shape: {}, postgres_resource_shape: {}, network_driver: "bridge", network_options: {}, app_database_target: { host: "postgres" } },
      phases: {
        cold: { "/about": timing(300) },
        warm: { "/about": timing(warmValue), "/": timing(150), "/join": timing(160), "/contact": timing(170) },
        idle: { cycles: [{ cycle: 1, first: timing(warmValue + 5), first_cpu_ms: current ? 3 : 8, first_cache: current ? "HIT" : "ABSENT", followup: timing(warmValue) }] },
        revalidation: { first: timing(250), first_cpu_ms: 10, first_cache: current ? "STALE" : "ABSENT", recovered: { next_cache: current ? "HIT" : "ABSENT" } },
      },
      warm_cpu: {
        "/about": { ms_per_request: current ? 20 + index : 100 + index },
        "/": { ms_per_request: 50 }, "/join": { ms_per_request: 55 }, "/contact": { ms_per_request: 60 },
      },
      cache_proofs: { all_verified: true, count: 16, exact_pre_post_proofs: [
        { route: "/about", phase: "warm-before", next_cache: current ? "HIT" : "ABSENT" },
        { route: "/about", phase: "warm-after", next_cache: current ? "HIT" : "ABSENT" },
      ] },
      concurrency: { concurrency: 1, requested_duration_s: 1, request_timeout_ms: 1000, requests: 10, rps: current ? 10 : 8, errors: 0, error_classes: {}, statuses: { "200": 10 }, cpu: { ms_per_request: current ? 4 : 9 }, firstByte: { median_ms: current ? 90 : 180, p95_ms: current ? 100 : 200 } },
      evidence_totals: { restart_delta: 0, oom_delta: 0, oom_kill_delta: 0, nr_throttled_delta: 0, throttled_usec_delta: 0, suspicious_log_lines: 0, maximum_observed_memory_bytes: current ? 1000 : 1100 },
    };
    writeFileSync(join(sideDir, "summary.json"), `${JSON.stringify(summary)}\n`);
    run("finalize-run.mjs", ["--dir", sideDir, "--side", side, "--pair-id", pairId]);
    const pairBase = Date.UTC(2026, 7, 6, 0, (index - 1) * 10, 0);
    const first = sideRecords.length === 0;
    sideRecords.push({ sequence: sideRecords.length + 1, side, restore_started_at: new Date(pairBase + (first ? 1 : 11) * 1000).toISOString(), started_at: new Date(pairBase + (first ? 2 : 12) * 1000).toISOString(), ended_at: new Date(pairBase + (first ? 10 : 20) * 1000).toISOString(), gap_from_previous_seconds: first ? 0 : 2, database_fingerprint_before: "e".repeat(64), database_fingerprint_after: "e".repeat(64) });
  }
  const pairBase = Date.UTC(2026, 7, 6, 0, (index - 1) * 10, 0);
  const pair = { schema_version: 2, status: "COMPLETE", quiet_host_attested: true, pair_id: pairId, order, started_at: new Date(pairBase).toISOString(), ended_at: new Date(pairBase + 21_000).toISOString(), maximum_inter_side_gap_seconds: 600, canonical_database_archive_sha256: "d".repeat(64), sides: sideRecords };
  writeFileSync(join(pairDir, "pair.json"), `${JSON.stringify(pair)}\n`);
  run("finalize-run.mjs", ["--dir", pairDir, "--side", "pair", "--pair-id", pairId]);
  pairRecords.push({ pair_id: pairId, order, pair_output: pairDir, status: "COMPLETE", wrapper_invoked_at_utc: new Date(pairBase - 1000).toISOString(), wrapper_returned_at_utc: new Date(pairBase + 22_000).toISOString(), pair_started_at_utc: pair.started_at, pair_ended_at_utc: pair.ended_at, inter_pair_gap_seconds: index === 1 ? 0 : 577 });
}
const pairsPath = join(orchestration, "pairs.jsonl");
const setManifestPath = join(orchestration, "set-output-manifest.sha256");
const setCompletionPath = join(orchestration, "PAIR-COMPLETED.json");
function sealSyntheticSet(records) {
  writeFileSync(pairsPath, `${records.map(JSON.stringify).join("\n")}\n`);
  const setFiles = [];
  const visit = (directory) => readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path); else if (entry.isFile()) setFiles.push(path);
  });
  visit(orchestration);
  const setLines = setFiles.filter((path) => path !== setManifestPath && path !== setCompletionPath).map((path) => {
    const relative = path.slice(orchestration.length + 1).replaceAll("\\", "/");
    return `${sha(readFileSync(path))}  ${statSync(path).size}  ${relative}`;
  }).sort();
  writeFileSync(setManifestPath, `${setLines.join("\n")}\n`);
  const setCompletion = { status: "COMPLETE", pair_count: 4, orders: records.map((pair) => pair.order), maximum_inter_pair_gap_seconds: 600, pairs_manifest_sha256: sha(readFileSync(pairsPath)), set_output_manifest_sha256: sha(readFileSync(setManifestPath)), set_output_artifact_count: setLines.length, pair_outputs: records.map((pair) => pair.pair_output) };
  writeFileSync(setCompletionPath, `${JSON.stringify(setCompletion)}\n`);
}
const overlapping = pairRecords.map((pair, index) => index === 1 ? { ...pair, wrapper_invoked_at_utc: pairRecords[0].wrapper_invoked_at_utc, pair_started_at_utc: pairRecords[0].pair_started_at_utc, inter_pair_gap_seconds: 0 } : pair);
sealSyntheticSet(overlapping);
rejects("aggregate-pairs.mjs", ["--orchestration", orchestration, "--out-prefix", join(temp, "chronology-rejected")], /overlaps|chronology/);
sealSyntheticSet(pairRecords);
rejects("aggregate-pairs.mjs", ["--orchestration", orchestration, "--out-prefix", join(temp, "summary-only-rejected")], /sealed raw evidence revalidation failed/);

console.log("phase-2 self-test: all refutations passed");
