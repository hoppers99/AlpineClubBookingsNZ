// Dependency-free, infrastructure-free contract tests for orchestrate-pairs.sh.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "orchestrate-pairs.sh");
const source = readFileSync(script, "utf8");
const pairRunnerSource = readFileSync(resolve(here, "run-pair.sh"), "utf8");
const setFinalizerSource = readFileSync(resolve(here, "finalize-pair-set.mjs"), "utf8");
const sealedTreeSource = readFileSync(resolve(here, "sealed-tree.mjs"), "utf8");
const gitBash = process.env.PHASE2_GIT_BASH ?? [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  resolve(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
].find(existsSync);
assert.ok(gitBash, "Git Bash is required for the orchestration contract self-test");

function plan(count) {
  const result = spawnSync(gitBash, ["./orchestrate-pairs.sh", "--plan-only", "--pair-count", String(count)], {
    cwd: here,
    encoding: "utf8",
    env: { ...process.env },
  });
  return result;
}

const four = plan(4);
assert.equal(four.status, 0);
assert.equal(four.stdout, "1\tcurrent-baseline\n2\tbaseline-current\n3\tcurrent-baseline\n4\tbaseline-current\n");
assert.equal(four.stderr, "");

const six = plan(6);
assert.equal(six.status, 0);
const sixOrders = six.stdout.trim().split(/\r?\n/).map((line) => line.split("\t")[1]);
assert.deepEqual(sixOrders, [
  "current-baseline",
  "baseline-current",
  "current-baseline",
  "baseline-current",
  "current-baseline",
  "baseline-current",
]);
assert.equal(sixOrders.filter((order) => order === "current-baseline").length, 3);
assert.equal(sixOrders.filter((order) => order === "baseline-current").length, 3);

for (const invalid of [1, 2, 3, 5, 7]) {
  const result = plan(invalid);
  assert.notEqual(result.status, 0, `pair count ${invalid} must fail closed`);
  assert.match(result.stderr, /underpowered or unbalanced/);
}
const forbiddenHook = spawnSync(gitBash, ["./orchestrate-pairs.sh", "--plan-only", "--restore-hook", "fixture"], { cwd: here, encoding: "utf8", env: { ...process.env } });
assert.notEqual(forbiddenHook.status, 0);
assert.match(forbiddenHook.stderr, /hooks are prohibited for final decision evidence/);

for (const requiredContract of [
  /mkdir "\$OUTPUT_ROOT"/,
  /run-pair\.sh/,
  /--pair-id "\$pair_id"/,
  /--order "\$order"/,
  /--manifest "\$MANIFEST_SNAPSHOT"/,
  /--harness-manifest "\$HARNESS_MANIFEST"/,
  /--harness-manifest-sha256 "\$HARNESS_MANIFEST_SHA256"/,
  /--current-image "\$CURRENT_IMAGE_REFERENCE"/,
  /--baseline-image "\$BASELINE_IMAGE_REFERENCE"/,
  /--canonical-archive "\$CANONICAL_DATABASE_ARCHIVE_PATH"/,
  /--canonical-sha256 "\$CANONICAL_DATABASE_ARCHIVE_SHA256"/,
  /--max-gap-seconds "\$MAX_INTER_SIDE_GAP_SECONDS"/,
  /--output-root "\$pair_root"/,
  /integration contract is incomplete/,
  /restore\/fingerprint hooks are prohibited for final decision evidence/,
  /tacbookings-measure-phase2\.lock/,
  /token=%s/,
  /cygpath -am "\$harness_file"/,
  /verify-harness-manifest\.mjs/,
  /tacbookings-measure-mailpit-1/,
  /CONTINUOUS_MAX_HOST_CPU_PERCENT:=40/,
  /MAX_INTER_PAIR_GAP_SECONDS/,
  /docker ps -a --no-trunc/,
  /docker stats --all --no-stream/,
  /windows-top-cpu\.csv/,
  /windows-top-memory\.csv/,
  /windows-disks\.csv/,
  /windows-power-state\.txt/,
  /wsl-system\.txt/,
  /unexpected_running_containers/,
  /CONTAMINATION\.tsv/,
  /canonical_database_fingerprint/,
  /finalize-pair-set\.mjs/,
  /scan-evidence-secrets\.mjs/,
]) {
  assert.match(source, requiredContract);
}
for (const finalizationContract of [/set-output-manifest\.sha256/, /PAIR-COMPLETED\.json/, /measurement-pair-set/, /final_profile_exact/, /orchestration_profile/, /pair_outputs/]) assert.match(setFinalizerSource, finalizationContract);
assert.match(sealedTreeSource, /flag: "wx"/);
assert.doesNotMatch(source, /pair complete:/,
  "the wrapper must not discover sealed output by parsing human-readable stdout");

for (const perPairContract of [
  /--current-image\) CURRENT_IMAGE=/,
  /--baseline-image\) BASELINE_IMAGE=/,
  /--canonical-archive\) CANONICAL_ARCHIVE=/,
  /--canonical-sha256\) CANONICAL_SHA256=/,
  /--output-root\) OUTPUT_ROOT=/,
  /--harness-manifest\) HARNESS_MANIFEST=/,
  /--harness-manifest-sha256\) HARNESS_MANIFEST_SHA256=/,
  /--restore-hook\) RESTORE_HOOK=/,
  /--fingerprint-hook\) PHASE2_FINGERPRINT_HOOK=/,
  /\[ ! -e "\$OUTPUT_ROOT" \]/,
  /PAIR_ROOT="\$OUTPUT_ROOT"/,
  /mkdir "\$PAIR_ROOT"/,
]) {
  assert.match(pairRunnerSource, perPairContract);
}
assert((pairRunnerSource.match(/\breverify_harness_source\b/g) ?? []).length >= 5,
  "pair runner must reverify archive-backed live harness source at start, after each side, and immediately before/after finalization");
