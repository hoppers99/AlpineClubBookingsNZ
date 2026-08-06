// Dependency-free, infrastructure-free contract tests for orchestrate-pairs.sh.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "orchestrate-pairs.sh");
const source = readFileSync(script, "utf8");
const pairRunnerSource = readFileSync(resolve(here, "run-pair.sh"), "utf8");
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
  /set-output-manifest\.sha256/,
  /set_output_manifest_sha256/,
  /set_output_artifact_count/,
  /PAIR-COMPLETED\.json/,
  /flag: "wx"/,
]) {
  assert.match(source, requiredContract);
}
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

const completionWrite = source.indexOf('node - "$OUTPUT_ROOT/PAIR-COMPLETED.json"');
const completedPairsGuard = source.indexOf('[[ "$completed_pairs" -eq "$PAIR_COUNT" ]]');
assert(completedPairsGuard >= 0 && completionWrite > completedPairsGuard,
  "set completion marker must be written only after the all-pairs guard");
const teeWait = source.indexOf('wait "$TEE_PID"');
const setManifestWrite = source.indexOf('SET_OUTPUT_MANIFEST="$OUTPUT_ROOT/set-output-manifest.sha256"');
assert(teeWait >= 0 && setManifestWrite > teeWait && completionWrite > setManifestWrite,
  "logging must close before the set manifest, which must precede completion");

console.log("orchestrate-pairs self-test: PASS");
