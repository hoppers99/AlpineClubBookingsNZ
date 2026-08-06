#!/usr/bin/env bash
# Runs the complete #2352 counterbalanced measurement set through run-pair.sh.
# This layer owns the multi-pair schedule, immutable input snapshot, host-noise
# evidence, between-pair gap, and set-level completion marker. run-pair.sh owns
# each pair's canonical database restore, per-side fingerprints and side runs.
set -euo pipefail
cd "$(dirname "$0")/../../.."
case "$(uname -s)" in MINGW*|MSYS*) ;; *) echo "phase-2 is cleared only for Git Bash on Windows; direct WSL/Linux execution is prohibited" >&2; exit 2 ;; esac

usage() {
  cat >&2 <<'EOF'
usage: QUIET_HOST_ATTESTED=YES orchestrate-pairs.sh --manifest <absolute-json>
       [--output-id <unique-id>] [--pair-count <even-number-at-least-4>]
       [--max-inter-side-gap-seconds <seconds>]
       [--max-inter-pair-gap-seconds <seconds>]

       orchestrate-pairs.sh --plan-only [--pair-count <even-number-at-least-4>]
EOF
  exit 2
}

utc_now() { date -u +%Y-%m-%dT%H:%M:%S.%NZ; }
epoch_now() { date -u +%s; }
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
new_guid() {
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    tr -d '-\r\n' < /proc/sys/kernel/random/uuid
  else
    powershell.exe -NoProfile -NonInteractive -Command '[guid]::NewGuid().ToString("N")' |
      tr -d '\0\r\n'
  fi
}
positive_integer() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
numeric_value() { [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]; }
winpath() { cygpath -am "$1"; }

CORRECTNESS_MANIFEST=
OUTPUT_ID=
PAIR_COUNT="${PAIR_COUNT:-4}"
MAX_INTER_SIDE_GAP_SECONDS="${MAX_INTER_SIDE_GAP_SECONDS:-600}"
MAX_INTER_PAIR_GAP_SECONDS="${MAX_INTER_PAIR_GAP_SECONDS:-600}"
MEASUREMENT_PROFILE="${MEASUREMENT_PROFILE:-final-decision}"
QUIET_MONITOR_INTERVAL_SECONDS="${QUIET_MONITOR_INTERVAL_SECONDS:-10}"
QUIET_CPU_LIMIT_PERCENT="${QUIET_CPU_LIMIT_PERCENT:-20}"
QUIET_SAMPLES="${QUIET_SAMPLES:-5}"
ALLOWED_RUNNING_CONTAINERS="${ALLOWED_RUNNING_CONTAINERS:-tacbookings-measure-app-1,tacbookings-measure-caddy-1,tacbookings-measure-mailpit-1,tacbookings-measure-postgres-1}"
PLAN_ONLY=false
RESTORE_HOOK="${RESTORE_HOOK:-}"
FINGERPRINT_HOOK="${FINGERPRINT_HOOK:-}"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --manifest) CORRECTNESS_MANIFEST="${2:-}"; shift 2 ;;
    --output-id) OUTPUT_ID="${2:-}"; shift 2 ;;
    --pair-count) PAIR_COUNT="${2:-}"; shift 2 ;;
    --max-inter-side-gap-seconds) MAX_INTER_SIDE_GAP_SECONDS="${2:-}"; shift 2 ;;
    --max-inter-pair-gap-seconds) MAX_INTER_PAIR_GAP_SECONDS="${2:-}"; shift 2 ;;
    --restore-hook|--fingerprint-hook) echo "restore/fingerprint hooks are prohibited for final decision evidence" >&2; exit 2 ;;
    --plan-only) PLAN_ONLY=true; shift ;;
    *) usage ;;
  esac
done

positive_integer "$PAIR_COUNT" || usage
(( PAIR_COUNT >= 4 && PAIR_COUNT % 2 == 0 )) || {
  echo "pair count must be even and at least 4; refusing an underpowered or unbalanced schedule" >&2
  exit 2
}
positive_integer "$MAX_INTER_SIDE_GAP_SECONDS" || usage
positive_integer "$MAX_INTER_PAIR_GAP_SECONDS" || usage
positive_integer "$QUIET_MONITOR_INTERVAL_SECONDS" || usage
numeric_value "$QUIET_CPU_LIMIT_PERCENT" || usage
positive_integer "$QUIET_SAMPLES" || usage
[[ "$ALLOWED_RUNNING_CONTAINERS" =~ ^[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+)*$ ]] || usage
case "$MEASUREMENT_PROFILE" in final-decision|nonfinal-test) ;; *) usage ;; esac

print_plan() {
  local pair_number order
  for ((pair_number = 1; pair_number <= PAIR_COUNT; pair_number += 1)); do
    if (( pair_number % 2 == 1 )); then order=current-baseline; else order=baseline-current; fi
    printf '%d\t%s\n' "$pair_number" "$order"
  done
}
if [[ "$PLAN_ONLY" == true ]]; then
  print_plan
  exit 0
fi
NODE_VERSION="$(node --version)"
[[ "$NODE_VERSION" =~ ^v24\. ]] || { echo "phase-2 final execution requires repository Node 24, got $NODE_VERSION" >&2; exit 2; }
if [[ -n "$RESTORE_HOOK" || -n "$FINGERPRINT_HOOK" ]]; then
  echo "restore/fingerprint hook environment variables are prohibited for final decision evidence" >&2
  exit 2
