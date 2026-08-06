// Dependency-free, machine-readable summary for one sealed phase-2 side.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { conventionalMedian, rankedQuantile } from "./statistics.mjs";
import { verifyRevalidationEvidence } from "./revalidation-evidence.mjs";
import { parseStrictHttpHeaders } from "./http-evidence.mjs";
import { classifySideProfile, PROFILE_FINAL, requireKnownProfile } from "./measurement-profile.mjs";
import { verifySecretScan } from "./scan-evidence-secrets.mjs";
import { buildPhase2Correctness } from "./correctness-contract.mjs";

const verifyJsonMode = process.argv[2] === "--verify-json";
const dir = resolve(process.argv[verifyJsonMode ? 3 : 2] ?? "");
if (!dir || !existsSync(dir)) throw new Error("usage: summarise.mjs [--verify-json] <results-dir>");
const fail = (message) => { throw new Error(message); };
const round = (value, digits = 3) => Number(value.toFixed(digits));
const required = (path) => { if (!existsSync(path)) fail(`required evidence missing: ${path}`); return path; };
const json = (path) => JSON.parse(readFileSync(required(path), "utf8"));
const fileSha256 = (path) => createHash("sha256").update(readFileSync(required(path))).digest("hex");
const lines = (path) => readFileSync(required(path), "utf8").trim().split(/\r?\n/).filter(Boolean);
const number = (raw, context) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`invalid number for ${context}: ${raw}`);
  return value;
};
function stats(values) {
  if (values.length === 0) fail("empty statistics sample");
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, median: round(conventionalMedian(sorted)), p95: round(rankedQuantile(sorted, 0.95)), min: round(sorted[0]), max: round(sorted.at(-1)) };
}
function timingCsv(path) {
  const rows = lines(path).map((line, index) => {
    const fields = line.split(",");
    if (fields.length !== 3) fail(`invalid timing row ${index + 1}: ${path}`);
    const status = number(fields[0], "status");
    const ttfbMs = number(fields[1], "TTFB") * 1000;
    const totalMs = number(fields[2], "total") * 1000;
    if (status !== 200 || ttfbMs < 0 || totalMs < ttfbMs) fail(`invalid timing response in ${path}:${index + 1}`);
    return { status, ttfbMs, totalMs };
  });
  return { samples: rows.length, ttfb_ms: stats(rows.map((row) => row.ttfbMs)), total_ms: stats(rows.map((row) => row.totalMs)) };
}
function cpuCsv(path, expectedLabel) {
  const fields = lines(path)[0]?.split(",") ?? [];
  if (fields.length !== 5 || (expectedLabel && fields[1] !== expectedLabel)) fail(`invalid CPU row: ${path}`);
  const requests = ["conc", "window"].includes(fields[1]) ? null : number(fields[1], "CPU requests");
  const start = number(fields[2], "CPU start");
  const end = number(fields[3], "CPU end");
  const delta = number(fields[4], "CPU delta");
  if (end - start !== delta || delta < 0) fail(`invalid CPU delta: ${path}`);
  return { requests, start_usec: start, end_usec: end, delta_usec: delta };
}
function routeFromFile(file) {
  const stem = file.replace(/\.csv$/, "");
  return stem === "_root" ? "/" : `/${stem.replace(/^_/, "").replaceAll("_", "/")}`;
}
function validateResponseEvidence({ headersPath, bodyPath, proof, expected, contextLabel, acceptedCaches }) {
  const parsed = parseStrictHttpHeaders(readFileSync(required(headersPath), "utf8"), `${contextLabel} headers`);
  const bodySha = fileSha256(bodyPath);
  const nextCache = parsed.headers["x-nextjs-cache"] ?? "ABSENT";
  const etag = parsed.headers.etag ?? null;
  if (parsed.status !== 200 || !acceptedCaches.includes(nextCache)) fail(`${contextLabel} raw status/cache proof failed`);
  if (expected.body_sha256 !== null && bodySha !== expected.body_sha256) fail(`${contextLabel} raw body checksum failed`);
  if (expected.etag !== null && etag !== expected.etag) fail(`${contextLabel} raw ETag failed`);
  if (!proof?.verified || proof.status !== 200 || proof.next_cache !== nextCache || proof.body_sha256 !== bodySha || (proof.etag ?? null) !== etag) fail(`${contextLabel} proof JSON disagrees with raw response`);
  return { status: parsed.status, next_cache: nextCache, etag, body_sha256: bodySha };
}
function parseCgroup(path) {
  const sections = {};
  let current;
  for (const line of lines(path)) {
    if (line.startsWith("@@ ")) { current = line.slice(3); sections[current] = {}; continue; }
    if (!current || line === "unavailable") continue;
    const [key, raw] = line.trim().split(/\s+/, 2);
    sections[current][key === raw || raw === undefined ? "value" : key] = number(raw ?? key, `${path} ${line}`);
  }
  return sections;
}
function segmentEvidence(context) {
  const segmentDir = join(dir, "segments");
  const expectedNames = [
    "warm-_about", "warm-_root", "warm-_join", "warm-_contact",
    ...Array.from({ length: context.parameters.idle_cycles }, (_, index) => `idle-${index + 1}`),
    "revalidation", "concurrency",
  ].sort();
  const suffixes = [
    "started-at.txt", "cgroup-before.txt", "restarts-before.txt",
    "runtime-identity-before.json", "docker-stats.csv", "docker-stats.stderr", "sampler-exit-status.txt", "cgroup-after.txt",
    "restarts-after.txt", "runtime-identity-after.json", "app.log", "app-log.stderr", "ended-at.txt",
  ];
  const expectedFiles = new Set(expectedNames.flatMap((name) => suffixes.map((suffix) => `${name}-${suffix}`)));
  const actualFiles = readdirSync(segmentDir).sort();
  if (actualFiles.length !== expectedFiles.size || actualFiles.some((file) => !expectedFiles.has(file))) {
    fail(`segment evidence set differs from the exact expected set: ${actualFiles.filter((file) => !expectedFiles.has(file)).join(",") || "missing files"}`);
  }
  const names = readdirSync(segmentDir)
    .filter((file) => file.endsWith("-cgroup-before.txt"))
    .map((file) => file.replace(/-cgroup-before\.txt$/, ""))
    .sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) fail("timed segment names differ from the exact expected set");
  return Object.fromEntries(names.map((name) => {
    const startedAt = Date.parse(readFileSync(join(segmentDir, `${name}-started-at.txt`), "utf8").trim());
    const endedAt = Date.parse(readFileSync(join(segmentDir, `${name}-ended-at.txt`), "utf8").trim());
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) fail(`segment ${name} has invalid UTC boundaries`);
    if (readFileSync(join(segmentDir, `${name}-sampler-exit-status.txt`), "utf8").trim() !== "0") fail(`segment ${name} sampler did not exit successfully`);
    const before = parseCgroup(join(segmentDir, `${name}-cgroup-before.txt`));
    const after = parseCgroup(join(segmentDir, `${name}-cgroup-after.txt`));
    for (const [capture, parsed] of [["before", before], ["after", after]]) {
      for (const [section, key] of [["cpu.stat", "usage_usec"], ["memory.current", "value"], ["memory.peak", "value"], ["memory.events", "oom"], ["memory.events", "oom_kill"]]) {
        if (!Number.isFinite(parsed[section]?.[key])) fail(`segment ${name} ${capture} cgroup evidence lacks ${section} ${key}`);
      }
    }
    const restartBefore = number(readFileSync(join(segmentDir, `${name}-restarts-before.txt`), "utf8").trim(), "restart before");
    const restartAfter = number(readFileSync(join(segmentDir, `${name}-restarts-after.txt`), "utf8").trim(), "restart after");
    if (!Number.isInteger(restartBefore) || !Number.isInteger(restartAfter) || restartAfter < restartBefore) fail(`segment ${name} restart evidence is invalid`);
    for (const stderrName of [`${name}-docker-stats.stderr`, `${name}-app-log.stderr`]) {
      if (statSync(join(segmentDir, stderrName)).size !== 0) fail(`segment command emitted stderr: ${stderrName}`);
    }
    const statsLines = lines(join(segmentDir, `${name}-docker-stats.csv`));
    const requiredContainers = ["tacbookings-measure-app-1", "tacbookings-measure-postgres-1", "tacbookings-measure-caddy-1", "tacbookings-measure-mailpit-1"];
    const samplesByContainer = Object.fromEntries(requiredContainers.map((container) => [container, 0]));
    const sampleTimes = Object.fromEntries(requiredContainers.map((container) => [container, []]));
    for (const line of statsLines) {
      const fields = line.split(",");
      if (!Number.isFinite(Date.parse(fields[0])) || !Object.hasOwn(samplesByContainer, fields[1])) fail(`segment ${name} has an invalid/unexpected docker-stats row`);
      samplesByContainer[fields[1]] += 1;
      sampleTimes[fields[1]].push(Date.parse(fields[0]));
    }
    for (const container of requiredContainers) {
      if (samplesByContainer[container] < 2) fail(`segment ${name} has fewer than two docker-stats samples for ${container}`);
      const times = sampleTimes[container];
      if (times[0] < startedAt - 3000 || times[0] > startedAt + 1000 || times.at(-1) < endedAt - 3000 || times.at(-1) > endedAt + 1000 || times.some((value, index) => index > 0 && (value <= times[index - 1] || value - times[index - 1] > 3000))) fail(`segment ${name} sampler timestamps/gaps/boundary coverage are invalid for ${container}`);
    }
    if (new Set(Object.values(samplesByContainer)).size !== 1) fail(`segment ${name} docker-stats sample counts differ by container`);
    for (const suffix of ["before", "after"]) {
      const identity = json(join(segmentDir, `${name}-runtime-identity-${suffix}.json`));
      if (JSON.stringify(identity) !== identityCanonical) fail(`segment ${name} ${suffix} runtime identity differs from the sealed app/Postgres identity`);
    }
    const logText = readFileSync(join(segmentDir, `${name}-app.log`), "utf8");
    const errorLines = logText.split(/\r?\n/).filter((line) => /\b(error|fatal|panic|uncaught|unhandled)\b/i.test(line)).length;
    return [name, {
      restart_delta: restartAfter - restartBefore,
      memory_current_before_bytes: before["memory.current"]?.value ?? null,
      memory_current_after_bytes: after["memory.current"]?.value ?? null,
      memory_peak_after_bytes: after["memory.peak"]?.value ?? null,
      nr_throttled_delta: (after["cpu.stat"]?.nr_throttled ?? 0) - (before["cpu.stat"]?.nr_throttled ?? 0),
      throttled_usec_delta: (after["cpu.stat"]?.throttled_usec ?? 0) - (before["cpu.stat"]?.throttled_usec ?? 0),
      oom_delta: (after["memory.events"]?.oom ?? 0) - (before["memory.events"]?.oom ?? 0),
      oom_kill_delta: (after["memory.events"]?.oom_kill ?? 0) - (before["memory.events"]?.oom_kill ?? 0),
      suspicious_log_lines: errorLines,
      docker_stats_rows: statsLines.length,
      docker_stats_samples_by_container: samplesByContainer,
      maximum_docker_stats_gap_ms: Math.max(...Object.values(sampleTimes).flatMap((times) => times.slice(1).map((value, index) => value - times[index]))),
    }];
  }));
}

