// Evidence-only aggregation for completed phase-2 pair directories. It never
// autonomously authorises progression: qualitative thresholds remain owner
// judgments, and fewer than four evenly counterbalanced pairs is PRELIMINARY_ONLY.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OWNER_THRESHOLDS_VERBATIM = Object.freeze([
  "At least three contemporaneous current/baseline pairs are required.",
  "Preferred CPU reduction is at least 80%; below roughly 50% is the explicit stop condition; 50-80% requires owner review.",
  "Current warm cached median and p95 should be approximately 300 ms or below, with repeatable improvement, stable idle recovery and no unacceptable churn/memory/regeneration load.",
  "Windows/WSL results support relative comparison only, not exact Tokoroa capacity.",
]);
const fail = (message) => { throw new Error(message); };
const round = (value, digits = 3) => Number(value.toFixed(digits));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const median = (values) => {
  if (!values.length || values.some((value) => !Number.isFinite(value))) fail("cannot aggregate invalid values");
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))]);
};
const percentChange = (current, baseline) => {
  if (!(baseline > 0)) fail("baseline comparison value must be positive");
  return round(((current - baseline) / baseline) * 100);
};
const reduction = (current, baseline) => -percentChange(current, baseline);
function argValues(argv) {
  const result = { pairs: [], orchestration: null, outPrefix: null, label: null };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!value) fail(`missing value for ${flag}`);
    if (flag === "--pair") result.pairs.push(resolve(value));
    else if (flag === "--orchestration") result.orchestration = resolve(value);
    else if (flag === "--out-prefix") result.outPrefix = resolve(value);
    else if (flag === "--label") result.label = value;
    else fail(`unknown argument: ${flag}`);
  }
  if (!result.orchestration || !result.outPrefix) fail("--orchestration and --out-prefix are required");
  if (new Set(result.pairs).size !== result.pairs.length) fail("pair directories must be unique");
  return result;
}
function verifyOrchestration(root) {
  const completionPath = resolve(root, "PAIR-COMPLETED.json");
  const manifestPath = resolve(root, "set-output-manifest.sha256");
  const pairsPath = resolve(root, "pairs.jsonl");
  if (!existsSync(completionPath) || !existsSync(manifestPath) || !existsSync(pairsPath)) fail(`orchestration is incomplete: ${root}`);
  const completion = json(completionPath);
  if (completion.status !== "COMPLETE" || hash(manifestPath) !== completion.set_output_manifest_sha256 || hash(pairsPath) !== completion.pairs_manifest_sha256) fail(`orchestration completion checksum failed: ${root}`);
  let count = 0;
  for (const line of readFileSync(manifestPath, "utf8").trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (\d+)  (.+)$/.exec(line);
    if (!match) fail(`invalid set output manifest: ${root}`);
    const path = resolve(root, match[3]);
    if (!(path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) fail(`set output path escapes orchestration: ${match[3]}`);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== Number(match[2]) || hash(path) !== match[1]) fail(`set output checksum mismatch: ${path}`);
    count += 1;
  }
  if (count !== completion.set_output_artifact_count || completion.pair_count < 4 || completion.pair_count % 2 !== 0) fail(`orchestration set shape is invalid: ${root}`);
  const cb = completion.orders.filter((order) => order === "current-baseline").length;
  const bc = completion.orders.filter((order) => order === "baseline-current").length;
  if (cb !== bc || cb + bc !== completion.pair_count) fail(`orchestration order is not evenly counterbalanced: ${root}`);
  const pairs = readFileSync(pairsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (pairs.length !== completion.pair_count || pairs.some((pair) => pair.status !== "COMPLETE")) fail(`orchestration pair records are incomplete: ${root}`);
  const outputs = pairs.map((pair) => resolve(pair.pair_output));
  if (JSON.stringify(outputs) !== JSON.stringify(completion.pair_outputs.map((value) => resolve(value)))) fail(`orchestration pair output binding mismatch: ${root}`);
  return { completion, outputs };
}
function verifyCompleted(root) {
  const manifestPath = resolve(root, "output-manifest.sha256");
  const completionPath = resolve(root, "COMPLETED.json");
  if (!existsSync(manifestPath) || !existsSync(completionPath)) fail(`incomplete output: ${root}`);
  const completion = json(completionPath);
  if (completion.status !== "COMPLETE" || hash(manifestPath) !== completion.output_manifest_sha256) fail(`invalid completion marker: ${root}`);
  let count = 0;
  for (const line of readFileSync(manifestPath, "utf8").trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (\d+)  (.+)$/.exec(line);
    if (!match) fail(`invalid output manifest: ${root}`);
    const path = resolve(root, match[3]);
    if (!(path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) fail(`output path escapes pair: ${match[3]}`);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== Number(match[2]) || hash(path) !== match[1]) fail(`output checksum mismatch: ${path}`);
    count += 1;
  }
  if (count !== completion.artifact_count) fail(`artifact count mismatch: ${root}`);
  return completion;
}
function readPair(root) {
  verifyCompleted(root);
  const pair = json(resolve(root, "pair.json"));
  if (pair.schema_version !== 2 || pair.status !== "COMPLETE" || !pair.quiet_host_attested) fail(`invalid pair metadata: ${root}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(pair.pair_id ?? "")) fail(`invalid pair id: ${root}`);
  if (![["current", "baseline"], ["baseline", "current"]].some((order) => JSON.stringify(order) === JSON.stringify(pair.sides.map((side) => side.side)))) fail(`invalid side order: ${root}`);
  if (pair.order !== pair.sides.map((side) => side.side).join("-")) fail(`declared order mismatch: ${root}`);
  for (const [index, side] of pair.sides.entries()) {
    if (side.sequence !== index + 1 || !Number.isFinite(Date.parse(side.started_at)) || !Number.isFinite(Date.parse(side.ended_at))) fail(`invalid side timestamps: ${root}`);
    if (Date.parse(side.ended_at) < Date.parse(side.started_at)) fail(`side ended before it started: ${root}`);
    if (side.gap_from_previous_seconds > pair.maximum_inter_side_gap_seconds) fail(`maximum pair gap exceeded: ${root}`);
    if (side.database_fingerprint_before !== side.database_fingerprint_after) fail(`database drift in ${side.side}: ${root}`);
  }
  const current = json(resolve(root, "current", "summary.json"));
  const baseline = json(resolve(root, "baseline", "summary.json"));
  verifyCompleted(resolve(root, "current"));
  verifyCompleted(resolve(root, "baseline"));
  for (const [name, run] of [["current", current], ["baseline", baseline]]) {
    if (run.schema_version !== 2 || run.context.side !== name || run.context.pair_id !== pair.pair_id || run.context.order !== pair.order) fail(`run context mismatch for ${name}: ${root}`);
    if (run.immutable_binding.correctness_result !== "passed") fail(`correctness was not passed for ${name}: ${root}`);
    if (!run.cache_proofs?.all_verified || run.evidence_totals.restart_delta !== 0 || run.evidence_totals.oom_delta !== 0 || run.evidence_totals.oom_kill_delta !== 0) fail(`integrity evidence failed for ${name}: ${root}`);
    if (run.concurrency.errors !== 0 || Object.keys(run.concurrency.statuses).some((status) => status !== "200")) fail(`load errors in ${name}: ${root}`);
    if (run.immutable_binding.canonical_database_archive_sha256 !== pair.canonical_database_archive_sha256) fail(`database archive binding mismatch: ${root}`);
  }
  if (current.immutable_binding.manifest_sha256 !== baseline.immutable_binding.manifest_sha256) fail(`side correctness manifests differ: ${root}`);
  if (current.database_fingerprint_after !== pair.sides.find((side) => side.side === "current").database_fingerprint_after || baseline.database_fingerprint_after !== pair.sides.find((side) => side.side === "baseline").database_fingerprint_after) fail(`summary database fingerprint mismatch: ${root}`);
  return { root, pair, current, baseline };
}
function timing(run, phase, route, field) { return run.phases[phase][route][field].median; }
function idleFirstMedian(run) { return median(run.phases.idle.cycles.map((cycle) => cycle.first.ttfb_ms.median)); }
function pairObservation(entry) {
  const { pair, current, baseline, root } = entry;
  const cpuCurrent = current.warm_cpu["/about"].ms_per_request;
  const cpuBaseline = baseline.warm_cpu["/about"].ms_per_request;
  const warmCurrent = timing(current, "warm", "/about", "ttfb_ms");
  const warmBaseline = timing(baseline, "warm", "/about", "ttfb_ms");
  const idleCurrent = idleFirstMedian(current);
  const idleBaseline = idleFirstMedian(baseline);
  const controls = Object.fromEntries(["/", "/join", "/contact"].map((route) => [route, {
    cpu_change_percent: percentChange(current.warm_cpu[route].ms_per_request, baseline.warm_cpu[route].ms_per_request),
    ttfb_change_percent: percentChange(timing(current, "warm", route, "ttfb_ms"), timing(baseline, "warm", route, "ttfb_ms")),
  }]));
  return {
    pair_id: pair.pair_id,
    directory: root,
    order: pair.order,
    started_at: pair.started_at,
    ended_at: pair.ended_at,
    maximum_observed_inter_side_gap_seconds: Math.max(...pair.sides.map((side) => side.gap_from_previous_seconds)),
    about_warm_cpu: { current_ms_per_request: cpuCurrent, baseline_ms_per_request: cpuBaseline, reduction_percent: reduction(cpuCurrent, cpuBaseline) },
    about_warm_latency: {
      current_median_ms: warmCurrent,
      current_p95_ms: current.phases.warm["/about"].ttfb_ms.p95,
      baseline_median_ms: warmBaseline,
      baseline_p95_ms: baseline.phases.warm["/about"].ttfb_ms.p95,
      median_reduction_percent: reduction(warmCurrent, warmBaseline),
      p95_reduction_percent: reduction(current.phases.warm["/about"].ttfb_ms.p95, baseline.phases.warm["/about"].ttfb_ms.p95),
    },
    idle: {
      current_first_request_median_ms: idleCurrent,
      baseline_first_request_median_ms: idleBaseline,
      current_idle_to_warm_ratio: round(idleCurrent / warmCurrent),
      baseline_idle_to_warm_ratio: round(idleBaseline / warmBaseline),
      current_first_request_cpu_ms: current.phases.idle.cycles.map((cycle) => cycle.first_cpu_ms),
      baseline_first_request_cpu_ms: baseline.phases.idle.cycles.map((cycle) => cycle.first_cpu_ms),
    },
    revalidation: { current: current.phases.revalidation, baseline: baseline.phases.revalidation },
    controls,
    cache: {
      current_exact_proofs: current.cache_proofs.count,
      baseline_exact_proofs: baseline.cache_proofs.count,
      current_about_pre_post_all_hit: current.cache_proofs.exact_pre_post_proofs.filter((proof) => proof.route === "/about" && !proof.phase.startsWith("revalidation")).every((proof) => proof.next_cache === "HIT"),
      baseline_all_dynamic: baseline.cache_proofs.exact_pre_post_proofs.every((proof) => proof.next_cache === "ABSENT"),
    },
    memory_and_churn: { current: current.evidence_totals, baseline: baseline.evidence_totals },
    concurrency: {
      current_rps: current.concurrency.rps, baseline_rps: baseline.concurrency.rps,
      rps_change_percent: percentChange(current.concurrency.rps, baseline.concurrency.rps),
      current_cpu_ms_per_request: current.concurrency.cpu.ms_per_request,
      baseline_cpu_ms_per_request: baseline.concurrency.cpu.ms_per_request,
      current_median_ms: current.concurrency.firstByte.median_ms,
      baseline_median_ms: baseline.concurrency.firstByte.median_ms,
      current_p95_ms: current.concurrency.firstByte.p95_ms,
      baseline_p95_ms: baseline.concurrency.firstByte.p95_ms,
      errors_current: current.concurrency.errors,
      errors_baseline: baseline.concurrency.errors,
      error_classes_current: current.concurrency.error_classes,
      error_classes_baseline: baseline.concurrency.error_classes,
    },
  };
}

const args = argValues(process.argv.slice(2));
if (args.outPrefix.startsWith(`${args.orchestration}/`) || args.outPrefix.startsWith(`${args.orchestration}\\`)) fail("aggregate output must be outside the sealed orchestration directory");
const orchestration = verifyOrchestration(args.orchestration);
if (args.pairs.length && JSON.stringify(args.pairs) !== JSON.stringify(orchestration.outputs)) fail("explicit --pair inputs do not exactly match the sealed orchestration order");
const pairInputs = args.pairs.length ? args.pairs : orchestration.outputs;
const entries = pairInputs.map(readPair);
const pairIds = entries.map((entry) => entry.pair.pair_id);
if (new Set(pairIds).size !== pairIds.length) fail("pair IDs must be unique");
const archiveShas = new Set(entries.map((entry) => entry.pair.canonical_database_archive_sha256));
const manifestShas = new Set(entries.map((entry) => entry.current.immutable_binding.manifest_sha256));
if (archiveShas.size !== 1 || manifestShas.size !== 1) fail("pairs do not share one canonical database/correctness manifest");
const shapes = entries.flatMap((entry) => [entry.current, entry.baseline]).map((run) => JSON.stringify({
  parameters: run.context.parameters,
  cold: Object.fromEntries(Object.entries(run.phases.cold).map(([route, value]) => [route, value.samples])),
  warm: Object.fromEntries(Object.entries(run.phases.warm).map(([route, value]) => [route, value.samples])),
  idle_cycles: run.phases.idle.cycles.length,
  idle_followup_samples: run.phases.idle.cycles.map((cycle) => cycle.followup.samples),
  concurrency: run.concurrency.concurrency,
  duration_s: run.concurrency.requested_duration_s,
  timeout_ms: run.concurrency.request_timeout_ms,
  environment_identity: run.environment_identity,
}));
if (new Set(shapes).size !== 1) fail("measurement parameters/sample shapes differ across sides or pairs");
const observations = entries.map(pairObservation);
const cpuReductions = observations.map((pair) => pair.about_warm_cpu.reduction_percent);
const currentWarmMedians = observations.map((pair) => pair.about_warm_latency.current_median_ms);
const currentWarmP95s = observations.map((pair) => pair.about_warm_latency.current_p95_ms);
const orders = Object.fromEntries(["current-baseline", "baseline-current"].map((order) => [order, observations.filter((pair) => pair.order === order).length]));
const sufficient = observations.length >= 4;
const counterbalanced = orders["current-baseline"] > 0 && orders["current-baseline"] === orders["baseline-current"];
const medianReduction = median(cpuReductions);
const report = {
  schema_version: 2,
  generated_at: new Date().toISOString(),
  label: args.label ?? `phase-2 ${observations.length}-pair evidence report`,
  status: sufficient && counterbalanced ? "OWNER_REVIEW_REQUIRED" : "PRELIMINARY_ONLY",
  preliminary_non_decisional: !(sufficient && counterbalanced),
  autonomous_progression_authorised: false,
  owner_thresholds_verbatim: OWNER_THRESHOLDS_VERBATIM,
  integrity: {
    orchestration_directory: args.orchestration,
    orchestration_output_manifest_verified: true,
    completed_pairs: observations.length,
    required_pairs: 4,
    sufficient_pairs: sufficient,
    pair_ids_unique: true,
    order_counts: orders,
    counterbalanced,
    common_correctness_manifest_sha256: [...manifestShas][0],
    common_canonical_database_archive_sha256: [...archiveShas][0],
    outputs_checksum_verified: true,
    database_before_after_equal: true,
  },
  observations: {
    about_warm_cpu: {
      pair_reductions_percent: cpuReductions,
      median_reduction_percent: medianReduction,
      min_reduction_percent: Math.min(...cpuReductions),
      max_reduction_percent: Math.max(...cpuReductions),
      preferred_at_least_80_reference_met: medianReduction >= 80,
      below_roughly_50_stop_signal: medianReduction < 50,
      interpretation: "OWNER_REVIEW_REQUIRED",
    },
    current_about_warm_ttfb_ms: {
      pair_medians: currentWarmMedians,
      pair_p95s: currentWarmP95s,
      median_of_pair_medians: median(currentWarmMedians),
      median_of_pair_p95s: median(currentWarmP95s),
      approximately_300_ms_guidance_interpretation: "OWNER_REVIEW_REQUIRED",
      binding_p95_gate: null,
    },
    repeatability: {
      cpu_reduction_range_percentage_points: round(Math.max(...cpuReductions) - Math.min(...cpuReductions)),
      pair_results: cpuReductions,
      interpretation: "OWNER_REVIEW_REQUIRED",
    },
    relative_latency: observations.map((pair) => ({ pair_id: pair.pair_id, ...pair.about_warm_latency })),
    idle_recovery: observations.map((pair) => ({ pair_id: pair.pair_id, ...pair.idle })),
    revalidation: observations.map((pair) => ({ pair_id: pair.pair_id, ...pair.revalidation })),
    control_drift: observations.map((pair) => ({ pair_id: pair.pair_id, controls: pair.controls })),
    cache_proofs: observations.map((pair) => ({ pair_id: pair.pair_id, ...pair.cache })),
    memory_throttling_restarts_logs: observations.map((pair) => ({ pair_id: pair.pair_id, ...pair.memory_and_churn })),
    concurrency: observations.map((pair) => ({ pair_id: pair.pair_id, ...pair.concurrency })),
  },
  pairs: observations,
  required_owner_judgments: [
    "repeatability", "relative latency improvement", "idle stability", "dynamic-control drift",
    "cache/revalidation behaviour", "memory and regeneration churn", "restart/log noise", "concurrency behaviour",
  ],
};
const md = [
  `# ${report.label}`,
  "",
  `**Status: ${report.status}. Autonomous progression is not authorised.**`,
  "",
  ...(report.preliminary_non_decisional ? ["> Preliminary/non-decisional: the final harness run requires at least four evenly counterbalanced pairs (the owner threshold remains at least three).", ""] : []),
  "## Owner thresholds (verbatim)", "", ...OWNER_THRESHOLDS_VERBATIM.map((line) => `- ${line}`), "",
  "## Integrity", "",
  `- Pairs: ${observations.length}/4 harness minimum; pair IDs unique; order C-B=${orders["current-baseline"]}, B-C=${orders["baseline-current"]}.`,
  `- Output checksums, completion markers, correctness binding, and DB before/after fingerprints verified.`, "",
  "## Observations requiring owner review", "",
  `- Warm /about CPU reduction by pair: ${cpuReductions.join("%, ")}% (median ${medianReduction}%).`,
  `- Current warm /about TTFB pair medians: ${currentWarmMedians.join(", ")} ms; p95s: ${currentWarmP95s.join(", ")} ms. No autonomous p95 gate is applied.`,
  `- CPU below-roughly-50 stop signal: ${report.observations.about_warm_cpu.below_roughly_50_stop_signal ? "TRIGGERED" : "not triggered"}; qualitative interpretation remains OWNER_REVIEW_REQUIRED.`,
  `- Review the JSON for paired relative latency, idle/revalidation, controls, cache proofs, memory/throttling/restarts/logs, errors, and concurrency.`, "",
  "## Pair table", "", "| Pair | Order | CPU current / baseline | Reduction | Current warm TTFB median / p95 | Idle current / baseline | Concurrency RPS current / baseline |", "|---|---|---:|---:|---:|---:|---:|",
  ...observations.map((pair) => `| ${pair.pair_id} | ${pair.order} | ${pair.about_warm_cpu.current_ms_per_request} / ${pair.about_warm_cpu.baseline_ms_per_request} ms/req | ${pair.about_warm_cpu.reduction_percent}% | ${pair.about_warm_latency.current_median_ms} / ${pair.about_warm_latency.current_p95_ms} ms | ${pair.idle.current_first_request_median_ms} / ${pair.idle.baseline_first_request_median_ms} ms | ${pair.concurrency.current_rps} / ${pair.concurrency.baseline_rps} |`),
  "", "Absolute Windows/WSL results are relative comparison evidence only, not exact Tokoroa capacity.", "",
].join("\n");
mkdirSync(dirname(args.outPrefix), { recursive: true });
writeFileSync(`${args.outPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(`${args.outPrefix}.md`, md, "utf8");
console.log(`wrote ${args.outPrefix}.json and ${args.outPrefix}.md`);
console.log(`status: ${report.status}`);
