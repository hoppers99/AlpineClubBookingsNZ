import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FINAL_ORCHESTRATION_PROFILE, PROFILE_FINAL, PROFILE_NONFINAL, classifyOrchestrationProfile, requireKnownProfile } from "./measurement-profile.mjs";
import { finalizeSealedTree, isPathInside, verifySealedTree } from "./sealed-tree.mjs";
import { validatePhase2Correctness } from "./correctness-contract.mjs";

const fail = (message) => { throw new Error(message); };
const args = Object.fromEntries(process.argv.slice(2).reduce((result, value, index, all) => index % 2 === 0 ? [...result, [value.replace(/^--/, ""), all[index + 1]]] : result, []));
for (const name of ["dir", "output-id", "pairs", "correctness-manifest-sha256", "harness-source-binding-sha256", "profile", "pair-count", "max-side-gap", "max-pair-gap", "monitor-interval", "pair-quiet-cpu-limit", "pair-quiet-samples", "allowed-containers"]) if (!args[name]) fail(`--${name} is required`);
const root = resolve(args.dir);
const pairsPath = resolve(args.pairs);
const pairs = readFileSync(pairsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const pairCount = Number(args["pair-count"]);
if (!/^[a-f0-9]{64}$/.test(args["correctness-manifest-sha256"]) || !/^[a-f0-9]{64}$/.test(args["harness-source-binding-sha256"])) fail("pair-set source binding hashes are invalid");
if (!Number.isInteger(pairCount) || pairs.length !== pairCount || pairs.some((pair) => pair.status !== "COMPLETE" || pair.phase2_checks_passed !== true || pair.sides?.some((side) => side.phase2_checks_passed !== true))) fail("cannot complete a partial pair set or one with incomplete phase2 correctness");
for (const record of pairs) {
  const pairRoot = resolve(record.pair_output);
  if (!isPathInside(root, pairRoot)) fail(`pair output escapes the orchestration root: ${record.pair_id}`);
  const pairCompletion = verifySealedTree(pairRoot).completion;
  const pair = JSON.parse(readFileSync(join(pairRoot, "pair.json"), "utf8"));
  if (pairCompletion.side !== "pair" || pairCompletion.pair_id !== record.pair_id || pair.status !== "COMPLETE" || pair.phase2_checks_passed !== true || pair.pair_id !== record.pair_id || pair.order !== record.order || JSON.stringify(pair.sides) !== JSON.stringify(record.sides)) fail(`sealed pair differs from the orchestration record: ${record.pair_id}`);
  for (const side of pair.sides) {
    verifySealedTree(join(pairRoot, side.side));
    const summary = JSON.parse(readFileSync(join(pairRoot, side.side, "summary.json"), "utf8"));
    validatePhase2Correctness(summary.phase2_correctness, side.side);
  }
}
const profile = requireKnownProfile(args.profile);
const orchestrationProfile = {
  pair_count: pairCount,
  maximum_inter_side_gap_seconds: Number(args["max-side-gap"]),
  maximum_inter_pair_gap_seconds: Number(args["max-pair-gap"]),
  quiet_monitor_interval_seconds: Number(args["monitor-interval"]),
  pair_quiet_cpu_limit_percent: Number(args["pair-quiet-cpu-limit"]),
  pair_quiet_samples: Number(args["pair-quiet-samples"]),
  allowed_running_containers: args["allowed-containers"].split(",").sort(),
};
const derived = classifyOrchestrationProfile(orchestrationProfile);
if (profile === PROFILE_FINAL && derived !== PROFILE_FINAL) fail("final-decision pair-set profile differs from the exact reviewed profile");
if (profile === PROFILE_NONFINAL && ![PROFILE_FINAL, PROFILE_NONFINAL].includes(derived)) fail("invalid nonfinal pair-set profile");
const completionFields = {
  kind: "measurement-pair-set",
  output_id: args["output-id"],
  completed_at_utc: new Date().toISOString(),
  measurement_profile: profile,
  final_profile_exact: profile === PROFILE_FINAL && derived === PROFILE_FINAL,
  orchestration_profile: orchestrationProfile,
  pair_count: pairs.length,
  phase2_checks_passed: true,
  orders: pairs.map((pair) => pair.order),
  correctness_manifest_sha256: args["correctness-manifest-sha256"],
  harness_source_binding_sha256: args["harness-source-binding-sha256"],
  pairs_manifest_sha256: createHash("sha256").update(readFileSync(pairsPath)).digest("hex"),
  pair_outputs: pairs.map((pair) => resolve(pair.pair_output)),
};
const sealed = finalizeSealedTree({ root, manifestName: "set-output-manifest.sha256", completionName: "PAIR-COMPLETED.json", completionFields });
console.log(JSON.stringify(sealed.completion));
