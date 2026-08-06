#!/usr/bin/env bash
# Orchestrates one contemporaneous, counterbalanced current/baseline pair.
set -euo pipefail
cd "$(dirname "$0")/../../.."
case "$(uname -s)" in MINGW*|MSYS*) ;; *) echo "run-pair requires the reviewed Git Bash on Windows environment" >&2; exit 2 ;; esac
[[ "$(node --version)" =~ ^v24\. ]] || { echo "run-pair requires repository Node 24" >&2; exit 2; }
winpath() { cygpath -am "$1"; }

usage() {
  echo "usage: QUIET_HOST_ATTESTED=YES run-pair.sh --pair-id <id> --order current-baseline|baseline-current --manifest <absolute-json> --harness-manifest <absolute-file> --harness-manifest-sha256 <sha256> --harness-source-binding <absolute-json> --harness-source-binding-sha256 <sha256> --current-image <reference> --baseline-image <reference> --canonical-archive <absolute-path> --canonical-sha256 <sha256> --output-root <absolute-new-directory> [--restore-hook <executable>] [--fingerprint-hook <executable>] [--max-gap-seconds 600]" >&2
  exit 1
}
PAIR_ID= PAIR_ORDER= CORRECTNESS_MANIFEST_SOURCE= HARNESS_MANIFEST= HARNESS_MANIFEST_SHA256= HARNESS_SOURCE_BINDING_SOURCE= HARNESS_SOURCE_BINDING_SHA256= CURRENT_IMAGE= BASELINE_IMAGE= CANONICAL_ARCHIVE= CANONICAL_SHA256= OUTPUT_ROOT= RESTORE_HOOK= PHASE2_FINGERPRINT_HOOK= MAX_GAP_SECONDS=600
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pair-id) PAIR_ID="${2:-}"; shift 2 ;;
    --order) PAIR_ORDER="${2:-}"; shift 2 ;;
    --manifest) CORRECTNESS_MANIFEST_SOURCE="${2:-}"; shift 2 ;;
    --harness-manifest) HARNESS_MANIFEST="${2:-}"; shift 2 ;;
    --harness-manifest-sha256) HARNESS_MANIFEST_SHA256="${2:-}"; shift 2 ;;
    --harness-source-binding) HARNESS_SOURCE_BINDING_SOURCE="${2:-}"; shift 2 ;;
    --harness-source-binding-sha256) HARNESS_SOURCE_BINDING_SHA256="${2:-}"; shift 2 ;;
    --current-image) CURRENT_IMAGE="${2:-}"; shift 2 ;;
    --baseline-image) BASELINE_IMAGE="${2:-}"; shift 2 ;;
    --canonical-archive) CANONICAL_ARCHIVE="${2:-}"; shift 2 ;;
    --canonical-sha256) CANONICAL_SHA256="${2:-}"; shift 2 ;;
    --output-root) OUTPUT_ROOT="${2:-}"; shift 2 ;;
    --restore-hook) RESTORE_HOOK="${2:-}"; shift 2 ;;
    --fingerprint-hook) PHASE2_FINGERPRINT_HOOK="${2:-}"; shift 2 ;;
    --max-gap-seconds) MAX_GAP_SECONDS="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$PAIR_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$ ]] || usage