fi
if [[ "$MEASUREMENT_PROFILE" == final-decision ]] && { [[ "$PAIR_COUNT" != 4 ]] || [[ "$MAX_INTER_SIDE_GAP_SECONDS" != 600 ]] || [[ "$MAX_INTER_PAIR_GAP_SECONDS" != 600 ]] || [[ "$QUIET_MONITOR_INTERVAL_SECONDS" != 10 ]] || [[ "$QUIET_CPU_LIMIT_PERCENT" != 20 ]] || [[ "$QUIET_SAMPLES" != 5 ]] || [[ "$ALLOWED_RUNNING_CONTAINERS" != tacbookings-measure-app-1,tacbookings-measure-caddy-1,tacbookings-measure-mailpit-1,tacbookings-measure-postgres-1 ]]; }; then
  echo "final-decision orchestration profile cannot weaken or change pair/gap/monitor/container controls" >&2
  exit 2
fi

[[ "${QUIET_HOST_ATTESTED:-}" == YES ]] || {
  echo "QUIET_HOST_ATTESTED=YES is required after the operator closes heavy host work" >&2
  exit 1
}
[[ -n "$CORRECTNESS_MANIFEST" && -f "$CORRECTNESS_MANIFEST" ]] || usage
manifest_dir="$(cd "$(dirname "$CORRECTNESS_MANIFEST")" && pwd -P)"
CORRECTNESS_MANIFEST="$manifest_dir/$(basename "$CORRECTNESS_MANIFEST")"
OUTPUT_ID="${OUTPUT_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(new_guid)}"
[[ "$OUTPUT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,54}$ ]] || {
  echo "output id must be 3-55 characters from [A-Za-z0-9._-] and start alphanumeric" >&2
  exit 2
}

RESULTS_ROOT="${PAIR_RESULTS_ROOT:-measurement/phase2/results}"
mkdir -p "$RESULTS_ROOT"
RESULTS_ROOT="$(cd "$RESULTS_ROOT" && pwd -P)"
OUTPUT_ROOT="$RESULTS_ROOT/orchestration-$OUTPUT_ID"
if ! mkdir "$OUTPUT_ROOT" 2>/dev/null; then
  echo "output collision: $OUTPUT_ROOT already exists; refusing to reuse evidence" >&2
  exit 1
fi
mkdir "$OUTPUT_ROOT/inputs" "$OUTPUT_ROOT/quiet-host" "$OUTPUT_ROOT/pairs"
printf '%s\n' "$NODE_VERSION" > "$OUTPUT_ROOT/inputs/node-version.txt"
exec 3>&1 4>&2
exec > >(tee -a "$OUTPUT_ROOT/orchestrator.log" >&3) 2>&1
TEE_PID=$!

# This lock binds the fixed Compose/database resource, not a configurable
# results directory. Changing PAIR_RESULTS_ROOT must never permit two writers.
WINDOWS_TEMP_PATH="$(powershell.exe -NoProfile -NonInteractive -Command '[IO.Path]::GetTempPath()' | tr -d '\0\r\n')"
LOCK_DIR="$(cygpath -u "$WINDOWS_TEMP_PATH")/tacbookings-measure-phase2.lock"
LOCK_HELD=false
LOCK_TOKEN=
MONITOR_PID=
MONITOR_EXIT_RECORDED=false
MONITOR_STOP="$OUTPUT_ROOT/quiet-host/STOP"
CONTAMINATION_FILE="$OUTPUT_ROOT/quiet-host/CONTAMINATION.tsv"
RUN_SUCCEEDED=false
PAIR_RUNNER="measurement/phase2/bin/run-pair.sh"

# The multi-pair layer must not infer a result path from human-readable stdout.
# run-pair.sh owns atomic creation of this exact, previously-absent directory.
grep -q -- '--output-root)' "$PAIR_RUNNER" || {
  echo "run-pair.sh integration contract is incomplete: add --output-root <nonexistent-absolute-directory>" >&2
  exit 1
}

capture_snapshot() {
  local label="$1" dir="$2" failed=0
  mkdir "$dir" || return 1
  printf 'label=%s\ncaptured_at_utc=%s\n' "$label" "$(utc_now)" > "$dir/capture.env"

  docker ps -a --no-trunc \
    --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' \
    > "$dir/docker-containers-all.tsv" 2> "$dir/docker-containers-all.stderr" || failed=1
  docker ps --format '{{.Names}}' \
    > "$dir/docker-running-names.txt" 2> "$dir/docker-running-names.stderr" || failed=1
  docker stats --all --no-stream \
    --format '{{.Container}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}' \
    > "$dir/docker-stats-all.tsv" 2> "$dir/docker-stats-all.stderr" || failed=1

  powershell.exe -NoProfile -NonInteractive -Command '
$ErrorActionPreference = "Stop"
$processor = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object Name -eq "_Total" | Select-Object -First 1
$disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object Name -eq "_Total" | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$memoryPercent = 100 * ($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize
"host_cpu_percent=$([math]::Round([double]$processor.PercentProcessorTime, 3))"
"host_memory_percent=$([math]::Round([double]$memoryPercent, 3))"
"host_disk_busy_percent=$([math]::Round([double]$disk.PercentDiskTime, 3))"
"host_memory_total_kib=$($os.TotalVisibleMemorySize)"
"host_memory_free_kib=$($os.FreePhysicalMemory)"
' | tr -d '\0\r' > "$dir/windows-load.env" 2> "$dir/windows-load.stderr" || failed=1

  powershell.exe -NoProfile -NonInteractive -Command '
Get-Process | Sort-Object CPU -Descending |
  Select-Object -First 40 ProcessName,Id,CPU,WorkingSet64,Path |
  ConvertTo-Csv -NoTypeInformation
' | tr -d '\0\r' > "$dir/windows-top-cpu.csv" 2> "$dir/windows-top-cpu.stderr" || failed=1
  powershell.exe -NoProfile -NonInteractive -Command '
Get-Process | Sort-Object WorkingSet64 -Descending |
  Select-Object -First 40 ProcessName,Id,CPU,WorkingSet64,Path |
  ConvertTo-Csv -NoTypeInformation
' | tr -d '\0\r' > "$dir/windows-top-memory.csv" 2> "$dir/windows-top-memory.stderr" || failed=1
  powershell.exe -NoProfile -NonInteractive -Command '
Get-CimInstance Win32_LogicalDisk |
  Select-Object DeviceID,DriveType,Size,FreeSpace,VolumeName |
  ConvertTo-Csv -NoTypeInformation
' | tr -d '\0\r' > "$dir/windows-disks.csv" 2> "$dir/windows-disks.stderr" || failed=1
  {
    powercfg.exe /getactivescheme
    powercfg.exe /requests
    powershell.exe -NoProfile -NonInteractive -Command '
$battery = Get-CimInstance Win32_Battery
if ($null -eq $battery) { "battery_present=false" } else {
  "battery_present=true"
  $battery | Select-Object Name,BatteryStatus,EstimatedChargeRemaining,EstimatedRunTime | Format-List
}
'
  } | tr -d '\0\r' > "$dir/windows-power-state.txt" 2> "$dir/windows-power-state.stderr" || true

  wsl.exe sh -lc 'head -n 1 /proc/stat' | tr -d '\0\r' \
    > "$dir/wsl-cpu-before.txt" 2> "$dir/wsl-cpu-before.stderr" || failed=1
  sleep 0.25
  wsl.exe sh -lc 'head -n 1 /proc/stat' | tr -d '\0\r' \
    > "$dir/wsl-cpu-after.txt" 2> "$dir/wsl-cpu-after.stderr" || failed=1
  wsl.exe sh -lc '
echo "== uname =="; uname -a
echo "== uptime-load =="; cat /proc/uptime; cat /proc/loadavg
echo "== memory =="; cat /proc/meminfo
echo "== filesystems =="; df -PT
echo "== diskstats =="; cat /proc/diskstats
echo "== top-cpu =="; ps -eo pid,ppid,comm,%cpu,%mem --sort=-%cpu | head -n 41
echo "== top-memory =="; ps -eo pid,ppid,comm,%cpu,%mem --sort=-%mem | head -n 41
' | tr -d '\0\r' > "$dir/wsl-system.txt" 2> "$dir/wsl-system.stderr" || failed=1

  printf 'capture_ok=%s\n' "$(( failed == 0 ? 1 : 0 ))" >> "$dir/capture.env"
  return "$failed"
}

evaluate_snapshot() {
  local dir="$1" host_cpu_limit="$2" host_memory_limit="$3"
  local host_disk_limit="$4" wsl_cpu_limit="$5" wsl_memory_limit="$6"
  ALLOWED_RUNNING_CONTAINERS="$ALLOWED_RUNNING_CONTAINERS" node - \
    "$(winpath "$dir")" "$host_cpu_limit" "$host_memory_limit" "$host_disk_limit" \
    "$wsl_cpu_limit" "$wsl_memory_limit" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [dir, ...rawLimits] = process.argv.slice(2);
const [hostCpuLimit, hostMemoryLimit, hostDiskLimit, wslCpuLimit, wslMemoryLimit] = rawLimits.map(Number);
const fail = (message) => { throw new Error(message); };
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
const env = Object.fromEntries(read("windows-load.env").trim().split(/\r?\n/).map((line) => {
  const split = line.indexOf("=");
  return [line.slice(0, split), Number(line.slice(split + 1))];
}));
for (const key of ["host_cpu_percent", "host_memory_percent", "host_disk_busy_percent"]) {
  if (!Number.isFinite(env[key])) fail(`missing Windows metric ${key}`);
}
const cpuFields = (name) => read(name).trim().split(/\s+/).slice(1).map(Number);
const before = cpuFields("wsl-cpu-before.txt");
const after = cpuFields("wsl-cpu-after.txt");
if (before.length < 4 || before.length !== after.length || [...before, ...after].some((value) => !Number.isFinite(value))) {
  fail("invalid WSL /proc/stat capture");
}
const totalDelta = after.reduce((sum, value, index) => sum + value - before[index], 0);
const idleDelta = (after[3] + (after[4] ?? 0)) - (before[3] + (before[4] ?? 0));
if (totalDelta <= 0 || idleDelta < 0) fail("invalid WSL CPU sampling interval");
const wslCpuPercent = 100 * (totalDelta - idleDelta) / totalDelta;
const wslText = read("wsl-system.txt");
const memTotal = Number(/^MemTotal:\s+(\d+)/m.exec(wslText)?.[1]);
const memAvailable = Number(/^MemAvailable:\s+(\d+)/m.exec(wslText)?.[1]);
if (!Number.isFinite(memTotal) || !Number.isFinite(memAvailable) || memTotal <= 0) {
  fail("invalid WSL memory capture");
}
const wslMemoryPercent = 100 * (memTotal - memAvailable) / memTotal;
const allowed = new Set((process.env.ALLOWED_RUNNING_CONTAINERS ?? "").split(",").filter(Boolean));
const running = read("docker-running-names.txt").trim().split(/\r?\n/).filter(Boolean);
const unexpected = running.filter((name) => !allowed.has(name));
const metrics = {
  host_cpu_percent: env.host_cpu_percent,
  host_memory_percent: env.host_memory_percent,
  host_disk_busy_percent: env.host_disk_busy_percent,
  wsl_cpu_percent: Number(wslCpuPercent.toFixed(3)),
  wsl_memory_percent: Number(wslMemoryPercent.toFixed(3)),
};
const limits = {
  host_cpu_percent: hostCpuLimit,
  host_memory_percent: hostMemoryLimit,
  host_disk_busy_percent: hostDiskLimit,
  wsl_cpu_percent: wslCpuLimit,
  wsl_memory_percent: wslMemoryLimit,
};
const excessive = Object.keys(limits).filter((key) => metrics[key] > limits[key]);
const result = {
  schema_version: 1,
  evaluated_at_utc: new Date().toISOString(),
  allowed_running_containers: [...allowed].sort(),
  observed_running_containers: running.sort(),
  unexpected_running_containers: unexpected,
  metrics,
  limits,
  excessive_metrics: excessive,
  passed: unexpected.length === 0 && excessive.length === 0,
};
fs.writeFileSync(path.join(dir, "evaluation.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
if (unexpected.length) fail(`non-allowlisted running containers: ${unexpected.join(", ")}`);
if (excessive.length) fail(`quiet-host limits exceeded: ${excessive.join(", ")}`);
NODE
}

append_contamination() {
  printf '%s\t%s\n' "$(utc_now)" "$1" >> "$CONTAMINATION_FILE"
}

monitor_loop() {
  set +e
  local sample=0 dir
  while [[ ! -e "$MONITOR_STOP" ]]; do
    sample=$((sample + 1))
    dir="$OUTPUT_ROOT/quiet-host/continuous-$(printf '%06d' "$sample")"
    if ! capture_snapshot "continuous-$sample" "$dir"; then
      append_contamination "continuous-$sample capture failed"
    elif ! evaluate_snapshot "$dir" \
      "$CONTINUOUS_MAX_HOST_CPU_PERCENT" "$CONTINUOUS_MAX_HOST_MEMORY_PERCENT" \
      "$CONTINUOUS_MAX_HOST_DISK_PERCENT" "$CONTINUOUS_MAX_WSL_CPU_PERCENT" \
      "$CONTINUOUS_MAX_WSL_MEMORY_PERCENT"; then
      append_contamination "continuous-$sample contamination detected; see $dir/evaluation.json"
    fi
    sleep "$QUIET_MONITOR_INTERVAL_SECONDS"
  done
}

stop_monitor() {
  if [[ -n "$MONITOR_PID" ]]; then
    : > "$MONITOR_STOP"
    local monitor_status=0
    wait "$MONITOR_PID" || monitor_status=$?
    printf '%s\n' "$monitor_status" > "$OUTPUT_ROOT/quiet-host/monitor-exit-status.txt"
    MONITOR_EXIT_RECORDED=true
    MONITOR_PID=
    [[ "$monitor_status" -eq 0 ]]
  fi
}

cleanup() {
  local status="$?"
  set +e
  stop_monitor || true
  if [[ "$RUN_SUCCEEDED" != true ]]; then
    capture_snapshot cleanup-failure "$OUTPUT_ROOT/quiet-host/cleanup-failure" || true
    if [[ ! -e "$OUTPUT_ROOT/FAILED.txt" ]]; then
      ( set -C; printf 'status=FAILED\nfailed_at_utc=%s\nexit_code=%s\nevidence_preserved=%s\n' \
          "$(utc_now)" "$status" "$OUTPUT_ROOT" > "$OUTPUT_ROOT/FAILED.txt" ) || true
    fi
  fi
  if [[ "$LOCK_HELD" == true ]]; then
    if [[ -f "$LOCK_DIR/owner.txt" ]] && grep -qx "token=$LOCK_TOKEN" "$LOCK_DIR/owner.txt"; then
      rm -f "$LOCK_DIR/.env.measure.snapshot" "$LOCK_DIR/runtime-env-hmac.key" "$LOCK_DIR/owner.txt"
      rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for value in \
  "${QUIET_MAX_HOST_CPU_PERCENT:=25}" \
  "${QUIET_MAX_HOST_MEMORY_PERCENT:=90}" \
  "${QUIET_MAX_HOST_DISK_PERCENT:=60}" \
  "${QUIET_MAX_WSL_CPU_PERCENT:=25}" \
  "${QUIET_MAX_WSL_MEMORY_PERCENT:=95}" \
  "${CONTINUOUS_MAX_HOST_CPU_PERCENT:=40}" \
  "${CONTINUOUS_MAX_HOST_MEMORY_PERCENT:=92}" \
  "${CONTINUOUS_MAX_HOST_DISK_PERCENT:=80}" \
  "${CONTINUOUS_MAX_WSL_CPU_PERCENT:=40}" \
  "${CONTINUOUS_MAX_WSL_MEMORY_PERCENT:=95}"; do
  numeric_value "$value" || { echo "quiet-host limits must be non-negative numbers" >&2; exit 2; }
done
node -e 'const v=process.argv.slice(1).map(Number);const caps=[25,90,60,25,95,40,92,80,40,95];if(v.some((x,i)=>x>caps[i])){throw new Error("quiet-host thresholds may not be relaxed above the reviewed fail-closed caps")}' \
  "$QUIET_MAX_HOST_CPU_PERCENT" "$QUIET_MAX_HOST_MEMORY_PERCENT" "$QUIET_MAX_HOST_DISK_PERCENT" \
  "$QUIET_MAX_WSL_CPU_PERCENT" "$QUIET_MAX_WSL_MEMORY_PERCENT" "$CONTINUOUS_MAX_HOST_CPU_PERCENT" \
  "$CONTINUOUS_MAX_HOST_MEMORY_PERCENT" "$CONTINUOUS_MAX_HOST_DISK_PERCENT" \
  "$CONTINUOUS_MAX_WSL_CPU_PERCENT" "$CONTINUOUS_MAX_WSL_MEMORY_PERCENT"
export ALLOWED_RUNNING_CONTAINERS QUIET_CPU_LIMIT_PERCENT QUIET_SAMPLES

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "another phase-2 pair orchestrator is active, or stale lock requires review: $LOCK_DIR" >&2
  exit 1
fi
LOCK_HELD=true
LOCK_TOKEN="$(new_guid)"
printf 'output_id=%s\npid=%s\nstarted_at_utc=%s\ntoken=%s\n' "$OUTPUT_ID" "$$" "$(utc_now)" "$LOCK_TOKEN" > "$LOCK_DIR/owner.txt"
MEASURE_ENV_SOURCE="$(cygpath -am measurement/stack/.env.measure)"
MEASURE_ENV_SNAPSHOT="$(cygpath -am "$LOCK_DIR/.env.measure.snapshot")"
PHASE2_ENV_AUDIT_HMAC_KEY_FILE="$(cygpath -am "$LOCK_DIR/runtime-env-hmac.key")"
printf '%s%s\n' "$(new_guid)" "$(new_guid)" > "$PHASE2_ENV_AUDIT_HMAC_KEY_FILE"
chmod 600 "$LOCK_DIR/owner.txt" "$PHASE2_ENV_AUDIT_HMAC_KEY_FILE"
MEASURE_ENV_SNAPSHOT_AUDIT="$OUTPUT_ROOT/inputs/measure-env-snapshot-audit.json"
node measurement/phase2/bin/measure-env-contract.mjs \
  --snapshot-source "$MEASURE_ENV_SOURCE" --snapshot-out "$MEASURE_ENV_SNAPSHOT" \
  --hmac-key-file "$PHASE2_ENV_AUDIT_HMAC_KEY_FILE" --audit-out "$(winpath "$MEASURE_ENV_SNAPSHOT_AUDIT")"
MEASURE_ENV_SNAPSHOT_HMAC_SHA256="$(node -e 'const v=require(process.argv[1]);if(!/^[a-f0-9]{64}$/.test(v.snapshot_hmac_sha256))process.exit(2);process.stdout.write(v.snapshot_hmac_sha256)' "$(winpath "$MEASURE_ENV_SNAPSHOT_AUDIT")")"
chmod 600 "$LOCK_DIR/owner.txt" "$MEASURE_ENV_SNAPSHOT" "$PHASE2_ENV_AUDIT_HMAC_KEY_FILE"
export MEASURE_ENV_SNAPSHOT MEASURE_ENV_SNAPSHOT_HMAC_SHA256 PHASE2_ENV_AUDIT_HMAC_KEY_FILE MEASUREMENT_PROFILE

MANIFEST_SNAPSHOT="$OUTPUT_ROOT/inputs/correctness-manifest.json"
cp "$CORRECTNESS_MANIFEST" "$MANIFEST_SNAPSHOT"
MANIFEST_SNAPSHOT="$(cd "$(dirname "$MANIFEST_SNAPSHOT")" && pwd -P)/$(basename "$MANIFEST_SNAPSHOT")"
MANIFEST_SHA="$(sha256_file "$MANIFEST_SNAPSHOT")"
IMMUTABLE_INPUTS="$OUTPUT_ROOT/inputs/immutable-inputs.json"
node - "$(winpath "$CORRECTNESS_MANIFEST")" "$(winpath "$MANIFEST_SNAPSHOT")" "$MANIFEST_SHA" "$(winpath "$IMMUTABLE_INPUTS")" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [sourcePath, snapshotPath, expectedManifestSha, outPath] = process.argv.slice(2);
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const fail = (message) => { throw new Error(message); };
if (hash(sourcePath) !== expectedManifestSha || hash(snapshotPath) !== expectedManifestSha) {
  fail("correctness manifest changed while it was being snapshotted");
}
const manifest = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
if (manifest.schema_version !== 1 || manifest.harness_scope !== "issue-2352-phase2") {
  fail("unsupported correctness manifest schema/scope");
}
const checkedFile = (entry, label) => {
  if (!entry || typeof entry.path !== "string" || !path.isAbsolute(entry.path)) fail(`${label}.path must be absolute`);
  if (/[\t\r\n]/.test(entry.path)) fail(`${label}.path contains a control character`);
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) fail(`${label}.sha256 must be lowercase SHA-256`);
  if (!fs.statSync(entry.path).isFile()) fail(`${label}.path is not a file`);
  const actual = hash(entry.path);
  if (actual !== entry.sha256) fail(`${label} checksum mismatch`);
  return { path: path.resolve(entry.path), sha256: actual };
};
const canonicalDatabase = checkedFile({
  path: manifest.canonical_database?.archive_path,
  sha256: manifest.canonical_database?.archive_sha256,
}, "canonical_database.archive");
const sides = {};
for (const side of ["current", "baseline"]) {
  const input = manifest.sides?.[side];
  if (!input) fail(`missing ${side} manifest input`);
  if (typeof input.image_reference !== "string" || /[\t\r\n]/.test(input.image_reference)) fail(`${side}.image_reference is invalid`);
  if (!/^sha256:[a-f0-9]{64}$/.test(input.image_id ?? "")) fail(`${side}.image_id is not immutable`);
  if (!/^[a-f0-9]{40,64}$/.test(input.oci_revision ?? "")) fail(`${side}.oci_revision is invalid`);
  sides[side] = {
    image_reference: input.image_reference,
    image_id: input.image_id,
    oci_revision: input.oci_revision,
    source_archive: checkedFile(input.source_archive, `${side}.source_archive`),
    correctness_completion: checkedFile(input.correctness_completion, `${side}.correctness_completion`),
    routes: input.routes,
  };
}
const exactInputs = {
  schema_version: 1,
  captured_at_utc: new Date().toISOString(),
  manifest_source_path: path.resolve(sourcePath),
  manifest_snapshot_path: path.resolve(snapshotPath),
  manifest_sha256: expectedManifestSha,
  canonical_database: { archive_path: canonicalDatabase.path, archive_sha256: canonicalDatabase.sha256 },
  sides,
};
fs.writeFileSync(outPath, `${JSON.stringify(exactInputs, null, 2)}\n`, { flag: "wx" });
NODE
INPUTS_SHA="$(sha256_file "$IMMUTABLE_INPUTS")"
chmod a-w "$MANIFEST_SNAPSHOT" "$IMMUTABLE_INPUTS" 2>/dev/null || true

HARNESS_MANIFEST="$OUTPUT_ROOT/inputs/harness-files.sha256"
{
  find measurement/phase2/bin -maxdepth 1 -type f -print
  printf '%s\n' docker-compose.yml Caddyfile.staging \
    measurement/stack/docker-compose.measure.yml measurement/stack/measure-stack.sh
} | sort -u | while IFS= read -r harness_file; do
  [[ "$harness_file" != *'.env.measure'* ]] || { echo "refusing to hash .env.measure" >&2; exit 1; }
  printf '%s  %s\n' "$(sha256_file "$harness_file")" "$(cygpath -am "$harness_file")"
done > "$HARNESS_MANIFEST"
HARNESS_MANIFEST_SHA256="$(sha256_file "$HARNESS_MANIFEST")"
node measurement/phase2/bin/verify-harness-manifest.mjs "$(winpath "$HARNESS_MANIFEST")" >/dev/null
IFS=$'\t' read -r CURRENT_IMAGE_REFERENCE CURRENT_IMAGE_ID BASELINE_IMAGE_REFERENCE BASELINE_IMAGE_ID \
  CANONICAL_DATABASE_ARCHIVE_PATH CANONICAL_DATABASE_ARCHIVE_SHA256 < <(
    node - "$(winpath "$IMMUTABLE_INPUTS")" <<'NODE'
const input = require(process.argv[2]);
process.stdout.write([
  input.sides.current.image_reference,
  input.sides.current.image_id,
  input.sides.baseline.image_reference,
  input.sides.baseline.image_id,
  input.canonical_database.archive_path,
  input.canonical_database.archive_sha256,
].join("\t"));
NODE
  )

{
  printf '%s  %s\n' "$HARNESS_MANIFEST_SHA256" "$HARNESS_MANIFEST"
  printf '%s  %s\n' "$MANIFEST_SHA" "$MANIFEST_SNAPSHOT"
  printf '%s  %s\n' "$INPUTS_SHA" "$IMMUTABLE_INPUTS"
} > "$OUTPUT_ROOT/harness-and-inputs.sha256"

printf 'pair_number\tpair_id\torder\n' > "$OUTPUT_ROOT/pair-plan.tsv"
while IFS=$'\t' read -r pair_number order; do
  printf '%s\t%s-p%02d\t%s\n' "$pair_number" "$OUTPUT_ID" "$pair_number" "$order"
done < <(print_plan) >> "$OUTPUT_ROOT/pair-plan.tsv"
printf 'event_at_utc\tevent\tpair_id\torder\tdetail\n' > "$OUTPUT_ROOT/events.tsv"
: > "$OUTPUT_ROOT/pairs.jsonl"

echo "==> immutable inputs captured: $IMMUTABLE_INPUTS"
echo "==> quiet-host preflight"
capture_snapshot preflight "$OUTPUT_ROOT/quiet-host/preflight"
evaluate_snapshot "$OUTPUT_ROOT/quiet-host/preflight" \
  "$QUIET_MAX_HOST_CPU_PERCENT" "$QUIET_MAX_HOST_MEMORY_PERCENT" \
  "$QUIET_MAX_HOST_DISK_PERCENT" "$QUIET_MAX_WSL_CPU_PERCENT" \
  "$QUIET_MAX_WSL_MEMORY_PERCENT"

monitor_loop &
MONITOR_PID=$!
previous_pair_finished_epoch=
completed_pairs=0

for ((pair_number = 1; pair_number <= PAIR_COUNT; pair_number += 1)); do
  if (( pair_number % 2 == 1 )); then order=current-baseline; else order=baseline-current; fi
  pair_id="$(printf '%s-p%02d' "$OUTPUT_ID" "$pair_number")"
  [[ "$(sha256_file "$MANIFEST_SNAPSHOT")" == "$MANIFEST_SHA" ]] || { echo "immutable manifest snapshot changed" >&2; exit 1; }
  [[ "$(sha256_file "$IMMUTABLE_INPUTS")" == "$INPUTS_SHA" ]] || { echo "immutable input record changed" >&2; exit 1; }
  [[ ! -s "$CONTAMINATION_FILE" ]] || { echo "continuous quiet-host contamination was detected" >&2; exit 1; }

  pair_invoked_epoch="$(epoch_now)"
  pair_invoked_at="$(utc_now)"
  inter_pair_gap=0
  if [[ -n "$previous_pair_finished_epoch" ]]; then
    inter_pair_gap=$((pair_invoked_epoch - previous_pair_finished_epoch))
    (( inter_pair_gap <= MAX_INTER_PAIR_GAP_SECONDS )) || {
      echo "inter-pair gap $inter_pair_gap exceeded maximum $MAX_INTER_PAIR_GAP_SECONDS" >&2
      exit 1
    }
  fi
  printf '%s\tpair-invoked\t%s\t%s\tinter_pair_gap_seconds=%s\n' \
    "$pair_invoked_at" "$pair_id" "$order" "$inter_pair_gap" >> "$OUTPUT_ROOT/events.tsv"
  pair_log="$OUTPUT_ROOT/pair-$(printf '%02d' "$pair_number").log"
  pair_root="$OUTPUT_ROOT/pairs/pair-$(printf '%02d' "$pair_number")-$pair_id"
  [[ ! -e "$pair_root" ]] || { echo "pair output collision: $pair_root" >&2; exit 1; }
  echo "==> pair $pair_number/$PAIR_COUNT: $pair_id ($order)"
  pair_args=(
    --pair-id "$pair_id" \
    --order "$order" \
    --manifest "$MANIFEST_SNAPSHOT" \
    --harness-manifest "$HARNESS_MANIFEST" \
    --harness-manifest-sha256 "$HARNESS_MANIFEST_SHA256" \
    --current-image "$CURRENT_IMAGE_REFERENCE" \
    --baseline-image "$BASELINE_IMAGE_REFERENCE" \
    --canonical-archive "$CANONICAL_DATABASE_ARCHIVE_PATH" \
    --canonical-sha256 "$CANONICAL_DATABASE_ARCHIVE_SHA256" \
    --max-gap-seconds "$MAX_INTER_SIDE_GAP_SECONDS" \
    --output-root "$pair_root"
  )
  QUIET_HOST_ATTESTED=YES bash "$PAIR_RUNNER" "${pair_args[@]}" | tee "$pair_log"
  previous_pair_finished_epoch="$(epoch_now)"
  pair_returned_at="$(utc_now)"
  [[ ! -s "$CONTAMINATION_FILE" ]] || { echo "continuous quiet-host contamination was detected" >&2; exit 1; }

  [[ -d "$pair_root" ]] || { echo "explicit pair output is missing: $pair_root" >&2; exit 1; }
  node measurement/phase2/bin/verify-completed-run.mjs "$(winpath "$pair_root")" \
    > "$OUTPUT_ROOT/pair-$(printf '%02d' "$pair_number")-completion-verified.json"
  node - "$(winpath "$pair_root")" "$pair_id" "$order" "$MAX_INTER_SIDE_GAP_SECONDS" \
    "$pair_invoked_at" "$pair_returned_at" "$inter_pair_gap" >> "$OUTPUT_ROOT/pairs.jsonl" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, expectedId, expectedOrder, maxGapRaw, invokedAt, returnedAt, interPairGapRaw] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
const pair = JSON.parse(fs.readFileSync(path.join(root, "pair.json"), "utf8"));
const completion = JSON.parse(fs.readFileSync(path.join(root, "COMPLETED.json"), "utf8"));
const expectedSides = expectedOrder === "current-baseline" ? ["current", "baseline"] : ["baseline", "current"];
const validUtc = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
if (pair.status !== "COMPLETE" || pair.pair_id !== expectedId || pair.order !== expectedOrder) fail("pair identity/status mismatch");
if (!validUtc(pair.started_at) || !validUtc(pair.ended_at) || Date.parse(pair.ended_at) < Date.parse(pair.started_at)) fail("invalid pair UTC timestamps");
if (!Array.isArray(pair.sides) || pair.sides.length !== 2) fail("pair must contain exactly two sides");
for (let index = 0; index < 2; index += 1) {
  const side = pair.sides[index];
  if (side.sequence !== index + 1 || side.side !== expectedSides[index]) fail("side order/sequence mismatch");
  for (const key of ["restore_started_at", "started_at", "ended_at"]) if (!validUtc(side[key])) fail(`invalid ${side.side} ${key}`);
  if (Date.parse(side.started_at) < Date.parse(side.restore_started_at) || Date.parse(side.ended_at) < Date.parse(side.started_at)) fail(`invalid ${side.side} timestamp order`);
  if (!Number.isInteger(side.gap_from_previous_seconds) || side.gap_from_previous_seconds < 0 || side.gap_from_previous_seconds > Number(maxGapRaw)) fail(`invalid ${side.side} inter-side gap`);
  if (!/^[a-f0-9]{64}$/.test(side.database_fingerprint_before ?? "")) fail(`invalid ${side.side} database fingerprint`);
  if (side.database_fingerprint_before !== side.database_fingerprint_after) fail(`${side.side} changed the canonical database fingerprint`);
}
if (pair.sides[0].database_fingerprint_before !== pair.sides[1].database_fingerprint_before) fail("canonical restore fingerprints differ between sides");
if (completion.status !== "COMPLETE" || completion.side !== "pair" || completion.pair_id !== expectedId) fail("pair completion marker identity mismatch");
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  pair_id: expectedId,
  order: expectedOrder,
  wrapper_invoked_at_utc: invokedAt,
  wrapper_returned_at_utc: returnedAt,
  inter_pair_gap_seconds: Number(interPairGapRaw),
  pair_output: path.resolve(root),
  pair_started_at_utc: pair.started_at,
  pair_ended_at_utc: pair.ended_at,
  sides: pair.sides,
  canonical_database_fingerprint: pair.sides[0].database_fingerprint_before,
  status: "COMPLETE",
})}\n`);
NODE
  completed_pairs=$((completed_pairs + 1))
  printf '%s\tpair-returned\t%s\t%s\toutput=%s\n' \
    "$pair_returned_at" "$pair_id" "$order" "$pair_root" >> "$OUTPUT_ROOT/events.tsv"
done

stop_monitor
[[ "$MONITOR_EXIT_RECORDED" == true ]] || { echo "continuous monitor exit was not recorded" >&2; exit 1; }
node - "$(winpath "$OUTPUT_ROOT/quiet-host")" "$QUIET_MONITOR_INTERVAL_SECONDS" "$(winpath "$OUTPUT_ROOT/pairs.jsonl")" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, intervalRaw, pairsPath] = process.argv.slice(2);
const interval = Number(intervalRaw);
const samples = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^continuous-\d{6}$/.test(entry.name)).sort();
if (samples.length < 2) throw new Error("continuous monitor captured fewer than two samples");
const timestamps = samples.map((entry) => {
  const lines = fs.readFileSync(path.join(root, entry.name, "capture.env"), "utf8").trim().split(/\r?\n/);
  const value = lines.find((line) => line.startsWith("captured_at_utc="))?.slice("captured_at_utc=".length);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid monitor timestamp: ${entry.name}`);
  return {value, parsed};
});
for(let i=1;i<timestamps.length;i++) if(timestamps[i].parsed<=timestamps[i-1].parsed) throw new Error("continuous monitor timestamps are not strictly increasing");
const maximumGapSeconds=Math.max(...timestamps.slice(1).map((value,index)=>(value.parsed-timestamps[index].parsed)/1000));
if(maximumGapSeconds>interval*2) throw new Error(`continuous monitor gap ${maximumGapSeconds}s exceeds ${interval*2}s`);
const pairs=fs.readFileSync(pairsPath,"utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
if(!pairs.length) throw new Error("continuous monitor has no completed pair chronology");
const coverageStarted=pairs[0].wrapper_invoked_at_utc,coverageEnded=pairs.at(-1).wrapper_returned_at_utc;
if(timestamps[0].parsed>Date.parse(coverageStarted)||timestamps.at(-1).parsed+interval*2000<Date.parse(coverageEnded)) throw new Error("continuous monitor does not cover pair-set boundaries");
if (fs.readFileSync(path.join(root, "monitor-exit-status.txt"), "utf8").trim() !== "0") throw new Error("continuous monitor did not exit successfully");
fs.writeFileSync(path.join(root, "monitor-summary.json"), `${JSON.stringify({schema_version:1,interval_seconds:interval,sample_count:samples.length,first_sample_at_utc:timestamps[0].value,last_sample_at_utc:timestamps.at(-1).value,maximum_gap_seconds:maximumGapSeconds,coverage_started_at_utc:coverageStarted,coverage_ended_at_utc:coverageEnded,exit_status:0,passed:true},null,2)}\n`, {flag:"wx"});
NODE
[[ ! -s "$CONTAMINATION_FILE" ]] || { echo "continuous quiet-host contamination was detected" >&2; exit 1; }
[[ "$completed_pairs" -eq "$PAIR_COUNT" ]] || { echo "not all planned pairs completed" >&2; exit 1; }
[[ "$(sha256_file "$MANIFEST_SNAPSHOT")" == "$MANIFEST_SHA" ]] || { echo "immutable manifest snapshot changed" >&2; exit 1; }
[[ "$(sha256_file "$IMMUTABLE_INPUTS")" == "$INPUTS_SHA" ]] || { echo "immutable input record changed" >&2; exit 1; }

capture_snapshot final "$OUTPUT_ROOT/quiet-host/final"
evaluate_snapshot "$OUTPUT_ROOT/quiet-host/final" \
  "$QUIET_MAX_HOST_CPU_PERCENT" "$QUIET_MAX_HOST_MEMORY_PERCENT" \
  "$QUIET_MAX_HOST_DISK_PERCENT" "$QUIET_MAX_WSL_CPU_PERCENT" \
  "$QUIET_MAX_WSL_MEMORY_PERCENT"

printf '%s\tset-finalizing\t-\t-\tclosing orchestrator log before sealing\n' \
  "$(utc_now)" >> "$OUTPUT_ROOT/events.tsv"
exec 1>&3 2>&4
wait "$TEE_PID"
TEE_PID=
node measurement/phase2/bin/scan-evidence-secrets.mjs "$(winpath "$OUTPUT_ROOT")" "$(winpath "$OUTPUT_ROOT/secret-scan.json")"
node measurement/phase2/bin/finalize-pair-set.mjs \
  --dir "$(winpath "$OUTPUT_ROOT")" --output-id "$OUTPUT_ID" --pairs "$(winpath "$OUTPUT_ROOT/pairs.jsonl")" \
  --correctness-manifest-sha256 "$MANIFEST_SHA" --profile "$MEASUREMENT_PROFILE" \
  --pair-count "$PAIR_COUNT" --max-side-gap "$MAX_INTER_SIDE_GAP_SECONDS" \
  --max-pair-gap "$MAX_INTER_PAIR_GAP_SECONDS" --monitor-interval "$QUIET_MONITOR_INTERVAL_SECONDS" \
  --pair-quiet-cpu-limit "$QUIET_CPU_LIMIT_PERCENT" --pair-quiet-samples "$QUIET_SAMPLES" \
  --allowed-containers "$ALLOWED_RUNNING_CONTAINERS"
RUN_SUCCEEDED=true
echo "==> complete counterbalanced pair set: $OUTPUT_ROOT/PAIR-COMPLETED.json"
