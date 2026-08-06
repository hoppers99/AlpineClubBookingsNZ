import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FINAL_ORCHESTRATION_PROFILE, PROFILE_FINAL, PROFILE_NONFINAL, classifyOrchestrationProfile, requireKnownProfile } from "./measurement-profile.mjs";
import { finalizeSealedTree } from "./sealed-tree.mjs";

const fail = (message) => { throw new Error(message); };
const args = Object.fromEntries(process.argv.slice(2).reduce((result, value, index, all) => index % 2 === 0 ? [...result, [value.replace(/^--/, ""), all[index + 1]]] : result, []));
for (const name of ["dir", "output-id", "pairs", "correctness-manifest-sha256", "profile", "pair-count", "max-side-gap", "max-pair-gap", "monitor-interval", "pair-quiet-cpu-limit", "pair-quiet-samples", "allowed-containers"]) if (!args[name]) fail(`--${name} is required`);
const root = resolve(args.dir);
const pairsPath = resolve(args.pairs);
const pairs = readFileSync(pairsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const pairCount = Number(args["pair-count"]);
if (!Number.isInteger(pairCount) || pairs.length !== pairCount || pairs.some((pair) => pair.status !== "COMPLETE")) fail("cannot complete a partial pair set");
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
  orders: pairs.map((pair) => pair.order),
  correctness_manifest_sha256: args["correctness-manifest-sha256"],
  pairs_manifest_sha256: createHash("sha256").update(readFileSync(pairsPath)).digest("hex"),
  pair_outputs: pairs.map((pair) => resolve(pair.pair_output)),
};
const sealed = finalizeSealedTree({ root, manifestName: "set-output-manifest.sha256", completionName: "PAIR-COMPLETED.json", completionFields });
console.log(JSON.stringify(sealed.completion));