assert.match(pairRunnerSource, /if ! reverify_harness_source; then\s+invalidate_pair_finalization/,
  "a post-finalizer source failure must invalidate the exact pair seal");
assert.match(pairRunnerSource, /rm -f -- "\$PAIR_ROOT\/output-manifest\.sha256" "\$PAIR_ROOT\/COMPLETED\.json" "\$PAIR_ROOT\.finalization\.json"/,
  "pair invalidation must remove only the exact derived seal files");
const postFinalizerMutationRoot = mkdtempSync(resolve(tmpdir(), "phase2-pair-post-finalizer-"));
const postFinalizerMutation = spawnSync(gitBash, ["-c", String.raw`set -euo pipefail
mkdir -p pair/raw
printf 'raw evidence\n' > pair/raw/evidence.txt
printf 'sealed manifest\n' > pair/output-manifest.sha256
printf '{"status":"COMPLETE"}\n' > pair/COMPLETED.json
printf '{"status":"COMPLETE"}\n' > pair.finalization.json
printf 'reviewed source\n' > live-source.mjs
sha256sum live-source.mjs > harness-files.sha256
printf 'post-finalizer tamper\n' > live-source.mjs
if sha256sum --check harness-files.sha256 >/dev/null 2>&1; then exit 9; fi
rm -f -- pair/output-manifest.sha256 pair/COMPLETED.json pair.finalization.json
test -f pair/raw/evidence.txt
test ! -e pair/output-manifest.sha256
test ! -e pair/COMPLETED.json
test ! -e pair.finalization.json
`], { cwd: postFinalizerMutationRoot, encoding: "utf8", env: { ...process.env } });
assert.equal(postFinalizerMutation.status, 0, postFinalizerMutation.stderr || "post-finalizer tamper must invalidate only the derived pair seal");
assert.match(pairRunnerSource, /sha256sum --check "\$HARNESS_MANIFEST"/,
  "pair runner must use an external frozen-manifest byte check before invoking mutable Node verifier code");
assert((source.match(/verify-harness-source\.mjs/g) ?? []).length >= 2,
  "orchestrator must verify archive-backed live harness source at start and immediately before/after set finalization");
assert((source.match(/\breverify_set_harness_source\b/g) ?? []).length >= 3,
  "orchestrator must call the same external-plus-semantic source verifier immediately before and after set finalization");
assert.match(source, /sha256sum --check "\$HARNESS_MANIFEST"/);
assert.match(source, /--harness-source-binding/);
assert.match(source, /if ! reverify_set_harness_source; then\s+invalidate_set_finalization/,
  "a post-finalizer source failure must invalidate the exact pair-set seal");
assert.match(source, /rm -f -- "\$OUTPUT_ROOT\/set-output-manifest\.sha256" "\$OUTPUT_ROOT\/PAIR-COMPLETED\.json"/,
  "pair-set invalidation must remove only the exact derived set seal files");
const postSetFinalizerMutationRoot = mkdtempSync(resolve(tmpdir(), "phase2-set-post-finalizer-"));
const postSetFinalizerMutation = spawnSync(gitBash, ["-c", String.raw`set -euo pipefail
mkdir -p set/pairs/pair-1
printf 'raw pair evidence\n' > set/pairs/pair-1/evidence.txt
printf 'sealed manifest\n' > set/set-output-manifest.sha256
printf '{"status":"COMPLETE"}\n' > set/PAIR-COMPLETED.json
printf 'reviewed source\n' > live-source.mjs
sha256sum live-source.mjs > harness-files.sha256
printf 'post-set-finalizer tamper\n' > live-source.mjs
if sha256sum --check harness-files.sha256 >/dev/null 2>&1; then exit 9; fi
rm -f -- set/set-output-manifest.sha256 set/PAIR-COMPLETED.json
test -f set/pairs/pair-1/evidence.txt
test ! -e set/set-output-manifest.sha256
test ! -e set/PAIR-COMPLETED.json
printf 'reviewed source\n' > live-source.mjs
sha256sum --check harness-files.sha256 >/dev/null
printf 'retry manifest\n' > set/set-output-manifest.sha256
printf '{"status":"COMPLETE"}\n' > set/PAIR-COMPLETED.json
test -f set/set-output-manifest.sha256
test -f set/PAIR-COMPLETED.json
`], { cwd: postSetFinalizerMutationRoot, encoding: "utf8", env: { ...process.env } });
assert.equal(postSetFinalizerMutation.status, 0, postSetFinalizerMutation.stderr || "post-set-finalizer tamper must invalidate only the derived set seal and permit retry");

const completionWrite = source.indexOf("finalize-pair-set.mjs");
const completedPairsGuard = source.indexOf('[[ "$completed_pairs" -eq "$PAIR_COUNT" ]]');
assert(completedPairsGuard >= 0 && completionWrite > completedPairsGuard,
  "set completion marker must be written only after the all-pairs guard");
const teeWait = source.indexOf('wait "$TEE_PID"');
const secretScanWrite = source.indexOf("scan-evidence-secrets.mjs");
assert(teeWait >= 0 && secretScanWrite > teeWait && completionWrite > secretScanWrite,
  "logging must close before the exact secret scan and set finalization");

console.log("orchestrate-pairs self-test: PASS");
