// Evidence-only aggregation for completed phase-2 pair directories. It never
// autonomously authorises progression: qualitative thresholds remain owner
// judgments, and fewer than four evenly counterbalanced pairs is PRELIMINARY_ONLY.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { conventionalMedian } from "./statistics.mjs";
import { PROFILE_FINAL, classifyOrchestrationProfile, classifySideProfile, requireKnownProfile } from "./measurement-profile.mjs";
import { isFuturePathInside, isPathInside, verifySealedTree } from "./sealed-tree.mjs";
import { verifySecretScan } from "./scan-evidence-secrets.mjs";

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
  return round(conventionalMedian(values));
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
  const sealed = verifySealedTree(root, { manifestName: "set-output-manifest.sha256", completionName: "PAIR-COMPLETED.json" });
  const completion = sealed.completion;
  if (completion.kind !== "measurement-pair-set" || hash(pairsPath) !== completion.pairs_manifest_sha256 || completion.pair_count < 4 || completion.pair_count % 2 !== 0) fail(`orchestration completion/set shape failed: ${root}`);
  requireKnownProfile(completion.measurement_profile);
  const derivedProfile = classifyOrchestrationProfile(completion.orchestration_profile);
  if (completion.final_profile_exact !== (completion.measurement_profile === PROFILE_FINAL && derivedProfile === PROFILE_FINAL) || (completion.measurement_profile === PROFILE_FINAL && derivedProfile !== PROFILE_FINAL)) fail(`orchestration final-profile attestation is invalid: ${root}`);
  verifySecretScan({ root, report: json(resolve(root, "secret-scan.json")), allowedLaterFiles: ["set-output-manifest.sha256", "PAIR-COMPLETED.json"] });
  const cb = completion.orders.filter((order) => order === "current-baseline").length;
  const bc = completion.orders.filter((order) => order === "baseline-current").length;
  if (cb !== bc || cb + bc !== completion.pair_count) fail(`orchestration order is not evenly counterbalanced: ${root}`);
  const pairs = readFileSync(pairsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (pairs.length !== completion.pair_count || pairs.some((pair) => pair.status !== "COMPLETE")) fail(`orchestration pair records are incomplete: ${root}`);
  let previous;
  for (const [index, pair] of pairs.entries()) {
    for (const field of ["wrapper_invoked_at_utc", "wrapper_returned_at_utc", "pair_started_at_utc", "pair_ended_at_utc"]) {
      if (!Number.isFinite(Date.parse(pair[field]))) fail(`invalid orchestration chronology field ${field} for pair ${index + 1}`);
    }
    const invoked = Date.parse(pair.wrapper_invoked_at_utc);
    const returned = Date.parse(pair.wrapper_returned_at_utc);
    const started = Date.parse(pair.pair_started_at_utc);
    const ended = Date.parse(pair.pair_ended_at_utc);
    if (!(invoked <= started && started <= ended && ended <= returned)) fail(`pair ${index + 1} chronology is not nested inside its wrapper interval`);
    if (!Number.isInteger(pair.inter_pair_gap_seconds) || pair.inter_pair_gap_seconds < 0 || pair.inter_pair_gap_seconds > completion.orchestration_profile.maximum_inter_pair_gap_seconds) fail(`pair ${index + 1} inter-pair gap is invalid`);
    if (previous) {
      if (invoked < previous.returned || started < previous.ended) fail(`pair ${index + 1} overlaps the previous pair`);
      const observedGapSeconds = Math.floor((invoked - previous.returned) / 1000);
      if (Math.abs(observedGapSeconds - pair.inter_pair_gap_seconds) > 1) fail(`pair ${index + 1} recorded inter-pair gap does not match timestamps`);
    } else if (pair.inter_pair_gap_seconds !== 0) fail("first pair inter-pair gap must be zero");
    previous = { returned, ended };
  }
  const outputs = pairs.map((pair) => resolve(pair.pair_output));
  if (JSON.stringify(outputs) !== JSON.stringify(completion.pair_outputs.map((value) => resolve(value)))) fail(`orchestration pair output binding mismatch: ${root}`);
  if (outputs.some((output) => !isPathInside(root, output))) fail(`orchestration pair output escapes the exact sealed set: ${root}`);
  const monitor = json(resolve(root, "quiet-host", "monitor-summary.json"));
  if (!monitor.passed || monitor.exit_status !== 0 || monitor.sample_count < 2 || monitor.interval_seconds !== completion.orchestration_profile.quiet_monitor_interval_seconds) fail(`continuous monitor completion differs from the sealed profile: ${root}`);
  if (Date.parse(monitor.first_sample_at_utc) > Date.parse(pairs[0].wrapper_invoked_at_utc) || Date.parse(monitor.last_sample_at_utc) + monitor.interval_seconds * 2000 < Date.parse(pairs.at(-1).wrapper_returned_at_utc)) fail(`continuous monitor timestamps do not cover the pair set: ${root}`);
  const evaluations = [];
  const visit = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = resolve(dir, entry.name); if (entry.isDirectory()) visit(path); else if (entry.name === "evaluation.json") evaluations.push(json(path)); } };
  visit(resolve(root, "quiet-host"));
  const expectedAllowed = completion.orchestration_profile.allowed_running_containers;
  if (!evaluations.length || evaluations.some((evaluation) => !evaluation.passed || JSON.stringify(evaluation.allowed_running_containers) !== JSON.stringify(expectedAllowed))) fail(`quiet-host container allowlist evidence differs from the sealed profile: ${root}`);
  return { completion, outputs, pairs };
}
function verifyCompleted(root) {
  return verifySealedTree(root).completion;
}
function readPair(root) {
  verifyCompleted(root);
  const pair = json(resolve(root, "pair.json"));
  if (pair.schema_version !== 2 || pair.status !== "COMPLETE" || !pair.quiet_host_attested) fail(`invalid pair metadata: ${root}`);
  requireKnownProfile(pair.measurement_profile);
  if (pair.measurement_profile === PROFILE_FINAL && pair.maximum_inter_side_gap_seconds !== 600) fail(`final-decision pair has a non-exact side gap: ${root}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(pair.pair_id ?? "")) fail(`invalid pair id: ${root}`);
  if (![["current", "baseline"], ["baseline", "current"]].some((order) => JSON.stringify(order) === JSON.stringify(pair.sides.map((side) => side.side)))) fail(`invalid side order: ${root}`);
  if (pair.order !== pair.sides.map((side) => side.side).join("-")) fail(`declared order mismatch: ${root}`);
  for (const [index, side] of pair.sides.entries()) {
    if (side.sequence !== index + 1 || !Number.isFinite(Date.parse(side.restore_started_at)) || !Number.isFinite(Date.parse(side.started_at)) || !Number.isFinite(Date.parse(side.ended_at))) fail(`invalid side timestamps: ${root}`);
    if (Date.parse(side.ended_at) < Date.parse(side.started_at)) fail(`side ended before it started: ${root}`);
    if (side.gap_from_previous_seconds > pair.maximum_inter_side_gap_seconds) fail(`maximum pair gap exceeded: ${root}`);
    if (side.database_fingerprint_before !== side.database_fingerprint_after) fail(`database drift in ${side.side}: ${root}`);
    if (!/^[a-f0-9]{64}$/.test(side.environment_hmac_sha256 ?? "") || !/^[a-f0-9]{64}$/.test(side.runtime_identity_after_finalization_sha256 ?? "")) fail(`side environment/runtime finalization binding is invalid: ${root}`);
    if (Date.parse(side.restore_started_at) < Date.parse(pair.started_at) || Date.parse(side.started_at) < Date.parse(side.restore_started_at) || Date.parse(side.ended_at) > Date.parse(pair.ended_at)) fail(`side chronology falls outside pair bounds: ${root}`);
    if (index > 0) {
      const previousSide = pair.sides[index - 1];
      if (Date.parse(side.restore_started_at) < Date.parse(previousSide.ended_at) || Date.parse(side.started_at) < Date.parse(previousSide.ended_at)) fail(`pair sides overlap: ${root}`);
      const observedGap = Math.floor((Date.parse(side.started_at) - Date.parse(previousSide.ended_at)) / 1000);
      if (Math.abs(observedGap - side.gap_from_previous_seconds) > 1) fail(`inter-side gap does not match timestamps: ${root}`);
    } else if (side.gap_from_previous_seconds !== 0) fail(`first side gap must be zero: ${root}`);
  }
  const derive = (side) => {
    try {
      return JSON.parse(execFileSync(process.execPath, [resolve("measurement/phase2/bin/summarise.mjs"), "--verify-json", resolve(root, side)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    } catch (error) {
      fail(`sealed raw evidence revalidation failed for ${side} in ${root}: ${error.stderr?.toString().trim() || error.message}`);
    }
  };
  const current = derive("current");
  const baseline = derive("baseline");
  verifyCompleted(resolve(root, "current"));
  verifyCompleted(resolve(root, "baseline"));
  for (const [name, run] of [["current", current], ["baseline", baseline]]) {
    if (run.schema_version !== 2 || run.context.side !== name || run.context.pair_id !== pair.pair_id || run.context.order !== pair.order) fail(`run context mismatch for ${name}: ${root}`);
    if (run.immutable_binding.correctness_result !== "passed") fail(`correctness was not passed for ${name}: ${root}`);
    if (!run.cache_proofs?.all_verified || run.evidence_totals.restart_delta !== 0 || run.evidence_totals.oom_delta !== 0 || run.evidence_totals.oom_kill_delta !== 0) fail(`integrity evidence failed for ${name}: ${root}`);
    if (run.concurrency.errors !== 0 || Object.keys(run.concurrency.statuses).some((status) => status !== "200")) fail(`load errors in ${name}: ${root}`);
    if (run.immutable_binding.canonical_database_archive_sha256 !== pair.canonical_database_archive_sha256) fail(`database archive binding mismatch: ${root}`);
    if (run.context.measurement_profile !== pair.measurement_profile || (pair.measurement_profile === PROFILE_FINAL && classifySideProfile(run.context.parameters) !== PROFILE_FINAL)) fail(`measurement profile differs for ${name}: ${root}`);
    if (run.environment_identity.app_environment_audit.keyed_fingerprint_sha256 !== pair.sides.find((side) => side.side === name).environment_hmac_sha256) fail(`environment HMAC binding mismatch for ${name}: ${root}`);
  }
  if (pair.sides[0].environment_hmac_sha256 !== pair.sides[1].environment_hmac_sha256) fail(`sides do not share the exact sanitized runtime environment HMAC: ${root}`);
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
if (isFuturePathInside(args.orchestration, args.outPrefix)) fail("aggregate output must be outside the real/case-folded sealed orchestration directory");
const orchestration = verifyOrchestration(args.orchestration);
if (args.pairs.length && JSON.stringify(args.pairs) !== JSON.stringify(orchestration.outputs)) fail("explicit --pair inputs do not exactly match the sealed orchestration order");
const pairInputs = args.pairs.length ? args.pairs : orchestration.outputs;
const entries = pairInputs.map(readPair);
for (const [index, entry] of entries.entries()) {
  const record = orchestration.pairs[index];
  if (record.pair_id !== entry.pair.pair_id || record.order !== entry.pair.order || Date.parse(record.pair_started_at_utc) !== Date.parse(entry.pair.started_at) || Date.parse(record.pair_ended_at_utc) !== Date.parse(entry.pair.ended_at)) fail(`orchestration record does not match sealed pair ${index + 1}`);
  if (record.canonical_database_fingerprint && record.canonical_database_fingerprint !== entry.pair.sides[0].database_fingerprint_before) fail(`orchestration database fingerprint does not match pair ${index + 1}`);
}
const pairIds = entries.map((entry) => entry.pair.pair_id);
if (new Set(pairIds).size !== pairIds.length) fail("pair IDs must be unique");
const archiveShas = new Set(entries.map((entry) => entry.pair.canonical_database_archive_sha256));
const manifestShas = new Set(entries.map((entry) => entry.current.immutable_binding.manifest_sha256));
if (archiveShas.size !== 1 || manifestShas.size !== 1) fail("pairs do not share one canonical database/correctness manifest");
const databaseFingerprints = new Set(entries.flatMap((entry) => entry.pair.sides.map((side) => side.database_fingerprint_before)));
if (databaseFingerprints.size !== 1) fail("pairs do not share one canonical logical database fingerprint");
const harnessManifestShas = new Set(entries.flatMap((entry) => [entry.current.environment_identity.harness_manifest_sha256, entry.baseline.environment_identity.harness_manifest_sha256]));
if (harnessManifestShas.size !== 1) fail("harness manifest differs across sides or pairs");
const environmentHmacs = new Set(entries.flatMap((entry) => entry.pair.sides.map((side) => side.environment_hmac_sha256)));
if (environmentHmacs.size !== 1) fail("sanitized runtime environment differs across sides or pairs");
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
const finalProfileExact = orchestration.completion.measurement_profile === PROFILE_FINAL && orchestration.completion.final_profile_exact && entries.every((entry) => entry.pair.measurement_profile === PROFILE_FINAL && classifySideProfile(entry.current.context.parameters) === PROFILE_FINAL && classifySideProfile(entry.baseline.context.parameters) === PROFILE_FINAL);
const sufficient = finalProfileExact && observations.length === 4;
const counterbalanced = orders["current-baseline"] > 0 && orders["current-baseline"] === orders["baseline-current"];
const medianReduction = median(cpuReductions);
const performanceSignal = medianReduction < 50
  ? "STOP_CPU_REDUCTION_BELOW_50_PERCENT_NUMERIC_REFERENCE"
  : medianReduction < 80
    ? "OWNER_REVIEW_REQUIRED_50_TO_80_PERCENT"
    : "PREFERRED_CPU_REFERENCE_MET_OWNER_REVIEW_STILL_REQUIRED";
const report = {
  schema_version: 2,
  generated_at: new Date().toISOString(),
  label: args.label ?? `phase-2 ${observations.length}-pair evidence report`,
  status: sufficient && counterbalanced ? "OWNER_REVIEW_REQUIRED" : "PRELIMINARY_ONLY",
  preliminary_non_decisional: !(sufficient && counterbalanced),
  autonomous_progression_authorised: false,
  methodology: { cross_pair_median: "conventional median; even pair counts average the two middle values", single_side_p95: "sorted[floor(0.95*n)], capped at n-1" },
  performance_signal: performanceSignal,
  owner_thresholds_verbatim: OWNER_THRESHOLDS_VERBATIM,
  integrity: {
    orchestration_directory: args.orchestration,
    orchestration_output_manifest_verified: true,
    completed_pairs: observations.length,
    required_pairs: 4,
    sufficient_pairs: sufficient,
    measurement_profile: orchestration.completion.measurement_profile,
    final_profile_exact: finalProfileExact,
    exact_orchestration_profile: orchestration.completion.orchestration_profile,
    exact_side_parameters: entries[0].current.context.parameters,
    pair_ids_unique: true,
    order_counts: orders,
    counterbalanced,
    common_correctness_manifest_sha256: [...manifestShas][0],
    common_canonical_database_archive_sha256: [...archiveShas][0],
    common_canonical_database_fingerprint: [...databaseFingerprints][0],
    common_harness_manifest_sha256: [...harnessManifestShas][0],
    common_runtime_environment_hmac_sha256: [...environmentHmacs][0],
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
      pair_stop_signals: observations.map((pair) => ({ pair_id: pair.pair_id, triggered: pair.about_warm_cpu.reduction_percent < 50 })),
      classification: performanceSignal,
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
  ...(report.preliminary_non_decisional ? [`> Preliminary/non-decisional: profile=${orchestration.completion.measurement_profile}; only the exact reviewed final-decision profile with exactly four evenly counterbalanced pairs can reach owner review.`, ""] : []),
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
const jsonPath = `${args.outPrefix}.json`;
const markdownPath = `${args.outPrefix}.md`;
const outputManifestPath = `${args.outPrefix}.output-manifest.sha256`;
const completionPath = `${args.outPrefix}.COMPLETED.json`;
for (const path of [jsonPath, markdownPath, outputManifestPath, completionPath]) if (existsSync(path)) fail(`refusing aggregate output collision: ${path}`);
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
writeFileSync(markdownPath, md, { encoding: "utf8", flag: "wx" });
const outputRecords = [jsonPath, markdownPath].map((path) => ({ path, bytes: statSync(path).size, sha256: hash(path) }));
writeFileSync(outputManifestPath, `${outputRecords.map((record) => `${record.sha256}  ${record.bytes}  ${record.path}`).join("\n")}\n`, { encoding: "utf8", flag: "wx" });
writeFileSync(completionPath, `${JSON.stringify({ schema_version: 2, status: "COMPLETE", completed_at: new Date().toISOString(), measurement_profile: orchestration.completion.measurement_profile, final_profile_exact: finalProfileExact, orchestration_output_manifest_sha256: orchestration.completion.output_manifest_sha256, aggregate_output_manifest_sha256: hash(outputManifestPath), aggregate_files: outputRecords, artifact_count: outputRecords.length }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(`wrote ${jsonPath}, ${markdownPath}, and checksummed completion evidence`);
console.log(`status: ${report.status}`);
