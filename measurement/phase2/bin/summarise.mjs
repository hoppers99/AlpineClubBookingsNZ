// Dependency-free, machine-readable summary for one sealed phase-2 side.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "");
if (!dir || !existsSync(dir)) throw new Error("usage: summarise.mjs <results-dir>");
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
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: values.length, median: round(at(0.5)), p95: round(at(0.95)), min: round(sorted[0]), max: round(sorted.at(-1)) };
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
  const requests = fields[1] === "conc" ? null : number(fields[1], "CPU requests");
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
function segmentEvidence() {
  const segmentDir = join(dir, "segments");
  const names = readdirSync(segmentDir)
    .filter((file) => file.endsWith("-cgroup-before.txt"))
    .map((file) => file.replace(/-cgroup-before\.txt$/, ""))
    .sort();
  return Object.fromEntries(names.map((name) => {
    const before = parseCgroup(join(segmentDir, `${name}-cgroup-before.txt`));
    const after = parseCgroup(join(segmentDir, `${name}-cgroup-after.txt`));
    const restartBefore = number(readFileSync(join(segmentDir, `${name}-restarts-before.txt`), "utf8").trim(), "restart before");
    const restartAfter = number(readFileSync(join(segmentDir, `${name}-restarts-after.txt`), "utf8").trim(), "restart after");
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
    }];
  }));
}

const context = json(join(dir, "run-context.json"));
const binding = json(join(dir, "env", "verified-binding.json"));
const appContainer = json(join(dir, "env", "app-container-inspect.json"));
const postgresContainer = json(join(dir, "env", "postgres-container-inspect.json"));
const network = json(join(dir, "env", "network-inspect.json"));
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
const warm = Object.fromEntries(warmFiles.map((file) => [routeFromFile(file), timingCsv(join(dir, "warm", file))]));
const warmCpu = {};
for (const [index, line] of lines(join(dir, "warm", "cpu-usec.csv")).entries()) {
  const fields = line.split(",");
  if (fields.length !== 5) fail(`invalid warm CPU row ${index + 1}`);
  const route = fields[0];
  const requests = number(fields[1], "warm requests");
  const start = number(fields[2], "warm CPU start");
  const end = number(fields[3], "warm CPU end");
  const delta = number(fields[4], "warm CPU delta");
  if (!warm[route] || warm[route].samples !== requests || end - start !== delta || delta < 0) fail(`warm CPU/timing mismatch for ${route}`);
  warmCpu[route] = { requests, start_usec: start, end_usec: end, delta_usec: delta, ms_per_request: round(delta / requests / 1000) };
}
for (const route of ["/about", "/", "/join", "/contact"]) if (!warm[route] || !warmCpu[route]) fail(`missing warm evidence for ${route}`);

const idleRoot = join(dir, "idle");
const idleCycles = readdirSync(idleRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^cycle-\d+$/.test(entry.name))
  .sort((left, right) => Number(left.name.slice(6)) - Number(right.name.slice(6)))
  .map((entry) => {
    const cycleDir = join(idleRoot, entry.name);
    const cpu = cpuCsv(join(cycleDir, "first-cpu-usec.csv"));
    const first = timingCsv(join(cycleDir, "first.csv"));
    if (first.samples !== 1 || cpu.requests !== 1) fail(`idle first-request evidence is not isolated: ${entry.name}`);
    const proof = json(join(cycleDir, "first-proof.json"));
    if (!proof.verified) fail(`idle proof failed: ${entry.name}`);
    return { cycle: Number(entry.name.slice(6)), first, first_cpu_ms: round(cpu.delta_usec / 1000), first_cache: proof.next_cache, followup: timingCsv(join(cycleDir, "followup.csv")) };
  });
if (idleCycles.length === 0) fail("no isolated idle cycles found");

const revalidationCpu = cpuCsv(join(dir, "revalidation", "first-cpu-usec.csv"));
const revalidationProof = json(join(dir, "revalidation", "first-proof.json"));
const concurrencyRaw = json(join(dir, "conc", "about.json"));
if (concurrencyRaw.schema_version !== 2 || concurrencyRaw.errors !== 0 || Object.keys(concurrencyRaw.statuses ?? {}).some((status) => status !== "200")) {
  fail("concurrency responses contain errors or non-200 statuses");
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
const proofKeys = new Set(proofs.map((proof) => `${proof.route}|${proof.phase}`));
const expectedProofKeys = [];
for (const route of ["/about", "/", "/join", "/contact"]) {
  const safe = route === "/" ? "_root" : route.replaceAll("/", "_");
  expectedProofKeys.push(`${route}|warm-${safe}-before`, `${route}|warm-${safe}-after`);
}
for (const cycle of idleCycles) expectedProofKeys.push(`/about|idle-${cycle.cycle}-before`, `/about|idle-${cycle.cycle}-after`);
expectedProofKeys.push("/about|revalidation-before", "/about|revalidation-recovered", "/about|concurrency-before", "/about|concurrency-after");
for (const key of expectedProofKeys) if (!proofKeys.has(key)) fail(`required pre/post HTTP proof is missing: ${key}`);
if (new Set(proofs.map((proof) => `${proof.route}|${proof.phase}`)).size !== proofs.length) fail("duplicate HTTP proof identity");
const segments = segmentEvidence();
if (Object.values(segments).some((segment) => segment.restart_delta !== 0 || segment.oom_delta !== 0 || segment.oom_kill_delta !== 0)) {
  fail("restart/OOM contamination occurred during a timed segment");
}

const summary = {
  schema_version: 2,
  directory: dir,
  name: basename(dir),
  context,
  immutable_binding: binding,
  environment_identity: {
    compose_uninterpolated_sha256: fileSha256(join(dir, "env", "compose-config-uninterpolated.yml")),
    app_resource_shape: resourceShape(appContainer),
    postgres_resource_shape: resourceShape(postgresContainer),
    network_driver: network[0]?.Driver,
    network_options: network[0]?.Options ?? {},
    app_database_target: json(join(dir, "env", "app-database-target.json")),
  },
  database_fingerprint_after: readFileSync(join(dir, "env", "database-fingerprint-after.txt"), "utf8").trim(),
  phases: {
    cold: { "/about": timingCsv(join(dir, "cold", "about.csv")) },
    warm,
    idle: { idle_seconds: null, cycles: idleCycles },
    revalidation: {
      first: timingCsv(join(dir, "revalidation", "first.csv")),
      first_cpu_ms: round(revalidationCpu.delta_usec / 1000),
      first_cache: revalidationProof.next_cache,
      recovered: proofs.find((proof) => proof.phase === "revalidation-recovered") ?? null,
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
writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`side=${context.side} pair=${context.pair_id} order=${context.order} sequence=${context.sequence}`);
console.log(`/about warm CPU=${warmCpu["/about"].ms_per_request} ms/request; TTFB median=${warm["/about"].ttfb_ms.median} ms p95=${warm["/about"].ttfb_ms.p95} ms`);
console.log(`idle first requests=${idleCycles.map((cycle) => cycle.first.ttfb_ms.median).join(",")} ms; revalidation cache=${revalidationProof.next_cache}`);
console.log(`concurrency actual_elapsed=${concurrencyRaw.actual_elapsed_ms} ms rps=${concurrencyRaw.rps} errors=${concurrencyRaw.errors}`);
console.log(`restarts=${summary.evidence_totals.restart_delta} oom=${summary.evidence_totals.oom_delta} throttled_usec=${summary.evidence_totals.throttled_usec_delta} suspicious_logs=${summary.evidence_totals.suspicious_log_lines}`);