case "$PAIR_ORDER" in current-baseline) SIDES=(current baseline) ;; baseline-current) SIDES=(baseline current) ;; *) usage ;; esac
[ "${QUIET_HOST_ATTESTED:-}" = YES ] || { echo "QUIET_HOST_ATTESTED=YES is required after the operator closes heavy host work" >&2; exit 1; }
: "${MEASUREMENT_PROFILE:?MEASUREMENT_PROFILE missing}"
: "${MEASURE_ENV_SNAPSHOT:?private measurement env snapshot missing}"
: "${MEASURE_ENV_SNAPSHOT_HMAC_SHA256:?private measurement env snapshot HMAC missing}"
: "${PHASE2_ENV_AUDIT_HMAC_KEY_FILE:?private runtime environment HMAC key missing}"
case "$MEASUREMENT_PROFILE" in final-decision|nonfinal-test) ;; *) usage ;; esac
[[ "$MAX_GAP_SECONDS" =~ ^[1-9][0-9]*$ ]] || usage
if [ "$MEASUREMENT_PROFILE" = final-decision ] && [ "$MAX_GAP_SECONDS" != 600 ]; then echo "final-decision inter-side gap must remain exactly 600 seconds" >&2; exit 2; fi
[ -f "$CORRECTNESS_MANIFEST_SOURCE" ] || { echo "correctness manifest missing: $CORRECTNESS_MANIFEST_SOURCE" >&2; exit 1; }
[ -f "$HARNESS_MANIFEST" ] || { echo "harness manifest missing: $HARNESS_MANIFEST" >&2; exit 1; }
[[ "$HARNESS_MANIFEST_SHA256" =~ ^[a-f0-9]{64}$ ]] || usage
[ "$(sha256sum "$HARNESS_MANIFEST" | awk '{print $1}')" = "$HARNESS_MANIFEST_SHA256" ] || { echo "harness manifest checksum mismatch" >&2; exit 1; }
sha256sum --check "$HARNESS_MANIFEST" >/dev/null
node measurement/phase2/bin/verify-harness-manifest.mjs "$(winpath "$HARNESS_MANIFEST")" >/dev/null
[ -f "$HARNESS_SOURCE_BINDING_SOURCE" ] || { echo "harness source binding missing: $HARNESS_SOURCE_BINDING_SOURCE" >&2; exit 1; }
[[ "$HARNESS_SOURCE_BINDING_SHA256" =~ ^[a-f0-9]{64}$ ]] || usage
[ "$(sha256sum "$HARNESS_SOURCE_BINDING_SOURCE" | awk '{print $1}')" = "$HARNESS_SOURCE_BINDING_SHA256" ] || { echo "harness source binding checksum mismatch" >&2; exit 1; }
[ -n "$CURRENT_IMAGE" ] && [ -n "$BASELINE_IMAGE" ] || usage
[ -f "$CANONICAL_ARCHIVE" ] || { echo "canonical archive missing: $CANONICAL_ARCHIVE" >&2; exit 1; }
[[ "$CANONICAL_SHA256" =~ ^[a-f0-9]{64}$ ]] || usage
case "$OUTPUT_ROOT" in /*|[A-Za-z]:/*) ;; *) echo "output root must be absolute: $OUTPUT_ROOT" >&2; exit 2 ;; esac
[ ! -e "$OUTPUT_ROOT" ] || { echo "refusing output collision: $OUTPUT_ROOT" >&2; exit 1; }
[ -d "$(dirname "$OUTPUT_ROOT")" ] || { echo "output-root parent must already exist: $(dirname "$OUTPUT_ROOT")" >&2; exit 1; }
[ -z "$RESTORE_HOOK" ] || [ -x "$RESTORE_HOOK" ] || { echo "restore hook is not executable: $RESTORE_HOOK" >&2; exit 1; }
[ -z "$PHASE2_FINGERPRINT_HOOK" ] || [ -x "$PHASE2_FINGERPRINT_HOOK" ] || { echo "fingerprint hook is not executable: $PHASE2_FINGERPRINT_HOOK" >&2; exit 1; }

PAIR_ROOT="$OUTPUT_ROOT"
mkdir "$PAIR_ROOT" || { echo "could not atomically claim output root: $PAIR_ROOT" >&2; exit 1; }
mkdir "$PAIR_ROOT/pair-evidence"
CORRECTNESS_MANIFEST="$PAIR_ROOT/pair-evidence/correctness-manifest.snapshot.json"
cp "$CORRECTNESS_MANIFEST_SOURCE" "$CORRECTNESS_MANIFEST"
HARNESS_SOURCE_BINDING="$PAIR_ROOT/pair-evidence/harness-source-binding.snapshot.json"
cp "$HARNESS_SOURCE_BINDING_SOURCE" "$HARNESS_SOURCE_BINDING"
exec 3>&1 4>&2
exec > >(tee "$PAIR_ROOT/pair-evidence/orchestrator.log" >&3) 2>&1
PAIR_TEE_PID=$!

QUIET_CPU_LIMIT_PERCENT="${QUIET_CPU_LIMIT_PERCENT:-20}"
QUIET_SAMPLES="${QUIET_SAMPLES:-5}"
[[ "$QUIET_CPU_LIMIT_PERCENT" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "invalid QUIET_CPU_LIMIT_PERCENT" >&2; exit 1; }
[[ "$QUIET_SAMPLES" =~ ^[1-9][0-9]*$ ]] || { echo "invalid QUIET_SAMPLES" >&2; exit 1; }
if [ "$MEASUREMENT_PROFILE" = final-decision ] && { [ "$QUIET_CPU_LIMIT_PERCENT" != 20 ] || [ "$QUIET_SAMPLES" != 5 ]; }; then echo "final-decision pair quiet controls must remain exactly 20 percent and 5 samples" >&2; exit 2; fi

quiet_check() {
  local label="$1" dir="$PAIR_ROOT/pair-evidence/quiet-$1"
  mkdir "$dir"
  date -u +%Y-%m-%dT%H:%M:%S.%NZ > "$dir/timestamp.txt"
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' > "$dir/docker-ps.tsv"
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.PIDs}}' > "$dir/docker-stats.csv"
  powershell.exe -NoProfile -Command 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 30 ProcessName,Id,CPU,WorkingSet64 | ConvertTo-Csv -NoTypeInformation' \
    | tr -d '\0\r' > "$dir/windows-processes.csv"
  : > "$dir/windows-cpu-percent.txt"
  for _ in $(seq 1 "$QUIET_SAMPLES"); do
    powershell.exe -NoProfile -Command '(Get-Counter "\Processor(_Total)\% Processor Time").CounterSamples.CookedValue' \
      | tr -d '\0\r ' | tail -n 1 >> "$dir/windows-cpu-percent.txt"
  done
  node - "$(winpath "$dir")" "$QUIET_CPU_LIMIT_PERCENT" <<'NODE'
const fs = require("node:fs");
const [dir, limitRaw] = process.argv.slice(2);
const limit = Number(limitRaw);
const names = fs.readFileSync(`${dir}/docker-ps.tsv`, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => line.split("\t")[0]);
const unexpected = names.filter((name) => !name.startsWith("tacbookings-measure-"));
if (unexpected.length) throw new Error(`unexpected running containers: ${unexpected.join(", ")}`);
const cpu = fs.readFileSync(`${dir}/windows-cpu-percent.txt`, "utf8").trim().split(/\r?\n/).filter(Boolean).map(Number);
if (cpu.length === 0 || cpu.some((value) => !Number.isFinite(value))) throw new Error("host CPU capture failed");
const max = Math.max(...cpu);
fs.writeFileSync(`${dir}/evaluation.json`, `${JSON.stringify({schema_version:1,samples:cpu,maximum_percent:max,limit_percent:limit,unexpected_containers:unexpected,passed:max<=limit},null,2)}\n`);
if (max > limit) throw new Error(`quiet-host CPU control failed: ${max}% > ${limit}%`);
NODE
  echo "quiet-host check $label passed"
}

read_manifest_field() {
  node -e 'const m=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],m); if(typeof v!=="string") process.exit(2); process.stdout.write(v)' \
    "$(winpath "$CORRECTNESS_MANIFEST")" "$1"
}
CURRENT_CORRECTNESS_COMPLETION="$(read_manifest_field sides.current.correctness_completion.path)"
BASELINE_CORRECTNESS_COMPLETION="$(read_manifest_field sides.baseline.correctness_completion.path)"
reverify_harness_source() {
  [ "$(sha256sum "$HARNESS_SOURCE_BINDING" | awk '{print $1}')" = "$HARNESS_SOURCE_BINDING_SHA256" ] || { echo "frozen harness source binding changed" >&2; return 1; }
  [ "$(sha256sum "$HARNESS_MANIFEST" | awk '{print $1}')" = "$HARNESS_MANIFEST_SHA256" ] || { echo "frozen harness manifest changed" >&2; return 1; }
  sha256sum --check "$HARNESS_MANIFEST" >/dev/null || return 1
  node measurement/phase2/bin/verify-harness-source.mjs \
    --harness-manifest "$(winpath "$HARNESS_MANIFEST")" \
    --current-completion "$(winpath "$CURRENT_CORRECTNESS_COMPLETION")" \
    --baseline-completion "$(winpath "$BASELINE_CORRECTNESS_COMPLETION")" \
    --binding "$(winpath "$HARNESS_SOURCE_BINDING")" >/dev/null || return 1
}
invalidate_pair_finalization() {
  # These are the only derived pair-seal files. Raw pair evidence remains
  # untouched so a corrected source checkout can retry finalization.
  rm -f -- "$PAIR_ROOT/output-manifest.sha256" "$PAIR_ROOT/COMPLETED.json" "$PAIR_ROOT.finalization.json"
}
reverify_harness_source
ARCHIVE_PATH="$(read_manifest_field canonical_database.archive_path)"
ARCHIVE_SHA="$(read_manifest_field canonical_database.archive_sha256)"
[ "$ARCHIVE_PATH" = "$CANONICAL_ARCHIVE" ] || { echo "canonical archive path does not match frozen manifest" >&2; exit 1; }
[ "$ARCHIVE_SHA" = "$CANONICAL_SHA256" ] || { echo "canonical archive checksum does not match frozen manifest" >&2; exit 1; }
[ "$(sha256sum "$CANONICAL_ARCHIVE" | awk '{print $1}')" = "$CANONICAL_SHA256" ] || { echo "canonical archive bytes do not match checksum" >&2; exit 1; }
PAIR_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
quiet_check before

SIDE_RECORDS=()
PREVIOUS_END_EPOCH=
for index in 0 1; do
  side="${SIDES[$index]}"
  sequence=$((index+1))
  echo "==> pair $PAIR_ID side $sequence: $side"
  restore_started="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  if [ -n "$RESTORE_HOOK" ]; then
    "$RESTORE_HOOK" "$ARCHIVE_PATH" "$ARCHIVE_SHA" "$side" > "$PAIR_ROOT/pair-evidence/database-$sequence-$side-restore.txt"
  else
    bash measurement/stack/measure-stack.sh restore-canonical-dump "$ARCHIVE_PATH" "$ARCHIVE_SHA" \
      > "$PAIR_ROOT/pair-evidence/database-$sequence-$side-restore.txt"
  fi
  if [ -n "$PHASE2_FINGERPRINT_HOOK" ]; then
    "$PHASE2_FINGERPRINT_HOOK" "$side" > "$PAIR_ROOT/pair-evidence/database-$sequence-$side-before.txt"
  else
    bash measurement/stack/measure-stack.sh database-fingerprint > "$PAIR_ROOT/pair-evidence/database-$sequence-$side-before.txt"
  fi
  isolation_raw="$PAIR_ROOT/pair-evidence/database-$sequence-$side-provider-isolation.raw.json"
  isolation_verified="$PAIR_ROOT/pair-evidence/database-$sequence-$side-provider-isolation.json"
  bash measurement/stack/measure-stack.sh provider-isolation-audit > "$isolation_raw"
  node measurement/phase2/bin/verify-database-isolation.mjs --input "$(winpath "$isolation_raw")" --out "$(winpath "$isolation_verified")"
  before_fingerprint="$(tail -n 1 "$PAIR_ROOT/pair-evidence/database-$sequence-$side-before.txt" | tr -d '\r')"
  [[ "$before_fingerprint" =~ ^[a-f0-9]{64}$ ]] || { echo "fingerprint hook did not return one lowercase SHA-256" >&2; exit 1; }
  side_started="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  side_start_epoch="$(date +%s)"
  if [ -n "$PREVIOUS_END_EPOCH" ]; then
    gap=$((side_start_epoch-PREVIOUS_END_EPOCH))
    [ "$gap" -le "$MAX_GAP_SECONDS" ] || { echo "inter-side gap $gap exceeded maximum $MAX_GAP_SECONDS" >&2; exit 1; }
  else gap=0; fi
  if [ "$side" = current ]; then SIDE_IMAGE_REFERENCE="$CURRENT_IMAGE"; else SIDE_IMAGE_REFERENCE="$BASELINE_IMAGE"; fi
  DATABASE_FINGERPRINT_BEFORE="$before_fingerprint"
  export PAIR_ID PAIR_ORDER CORRECTNESS_MANIFEST PAIR_ROOT SIDE_IMAGE_REFERENCE DATABASE_FINGERPRINT_BEFORE PHASE2_FINGERPRINT_HOOK HARNESS_MANIFEST HARNESS_MANIFEST_SHA256
  export PAIR_SEQUENCE="$sequence"
  bash measurement/phase2/bin/run-phase2.sh "$side"
  side_ended="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  PREVIOUS_END_EPOCH="$(date +%s)"
  after_fingerprint="$(tr -d '\r\n' < "$PAIR_ROOT/$side/env/database-fingerprint-after.txt")"
  [ "$before_fingerprint" = "$after_fingerprint" ] || {
    echo "$side mutated the canonical database: before=$before_fingerprint after=$after_fingerprint" >&2; exit 1;
  }
  node measurement/phase2/bin/verify-completed-run.mjs "$(winpath "$PAIR_ROOT/$side")" > "$PAIR_ROOT/pair-evidence/$side-completion-verified.json"
  reverify_harness_source
  phase2_checks_passed="$(node --input-type=module -e 'import fs from "node:fs";import {validatePhase2Correctness} from "./measurement/phase2/bin/correctness-contract.mjs";const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));validatePhase2Correctness(s.phase2_correctness,process.argv[2]);process.stdout.write("true")' "$(winpath "$PAIR_ROOT/$side/summary.json")" "$side")"
  [ "$phase2_checks_passed" = true ] || { echo "$side phase2-owned correctness checks did not pass" >&2; exit 1; }
  node - "$(winpath "$PAIR_ROOT/$side/env/runtime-identity-initial.json")" "$(winpath "$PAIR_ROOT/$side.runtime-identity-after-finalization.json")" <<'NODE'
const fs=require("node:fs");
const before=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const after=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
if(JSON.stringify(before)!==JSON.stringify(after)||!after.verified) throw new Error("app/Postgres identity changed across side finalization");
NODE
  environment_hmac="$(node -e 'process.stdout.write(require(process.argv[1]).keyed_fingerprint_sha256)' "$(winpath "$PAIR_ROOT/$side/env/app-environment-audit.json")")"
  runtime_finalization_sha="$(sha256sum "$PAIR_ROOT/$side.runtime-identity-after-finalization.json" | awk '{print $1}')"
  SIDE_RECORDS+=("$sequence|$side|$restore_started|$side_started|$side_ended|$gap|$before_fingerprint|$after_fingerprint|$environment_hmac|$runtime_finalization_sha|$phase2_checks_passed")
  quiet_check "after-$side"
done

PAIR_ENDED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
export PAIR_STARTED_AT PAIR_ENDED_AT ARCHIVE_SHA MAX_GAP_SECONDS QUIET_CPU_LIMIT_PERCENT QUIET_SAMPLES
export SIDE_RECORD_1="${SIDE_RECORDS[0]}" SIDE_RECORD_2="${SIDE_RECORDS[1]}"
node - "$(winpath "$PAIR_ROOT/pair.json")" <<'NODE'
const fs = require("node:fs");
const parse = (raw) => {
  const [sequence,side,restore_started_at,started_at,ended_at,gap_from_previous_seconds,database_fingerprint_before,database_fingerprint_after,environment_hmac_sha256,runtime_identity_after_finalization_sha256,phase2ChecksPassed] = raw.split("|");
  return {sequence:Number(sequence),side,restore_started_at,started_at,ended_at,gap_from_previous_seconds:Number(gap_from_previous_seconds),database_fingerprint_before,database_fingerprint_after,environment_hmac_sha256,runtime_identity_after_finalization_sha256,phase2_checks_passed:phase2ChecksPassed==="true"};
};
const pair = {
  schema_version: 2,
  pair_id: process.env.PAIR_ID,
  order: process.env.PAIR_ORDER,
  started_at: process.env.PAIR_STARTED_AT,
  ended_at: process.env.PAIR_ENDED_AT,
  maximum_inter_side_gap_seconds: Number(process.env.MAX_GAP_SECONDS),
  quiet_cpu_limit_percent: Number(process.env.QUIET_CPU_LIMIT_PERCENT),
  quiet_samples: Number(process.env.QUIET_SAMPLES),
  quiet_host_attested: true,
  measurement_profile: process.env.MEASUREMENT_PROFILE,
  canonical_database_archive_sha256: process.env.ARCHIVE_SHA,
  sides: [parse(process.env.SIDE_RECORD_1), parse(process.env.SIDE_RECORD_2)],
  phase2_checks_passed: true,
  status: "COMPLETE",
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(pair,null,2)}\n`, {flag:"wx"});
NODE
# Stop writing into the pair before hashing it, then wait for tee to flush every
# byte. The finalizer output lives beside (not inside) the sealed directory.
exec 1>&3 2>&4
wait "$PAIR_TEE_PID"
reverify_harness_source
node measurement/phase2/bin/finalize-run.mjs --dir "$(winpath "$PAIR_ROOT")" --side pair --pair-id "$PAIR_ID" > "$PAIR_ROOT.finalization.json"
if ! reverify_harness_source; then
  invalidate_pair_finalization
  echo "pair finalization invalidated because live harness source changed" >&2
  exit 1
fi