const context = json(join(dir, "run-context.json"));
requireKnownProfile(context.measurement_profile);
const derivedProfile = classifySideProfile(context.parameters);
if (context.final_profile_parameters_exact !== (derivedProfile === PROFILE_FINAL)) fail("side context final-profile exactness flag is false or stale");
if (context.measurement_profile === PROFILE_FINAL && derivedProfile !== PROFILE_FINAL) fail("final-decision side parameters differ from the exact reviewed profile");
const binding = json(join(dir, "env", "verified-binding.json"));
if (
  !binding.verified || binding.side !== context.side || binding.correctness_result !== "pre_timing_passed" ||
  !/^sha256:[a-f0-9]{64}$/.test(binding.image_id ?? "") ||
  !/^[a-f0-9]{40,64}$/.test(binding.oci_revision ?? "") || binding.source_archive_revision !== binding.oci_revision ||
  !/^[a-f0-9]{64}$/.test(binding.source_archive_sha256 ?? "") ||
  !/^[a-f0-9]{64}$/.test(binding.correctness_completion_sha256 ?? "") ||
  !/^[a-f0-9]{64}$/.test(binding.correctness_report_sha256 ?? "") ||
  !/^[a-f0-9]{64}$/.test(binding.canonical_database_archive_sha256 ?? "")
) fail("immutable binding payload is incomplete or invalid");
if (fileSha256(binding.manifest_path) !== binding.manifest_sha256) fail("bound correctness manifest changed after side verification");
const correctnessManifest = json(binding.manifest_path);
const routeExpectations = correctnessManifest.sides?.[context.side]?.routes;
if (!routeExpectations) fail("bound correctness manifest lacks this side's routes");
const appContainer = json(join(dir, "env", "app-container-inspect.json"));
const postgresContainer = json(join(dir, "env", "postgres-container-inspect.json"));
const caddyContainer = json(join(dir, "env", "caddy-container-inspect.json"));
const mailpitContainer = json(join(dir, "env", "mailpit-container-inspect.json"));
const network = json(join(dir, "env", "network-inspect.json"));
const secretScan = verifySecretScan({ root: dir, report: json(join(dir, "secret-scan.json")), allowedLaterFiles: ["summary.json", "summary.txt", "output-manifest.sha256", "COMPLETED.json"] });
if (!secretScan.passed || secretScan.findings?.length !== 0) fail("raw evidence secret scan did not pass");
if (appContainer.Image !== binding.image_id) fail("raw app container image ID differs from the immutable binding");
if (appContainer.HostConfig.NanoCpus !== 1_000_000_000 || appContainer.HostConfig.Memory !== 1_073_741_824 || appContainer.HostConfig.ReadonlyRootfs !== true || !(appContainer.HostConfig.SecurityOpt ?? []).includes("no-new-privileges:true")) {
  fail("raw app resource identity differs from the measurement contract");
}
if (caddyContainer.Config.Image !== "caddy:2-alpine" || caddyContainer.HostConfig.NanoCpus !== 200_000_000 || caddyContainer.HostConfig.Memory !== 134_217_728) fail("raw Caddy image/resource identity differs");
if (mailpitContainer.Config.Image !== "axllent/mailpit:v1.30.3" || mailpitContainer.HostConfig.NanoCpus !== 200_000_000 || mailpitContainer.HostConfig.Memory !== 134_217_728) fail("raw Mailpit image/resource identity differs");
const appEnvironment = json(join(dir, "env", "app-environment-audit.json"));
if (!appEnvironment.verified || !/^[a-f0-9]{64}$/.test(appEnvironment.keyed_fingerprint_sha256 ?? "") || appEnvironment.prohibited_live_provider_keys?.length || appEnvironment.unknown_sensitive_key_names?.length) fail("sanitized app environment audit is invalid");
const runtimeIdentityInitial = json(join(dir, "env", "runtime-identity-initial.json"));
const runtimeIdentityBeforeCold = json(join(dir, "env", "runtime-identity-before-cold.json"));
const runtimeIdentityAfterCold = json(join(dir, "env", "runtime-identity-after-cold.json"));
const runtimeIdentityBeforeFinalization = json(join(dir, "env", "runtime-identity-before-finalization.json"));
const identityCanonical = JSON.stringify(runtimeIdentityInitial);
for (const [label, identity] of [["before cold", runtimeIdentityBeforeCold], ["after cold", runtimeIdentityAfterCold], ["before finalization", runtimeIdentityBeforeFinalization]]) if (JSON.stringify(identity) !== identityCanonical) fail(`immutable app/Postgres identity differs ${label}`);
if (runtimeIdentityInitial.app?.container_id !== appContainer.Id || runtimeIdentityInitial.app?.image_id !== binding.image_id || runtimeIdentityInitial.postgres?.container_id !== postgresContainer.Id || runtimeIdentityInitial.postgres?.image_id !== postgresContainer.Image || !runtimeIdentityInitial.postgres?.server_version || !runtimeIdentityInitial.verified) fail("initial immutable runtime identity does not bind inspected app/Postgres");
if (readFileSync(join(dir, "env", "caddy-port.txt"), "utf8").trim() !== "127.0.0.1:8027") fail("raw Caddy localhost:8027 binding differs");
if (statSync(join(dir, "env", "caddy-adapt.stderr")).size !== 0) fail("Caddy adaptation emitted stderr");
const adaptedCaddy = readFileSync(join(dir, "env", "caddy-adapted.json"), "utf8");
if (!adaptedCaddy.includes('"app:3000"') || !adaptedCaddy.includes('"listen"') || !adaptedCaddy.includes(":8027")) fail("raw Caddy config does not bind localhost:8027 to app:3000");
const harnessManifestSha = readFileSync(join(dir, "env", "harness-manifest-sha256.txt"), "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(harnessManifestSha) || fileSha256(join(dir, "env", "harness-files.sha256")) !== harnessManifestSha || !json(join(dir, "env", "harness-verification.json")).verified) fail("frozen harness manifest evidence is invalid");
const resourceShape = (container) => ({
  HostConfig: {
    NanoCpus: container.HostConfig.NanoCpus,
    Memory: container.HostConfig.Memory,
    MemorySwap: container.HostConfig.MemorySwap,
    ReadonlyRootfs: container.HostConfig.ReadonlyRootfs,
    SecurityOpt: container.HostConfig.SecurityOpt,
    Tmpfs: container.HostConfig.Tmpfs,
    RestartPolicy: container.HostConfig.RestartPolicy,
    PidsLimit: container.HostConfig.PidsLimit,
    LogConfig: container.HostConfig.LogConfig,
  },
  MountTypesAndDestinations: container.Mounts.map((mount) => ({ Type: mount.Type, Destination: mount.Destination, RW: mount.RW })).sort((a, b) => a.Destination.localeCompare(b.Destination)),
});
const warmFiles = readdirSync(join(dir, "warm"))
  .filter((file) => file.endsWith(".csv") && file !== "cpu-usec.csv")
  .sort();
if (JSON.stringify(warmFiles) !== JSON.stringify(["_about.csv", "_contact.csv", "_join.csv", "_root.csv"])) fail("warm timing route set differs from the exact expected set");
const warm = Object.fromEntries(warmFiles.map((file) => [routeFromFile(file), timingCsv(join(dir, "warm", file))]));
const warmCpu = {};
const warmCpuLines = lines(join(dir, "warm", "cpu-usec.csv"));
if (warmCpuLines.length !== 4) fail("warm CPU evidence must contain exactly four route rows");
for (const [index, line] of warmCpuLines.entries()) {
  const fields = line.split(",");
  if (fields.length !== 5) fail(`invalid warm CPU row ${index + 1}`);
  const route = fields[0];
  const requests = number(fields[1], "warm requests");
  const start = number(fields[2], "warm CPU start");
  const end = number(fields[3], "warm CPU end");
  const delta = number(fields[4], "warm CPU delta");
  if (!warm[route] || warmCpu[route] || warm[route].samples !== requests || end - start !== delta || delta < 0) fail(`warm CPU/timing mismatch for ${route}`);
  warmCpu[route] = { requests, start_usec: start, end_usec: end, delta_usec: delta, ms_per_request: round(delta / requests / 1000) };
}
for (const route of ["/about", "/", "/join", "/contact"]) if (!warm[route] || !warmCpu[route]) fail(`missing warm evidence for ${route}`);
for (const route of ["/about", "/", "/join", "/contact"]) {
  const safe = route === "/" ? "_root" : route.replaceAll("/", "_");
  const blockProof = json(join(dir, "warm", `${safe}-proof.json`));
  const evidenceDir = join(dir, "warm", "evidence", safe);
  const expectedFiles = new Set(Array.from({ length: context.parameters.runs }, (_, index) => index + 1).flatMap((sample) => [`sample-${sample}.headers`, `sample-${sample}.body`]));
  const actualFiles = readdirSync(evidenceDir);
  if (actualFiles.length !== expectedFiles.size || actualFiles.some((file) => !expectedFiles.has(file))) fail(`warm interior evidence set is incomplete for ${route}`);
  if (!blockProof.all_verified || blockProof.side !== context.side || blockProof.route !== route || blockProof.samples !== context.parameters.runs || blockProof.evidence?.length !== context.parameters.runs) fail(`warm block proof shape failed for ${route}`);
  for (let sample = 1; sample <= context.parameters.runs; sample += 1) {
    const raw = validateResponseEvidence({
      headersPath: join(evidenceDir, `sample-${sample}.headers`),
      bodyPath: join(evidenceDir, `sample-${sample}.body`),
      proof: { ...blockProof.evidence[sample - 1], verified: true },
      expected: routeExpectations[route],
      contextLabel: `warm ${route} sample ${sample}`,
      acceptedCaches: [routeExpectations[route].next_cache],
    });
    if (blockProof.evidence[sample - 1].sample !== sample || raw.next_cache !== blockProof.evidence[sample - 1].next_cache) fail(`warm block sample identity failed for ${route} sample ${sample}`);
  }
}

const idleRoot = join(dir, "idle");
const idleCycles = readdirSync(idleRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^cycle-\d+$/.test(entry.name))
  .sort((left, right) => Number(left.name.slice(6)) - Number(right.name.slice(6)))
  .map((entry) => {
    const cycleDir = join(idleRoot, entry.name);
    const cpu = cpuCsv(join(cycleDir, "first-cpu-usec.csv"));
    const windowCpu = cpuCsv(join(cycleDir, "window-cpu-usec.csv"), "window");
    const first = timingCsv(join(cycleDir, "first.csv"));
    if (first.samples !== 1 || cpu.requests !== 1) fail(`idle first-request evidence is not isolated: ${entry.name}`);
    const proof = json(join(cycleDir, "first-proof.json"));
    validateResponseEvidence({ headersPath: join(cycleDir, "first.headers"), bodyPath: join(cycleDir, "first.body"), proof, expected: routeExpectations["/about"], contextLabel: `${entry.name} first`, acceptedCaches: [routeExpectations["/about"].next_cache] });
    const followup = timingCsv(join(cycleDir, "followup.csv"));
    if (followup.samples !== 4) fail(`idle follow-up sample count is not four: ${entry.name}`);
    return { cycle: Number(entry.name.slice(6)), first, first_cpu_ms: round(cpu.delta_usec / 1000), idle_window_cpu_ms: round(windowCpu.delta_usec / 1000), first_cache: proof.next_cache, followup };
  });
if (idleCycles.length !== context.parameters.idle_cycles || idleCycles.some((cycle, index) => cycle.cycle !== index + 1)) fail("idle cycle evidence differs from the exact configured sequence");

const revalidationCpu = cpuCsv(join(dir, "revalidation", "window-cpu-usec.csv"));
const revalidationTiming = timingCsv(join(dir, "revalidation", "first.csv"));
if (revalidationCpu.requests !== 1 || revalidationTiming.samples !== 1) fail("revalidation trigger must contain exactly one timed request");
const { firstProof: revalidationProof, regeneratedProof } = verifyRevalidationEvidence({
  root: join(dir, "revalidation"),
  side: context.side,
  expected: routeExpectations["/about"],
});
const concurrencyRaw = json(join(dir, "conc", "about.json"));
if (concurrencyRaw.schema_version !== 2 || concurrencyRaw.errors !== 0 || Object.keys(concurrencyRaw.statuses ?? {}).some((status) => status !== "200")) {
  fail("concurrency responses contain errors or non-200 statuses");
}
if (concurrencyRaw.concurrency !== context.parameters.concurrency || concurrencyRaw.requested_duration_s !== context.parameters.duration_seconds || concurrencyRaw.request_timeout_ms !== context.parameters.request_timeout_seconds * 1000) {
  fail("concurrency evidence does not match the configured run parameters");
}
const statusTotal = Object.values(concurrencyRaw.statuses).reduce((sum, count) => sum + number(count, "concurrency status count"), 0);
const errorClassTotal = Object.values(concurrencyRaw.error_classes ?? {}).reduce((sum, count) => sum + number(count, "concurrency error class"), 0);
if (statusTotal !== concurrencyRaw.requests || errorClassTotal !== concurrencyRaw.errors || concurrencyRaw.requests_started !== concurrencyRaw.requests + concurrencyRaw.errors) {
  fail("concurrency request/status/error counts do not reconcile");
}
if (concurrencyRaw.firstByte?.count !== concurrencyRaw.requests || concurrencyRaw.total?.count !== concurrencyRaw.requests) {
  fail("concurrency latency counts do not equal completed requests");
}
const requestedMs = number(concurrencyRaw.requested_duration_s, "requested duration") * 1000;
const actualMs = number(concurrencyRaw.actual_elapsed_ms, "actual elapsed");
if (actualMs < requestedMs || actualMs > requestedMs + number(concurrencyRaw.request_timeout_ms, "request timeout") + 5000) {
  fail("concurrency monotonic actual elapsed is outside the bounded duration/timeout window");
}
const calculatedRps = concurrencyRaw.requests / (actualMs / 1000);
if (Math.abs(calculatedRps - concurrencyRaw.rps) > 0.01) fail("concurrency RPS was not computed from monotonic actual elapsed");
const concurrencyCpu = cpuCsv(join(dir, "conc", "cpu-usec.csv"), "conc");
if (concurrencyRaw.requests <= 0) fail("concurrency completed no requests");

const proofFiles = readdirSync(join(dir, "proofs")).filter((file) => file.endsWith(".json")).sort();
const proofs = proofFiles.map((file) => json(join(dir, "proofs", file)));
if (proofs.length === 0 || proofs.some((proof) => !proof.verified)) fail("HTTP proof set is incomplete or invalid");
for (const file of proofFiles) {
  const stem = file.replace(/\.json$/, "");
  const proof = json(join(dir, "proofs", file));
  validateResponseEvidence({ headersPath: join(dir, "proofs", `${stem}.headers`), bodyPath: join(dir, "proofs", `${stem}.body`), proof, expected: routeExpectations[proof.route], contextLabel: `proof ${proof.phase}`, acceptedCaches: proof.accepted_cache_values });
}
const proofKeys = new Set(proofs.map((proof) => `${proof.route}|${proof.phase}`));
const expectedProofKeys = [];
for (const route of ["/about", "/", "/join", "/contact"]) {
  const safe = route === "/" ? "_root" : route.replaceAll("/", "_");
  expectedProofKeys.push(`${route}|warm-${safe}-before`, `${route}|warm-${safe}-after`);
}
for (const cycle of idleCycles) expectedProofKeys.push(`/about|idle-${cycle.cycle}-before`, `/about|idle-${cycle.cycle}-after`);
expectedProofKeys.push("/about|revalidation-before", "/about|concurrency-before", "/about|concurrency-after");
if (context.side === "baseline") expectedProofKeys.push("/about|revalidation-recovered");
for (const key of expectedProofKeys) if (!proofKeys.has(key)) fail(`required pre/post HTTP proof is missing: ${key}`);
if (proofKeys.size !== expectedProofKeys.length) fail("pre/post HTTP proof set contains unexpected identities");
if (new Set(proofs.map((proof) => `${proof.route}|${proof.phase}`)).size !== proofs.length) fail("duplicate HTTP proof identity");
const segments = segmentEvidence(context);
if (Object.values(segments).some((segment) => segment.restart_delta !== 0 || segment.oom_delta !== 0 || segment.oom_kill_delta !== 0)) {
  fail("restart/OOM contamination occurred during a timed segment");
}
const databaseFingerprintBefore = readFileSync(join(dir, "env", "database-fingerprint-before.txt"), "utf8").trim();
const databaseFingerprintAfter = readFileSync(join(dir, "env", "database-fingerprint-after.txt"), "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(databaseFingerprintBefore) || !/^[a-f0-9]{64}$/.test(databaseFingerprintAfter) || databaseFingerprintBefore !== databaseFingerprintAfter) fail("database before/after fingerprints are invalid or differ");
const summary = {
  schema_version: 2,
  methodology: { median: "conventional median; even samples average the two middle values", p95: "sorted[floor(0.95*n)], capped at n-1" },
  directory: dir,
  name: basename(dir),
  context,
  immutable_binding: binding,
  phase2_correctness: buildPhase2Correctness(context.side),
  environment_identity: {
    harness_manifest_sha256: harnessManifestSha,
    compose_uninterpolated_sha256: fileSha256(join(dir, "env", "compose-config-uninterpolated.yml")),
    app_resource_shape: resourceShape(appContainer),
    postgres_resource_shape: resourceShape(postgresContainer),
    caddy_image_id: caddyContainer.Image,
    caddy_resource_shape: resourceShape(caddyContainer),
    mailpit_image_id: mailpitContainer.Image,
    mailpit_resource_shape: resourceShape(mailpitContainer),
    network_driver: network[0]?.Driver,
    network_options: network[0]?.Options ?? {},
    app_database_target: json(join(dir, "env", "app-database-target.json")),
    app_environment_audit: appEnvironment,
    runtime_identity: runtimeIdentityInitial,
    secret_scan_passed: true,
  },
  database_fingerprint_before: databaseFingerprintBefore,
  database_fingerprint_after: databaseFingerprintAfter,
  phases: {
    cold: { "/about": timingCsv(join(dir, "cold", "about.csv")) },
    warm,
    idle: { idle_seconds: null, cycles: idleCycles },
    revalidation: {
      first: revalidationTiming,
      regeneration_window_cpu_ms: round(revalidationCpu.delta_usec / 1000),
      first_cache: revalidationProof.next_cache,
      recovered: regeneratedProof ?? proofs.find((proof) => proof.phase === "revalidation-recovered") ?? null,
    },
  },
  warm_cpu: warmCpu,
  cache_proofs: {
    count: proofs.length + idleCycles.length + 1,
    exact_pre_post_proofs: proofs,
    all_verified: true,
  },
  concurrency: {
    ...concurrencyRaw,
    cpu: { ...concurrencyCpu, ms_per_request: round(concurrencyCpu.delta_usec / concurrencyRaw.requests / 1000) },
  },
  segments,
  evidence_totals: {
    restart_delta: Object.values(segments).reduce((sum, item) => sum + item.restart_delta, 0),
    oom_delta: Object.values(segments).reduce((sum, item) => sum + item.oom_delta, 0),
    oom_kill_delta: Object.values(segments).reduce((sum, item) => sum + item.oom_kill_delta, 0),
    nr_throttled_delta: Object.values(segments).reduce((sum, item) => sum + item.nr_throttled_delta, 0),
    throttled_usec_delta: Object.values(segments).reduce((sum, item) => sum + item.throttled_usec_delta, 0),
    suspicious_log_lines: Object.values(segments).reduce((sum, item) => sum + item.suspicious_log_lines, 0),
    maximum_observed_memory_bytes: Math.max(...Object.values(segments).flatMap((item) => [item.memory_current_before_bytes, item.memory_current_after_bytes, item.memory_peak_after_bytes]).filter(Number.isFinite)),
  },
};
if (verifyJsonMode) {
  const preserved = json(join(dir, "summary.json"));
  if (JSON.stringify(preserved) !== JSON.stringify(summary)) fail("preserved summary does not equal metrics re-derived from sealed raw evidence");
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} else {
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(`side=${context.side} pair=${context.pair_id} order=${context.order} sequence=${context.sequence}`);
  console.log(`/about warm CPU=${warmCpu["/about"].ms_per_request} ms/request; TTFB median=${warm["/about"].ttfb_ms.median} ms p95=${warm["/about"].ttfb_ms.p95} ms`);
  console.log(`idle first requests=${idleCycles.map((cycle) => cycle.first.ttfb_ms.median).join(",")} ms; revalidation cache=${revalidationProof.next_cache}`);
  console.log(`concurrency actual_elapsed=${concurrencyRaw.actual_elapsed_ms} ms rps=${concurrencyRaw.rps} errors=${concurrencyRaw.errors}`);
  console.log(`restarts=${summary.evidence_totals.restart_delta} oom=${summary.evidence_totals.oom_delta} throttled_usec=${summary.evidence_totals.throttled_usec_delta} suspicious_logs=${summary.evidence_totals.suspicious_log_lines}`);
}
