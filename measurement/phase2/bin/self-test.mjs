import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../../..");
const bin = resolve(import.meta.dirname);
const fixtureRoot = resolve(import.meta.dirname, "../test-fixtures");
const aggregateSource = readFileSync(join(bin, "aggregate-pairs.mjs"), "utf8");
for (const contract of [
  "At least three contemporaneous current/baseline pairs are required.",
  "Preferred CPU reduction is at least 80%; below roughly 50% is the explicit stop condition; 50-80% requires owner review.",
  "approximately_300_ms_guidance_interpretation: \"OWNER_REVIEW_REQUIRED\"",
  "binding_p95_gate: null",
  "autonomous_progression_authorised: false",
]) assert.match(aggregateSource, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const temp = mkdtempSync(join(tmpdir(), "issue-2352-phase2-selftest-"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const run = (script, args, options = {}) => execFileSync(process.execPath, [join(bin, script), ...args], { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
function rejects(script, args, pattern) {
  assert.throws(() => run(script, args), pattern);
}

const body = Buffer.from("bound fixture body\n");
const bodyPath = join(temp, "body.txt");
const headersPath = join(temp, "headers.txt");
const sourcePath = join(temp, "source.tar");
const reportPath = join(temp, "correctness.json");
const archivePath = join(temp, "canonical.dump");
writeFileSync(bodyPath, body);
writeFileSync(headersPath, 'HTTP/1.1 200 OK\r\nETag: "fixture-etag"\r\nX-Nextjs-Cache: HIT\r\nCache-Control: private, no-store\r\n\r\n');
writeFileSync(sourcePath, "source archive fixture");
writeFileSync(reportPath, '{"result":"passed"}\n');
writeFileSync(archivePath, "canonical database fixture");
const imageId = `sha256:${"a".repeat(64)}`;
const revision = "b".repeat(40);
const route = { next_cache: "ABSENT", etag: null, body_sha256: null };
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
      correctness_report: { path: reportPath, sha256: sha(readFileSync(reportPath)), result: "passed" },
      routes: { "/about": { next_cache: "HIT", etag: '"fixture-etag"', body_sha256: sha(body) }, "/": route, "/join": route, "/contact": route },
    },
  },
};
const manifestPath = join(temp, "manifest.json");
const imageInspectPath = join(temp, "image-inspect.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
writeFileSync(imageInspectPath, `${JSON.stringify([{ Id: imageId, RepoDigests: ["fixture@sha256:immutable"], Config: { Labels: { "org.opencontainers.image.revision": revision } } }])}\n`);

run("verify-binding.mjs", ["--manifest", manifestPath, "--side", "current", "--image-reference", `fixture@${imageId}`, "--image-inspect", imageInspectPath, "--out", join(temp, "binding.json")]);
run("verify-http-proof.mjs", ["--manifest", manifestPath, "--side", "current", "--route", "/about", "--phase", "valid", "--headers", headersPath, "--body", bodyPath, "--out", join(temp, "proof.json")]);

rejects("verify-http-proof.mjs", ["--manifest", manifestPath, "--side", "current", "--route", "/about", "--phase", "wrong-cache", "--headers", join(fixtureRoot, "wrong-cache.headers"), "--body", bodyPath, "--out", join(temp, "wrong-cache.json")], /expected X-Nextjs-Cache HIT/);
rejects("verify-http-proof.mjs", ["--manifest", manifestPath, "--side", "current", "--route", "/about", "--phase", "mutated-body", "--headers", headersPath, "--body", join(fixtureRoot, "mutated-body.txt"), "--out", join(temp, "mutated-body.json")], /body checksum changed/);

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
    sideRecords.push({ sequence: sideRecords.length + 1, side, restore_started_at: `2026-08-06T00:0${sideRecords.length}:00.000Z`, started_at: `2026-08-06T00:0${sideRecords.length}:01.000Z`, ended_at: `2026-08-06T00:0${sideRecords.length}:02.000Z`, gap_from_previous_seconds: sideRecords.length, database_fingerprint_before: "e".repeat(64), database_fingerprint_after: "e".repeat(64) });
  }
  const pair = { schema_version: 2, status: "COMPLETE", quiet_host_attested: true, pair_id: pairId, order, started_at: "2026-08-06T00:00:00.000Z", ended_at: "2026-08-06T00:02:00.000Z", maximum_inter_side_gap_seconds: 600, canonical_database_archive_sha256: "d".repeat(64), sides: sideRecords };
  writeFileSync(join(pairDir, "pair.json"), `${JSON.stringify(pair)}\n`);
  run("finalize-run.mjs", ["--dir", pairDir, "--side", "pair", "--pair-id", pairId]);
  pairRecords.push({ pair_id: pairId, order, pair_output: pairDir, status: "COMPLETE" });
}
const pairsPath = join(orchestration, "pairs.jsonl");
writeFileSync(pairsPath, `${pairRecords.map(JSON.stringify).join("\n")}\n`);
const setManifestPath = join(orchestration, "set-output-manifest.sha256");
const setFiles = [];
const visit = (directory) => readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) visit(path); else if (entry.isFile()) setFiles.push(path);
});
visit(orchestration);
const setLines = setFiles.filter((path) => path !== setManifestPath && !path.endsWith("PAIR-COMPLETED.json")).map((path) => {
  const relative = path.slice(orchestration.length + 1).replaceAll("\\", "/");
  return `${sha(readFileSync(path))}  ${statSync(path).size}  ${relative}`;
}).sort();
writeFileSync(setManifestPath, `${setLines.join("\n")}\n`);
const setCompletion = { status: "COMPLETE", pair_count: 4, orders: pairRecords.map((pair) => pair.order), pairs_manifest_sha256: sha(readFileSync(pairsPath)), set_output_manifest_sha256: sha(readFileSync(setManifestPath)), set_output_artifact_count: setLines.length, pair_outputs: pairRecords.map((pair) => pair.pair_output) };
writeFileSync(join(orchestration, "PAIR-COMPLETED.json"), `${JSON.stringify(setCompletion)}\n`);
const aggregatePrefix = join(temp, "aggregate");
run("aggregate-pairs.mjs", ["--orchestration", orchestration, "--out-prefix", aggregatePrefix]);
const aggregate = JSON.parse(readFileSync(`${aggregatePrefix}.json`, "utf8"));
assert.equal(aggregate.status, "OWNER_REVIEW_REQUIRED");
assert.equal(aggregate.integrity.required_pairs, 4);
assert.equal(aggregate.observations.current_about_warm_ttfb_ms.binding_p95_gate, null);
writeFileSync(pairsPath, `${readFileSync(pairsPath, "utf8")} `);
rejects("aggregate-pairs.mjs", ["--orchestration", orchestration, "--out-prefix", join(temp, "rejected-aggregate")], /orchestration completion checksum failed/);

console.log("phase-2 self-test: all refutations passed");
