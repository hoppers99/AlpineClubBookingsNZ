#!/usr/bin/env bash
# One fail-closed side of an orchestrated #2352 phase-2 pair. Operators call
# run-pair.sh, not this script directly.
set -euo pipefail
cd "$(dirname "$0")/../../.."
case "$(uname -s)" in MINGW*|MSYS*) ;; *) echo "run-phase2 requires the reviewed Git Bash on Windows environment" >&2; exit 2 ;; esac
ROOT="$(pwd)"

SIDE="${1:-}"
case "$SIDE" in current|baseline) ;; *) echo "usage: run-phase2.sh {current|baseline}" >&2; exit 1 ;; esac
: "${PAIR_ID:?run through run-pair.sh (PAIR_ID missing)}"
: "${PAIR_ORDER:?PAIR_ORDER missing}"
: "${PAIR_SEQUENCE:?PAIR_SEQUENCE missing}"
: "${PAIR_ROOT:?PAIR_ROOT missing}"
: "${CORRECTNESS_MANIFEST:?CORRECTNESS_MANIFEST missing}"
: "${SIDE_IMAGE_REFERENCE:?SIDE_IMAGE_REFERENCE missing}"
: "${DATABASE_FINGERPRINT_BEFORE:?DATABASE_FINGERPRINT_BEFORE missing}"
: "${HARNESS_MANIFEST:?HARNESS_MANIFEST missing}"
: "${HARNESS_MANIFEST_SHA256:?HARNESS_MANIFEST_SHA256 missing}"

IMAGE="$SIDE_IMAGE_REFERENCE"
BASE="http://localhost:8027"
APP=tacbookings-measure-app-1
PG=tacbookings-measure-postgres-1
CADDY=tacbookings-measure-caddy-1
MAILPIT=tacbookings-measure-mailpit-1
RUNS="${RUNS:-200}"
WARMUP="${WARMUP:-20}"
COLD_RUNS="${COLD_RUNS:-5}"
IDLE_CYCLES="${IDLE_CYCLES:-3}"
IDLE_SECONDS="${IDLE_SECONDS:-120}"
REVALIDATION_SECONDS="${REVALIDATION_SECONDS:-305}"
CONC="${CONC:-10}"
DURATION="${DURATION:-30}"
REQUEST_TIMEOUT_SECONDS="${REQUEST_TIMEOUT_SECONDS:-10}"
ROUTES=(/about / /join /contact)

for value in "$RUNS" "$WARMUP" "$COLD_RUNS" "$IDLE_CYCLES" "$IDLE_SECONDS" "$REVALIDATION_SECONDS" "$CONC" "$DURATION" "$REQUEST_TIMEOUT_SECONDS"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "all timing tunables must be positive integers" >&2; exit 1; }
done
[ "$IDLE_SECONDS" -lt 300 ] || { echo "IDLE_SECONDS must remain below the 300-second ISR age" >&2; exit 1; }
[ "$REVALIDATION_SECONDS" -ge 300 ] || { echo "REVALIDATION_SECONDS must be at least 300" >&2; exit 1; }

OUT="$PAIR_ROOT/$SIDE"
[ ! -e "$OUT" ] || { echo "refusing output collision: $OUT" >&2; exit 1; }
mkdir -p "$OUT"/{env,cold,warm,idle,revalidation,conc,segments,proofs}

cpu_usec() { docker exec "$APP" sh -c 'awk "/^usage_usec/{print \$2}" /sys/fs/cgroup/cpu.stat'; }
capture_cgroup() {
  local path="$1"
  docker exec "$APP" sh -c 'for f in cpu.stat memory.current memory.events memory.events.local memory.peak; do echo "@@ $f"; [ -r "/sys/fs/cgroup/$f" ] && cat "/sys/fs/cgroup/$f" || echo unavailable; done' > "$path"
}
ttfb_line() {
  curl --fail-with-body --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS" \
    -o /dev/null -w '%{http_code},%{time_starttransfer},%{time_total}\n' "$1"
}
safe_route() { local value="${1//\//_}"; [ "$value" = "_" ] && value=_root; printf '%s' "$value"; }
capture_proof() {
  local route="$1" phase="$2" expected_cache="${3:-}"
  local safe headers body proof
  safe="$(safe_route "$route")-${phase//\//_}"
  headers="$OUT/proofs/$safe.headers"
  body="$OUT/proofs/$safe.body"
  proof="$OUT/proofs/$safe.json"
  curl --fail-with-body --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS" \
    -D "$headers" -o "$body" "$BASE$route"
  local args=(--manifest "$CORRECTNESS_MANIFEST" --side "$SIDE" --route "$route" --phase "$phase" --headers "$headers" --body "$body" --out "$proof")
  [ -z "$expected_cache" ] || args+=(--expected-cache "$expected_cache")
  node measurement/phase2/bin/verify-http-proof.mjs "${args[@]}"
}
SAMPLER_PID=
cleanup_sampler() {
  if [ -n "${SAMPLER_PID:-}" ]; then
    kill "$SAMPLER_PID" 2>/dev/null || true
    wait "$SAMPLER_PID" 2>/dev/null || true
    SAMPLER_PID=
  fi
}
trap cleanup_sampler EXIT
trap 'cleanup_sampler; exit 130' INT
trap 'cleanup_sampler; exit 143' TERM
start_sampler() {
  local segment="$1"
  ( while true; do
      captured_at="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
      stats_snapshot="$(docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.PIDs}},{{.BlockIO}},{{.NetIO}}')"
      while IFS= read -r stats_line; do
        case "$stats_line" in tacbookings-measure-*) printf '%s,%s\n' "$captured_at" "$stats_line" ;; esac
      done <<< "$stats_snapshot"
      sleep 1
    done ) > "$OUT/segments/$segment-docker-stats.csv" 2> "$OUT/segments/$segment-docker-stats.stderr" &
  SAMPLER_PID=$!
}
stop_sampler() { cleanup_sampler; }
segment_start() {
  local segment="$1"
  date -u +%Y-%m-%dT%H:%M:%S.%NZ > "$OUT/segments/$segment-started-at.txt"
  capture_cgroup "$OUT/segments/$segment-cgroup-before.txt"
  docker inspect "$APP" --format '{{.RestartCount}}' > "$OUT/segments/$segment-restarts-before.txt"
  start_sampler "$segment"
}
segment_end() {
  local segment="$1"
  stop_sampler
  capture_cgroup "$OUT/segments/$segment-cgroup-after.txt"
  docker inspect "$APP" --format '{{.RestartCount}}' > "$OUT/segments/$segment-restarts-after.txt"
  docker logs --since "$(cat "$OUT/segments/$segment-started-at.txt")" "$APP" > "$OUT/segments/$segment-app.log" 2> "$OUT/segments/$segment-app-log.stderr"
  date -u +%Y-%m-%dT%H:%M:%S.%NZ > "$OUT/segments/$segment-ended-at.txt"
}

printf '{"schema_version":1,"pair_id":"%s","side":"%s","order":"%s","sequence":%s,"started_at":"%s","parameters":{"runs":%s,"warmup":%s,"cold_runs":%s,"idle_cycles":%s,"idle_seconds":%s,"revalidation_seconds":%s,"concurrency":%s,"duration_seconds":%s,"request_timeout_seconds":%s}}\n' \
  "$PAIR_ID" "$SIDE" "$PAIR_ORDER" "$PAIR_SEQUENCE" "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" \
  "$RUNS" "$WARMUP" "$COLD_RUNS" "$IDLE_CYCLES" "$IDLE_SECONDS" "$REVALIDATION_SECONDS" "$CONC" "$DURATION" "$REQUEST_TIMEOUT_SECONDS" > "$OUT/run-context.json"

echo "==> [$SIDE] immutable identity and environment"
docker image inspect "$IMAGE" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const x=JSON.parse(s)[0];console.log(JSON.stringify([{Id:x.Id,RepoDigests:x.RepoDigests,RepoTags:x.RepoTags,Created:x.Created,Architecture:x.Architecture,Os:x.Os,Config:{Labels:x.Config.Labels,User:x.Config.User,WorkingDir:x.Config.WorkingDir,Entrypoint:x.Config.Entrypoint,Cmd:x.Config.Cmd},RootFS:x.RootFS}],null,2))})' > "$OUT/env/image-inspect.json"
node measurement/phase2/bin/verify-binding.mjs --manifest "$CORRECTNESS_MANIFEST" --side "$SIDE" \
  --image-reference "$IMAGE" --image-inspect "$OUT/env/image-inspect.json" --out "$OUT/env/verified-binding.json"
[ "$(sha256sum "$HARNESS_MANIFEST" | awk '{print $1}')" = "$HARNESS_MANIFEST_SHA256" ] || { echo "frozen harness manifest changed" >&2; exit 1; }
node measurement/phase2/bin/verify-harness-manifest.mjs "$HARNESS_MANIFEST" > "$OUT/env/harness-verification.json"
cp "$HARNESS_MANIFEST" "$OUT/env/harness-files.sha256"
printf '%s\n' "$HARNESS_MANIFEST_SHA256" > "$OUT/env/harness-manifest-sha256.txt"
sha256sum "$CORRECTNESS_MANIFEST" > "$OUT/env/correctness-manifest.sha256"
git -C "$ROOT" rev-parse HEAD > "$OUT/env/harness-worktree-head.txt"
{ cmd //c ver 2>/dev/null || true; } > "$OUT/env/windows-ver.txt"
{ wsl.exe --version 2>/dev/null || true; } | tr -d '\0' > "$OUT/env/wsl-version.txt"
docker version > "$OUT/env/docker-version.txt" 2>&1
docker info > "$OUT/env/docker-info.txt" 2>&1
docker compose --env-file measurement/stack/.env.measure -p tacbookings-measure --project-directory "$ROOT" \
  -f docker-compose.yml -f measurement/stack/docker-compose.measure.yml config --no-interpolate > "$OUT/env/compose-config-uninterpolated.yml"

APP_IMAGE="$IMAGE" bash measurement/stack/measure-stack.sh app-image "$IMAGE" >/dev/null
docker inspect "$APP" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const x=JSON.parse(s)[0];console.log(JSON.stringify({Id:x.Id,Name:x.Name,Image:x.Image,Created:x.Created,Config:{Hostname:x.Config.Hostname,User:x.Config.User,Labels:x.Config.Labels,WorkingDir:x.Config.WorkingDir,Entrypoint:x.Config.Entrypoint,Cmd:x.Config.Cmd,Healthcheck:x.Config.Healthcheck},HostConfig:x.HostConfig,Mounts:x.Mounts,NetworkSettings:{Networks:x.NetworkSettings.Networks,Ports:x.NetworkSettings.Ports},RestartCount:x.RestartCount,State:x.State},null,2))})' > "$OUT/env/app-container-inspect.json"
EXPECTED_IMAGE_ID="$(node -e 'process.stdout.write(require(process.argv[1]).image_id)' "$OUT/env/verified-binding.json")"
RUNNING_IMAGE_ID="$(docker inspect "$APP" --format '{{.Image}}')"
[ "$RUNNING_IMAGE_ID" = "$EXPECTED_IMAGE_ID" ] || {
  echo "running container image mismatch: expected $EXPECTED_IMAGE_ID got $RUNNING_IMAGE_ID" >&2; exit 1;
}
printf '%s\n' "$DATABASE_FINGERPRINT_BEFORE" > "$OUT/env/database-fingerprint-before.txt"
docker inspect "$PG" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const x=JSON.parse(s)[0];console.log(JSON.stringify({Id:x.Id,Name:x.Name,Image:x.Image,Created:x.Created,Config:{Hostname:x.Config.Hostname,User:x.Config.User,Labels:x.Config.Labels,WorkingDir:x.Config.WorkingDir,Entrypoint:x.Config.Entrypoint,Cmd:x.Config.Cmd,Healthcheck:x.Config.Healthcheck},HostConfig:x.HostConfig,Mounts:x.Mounts,NetworkSettings:{Networks:x.NetworkSettings.Networks,Ports:x.NetworkSettings.Ports},RestartCount:x.RestartCount,State:x.State},null,2))})' > "$OUT/env/postgres-container-inspect.json"
for service in caddy mailpit; do
  if [ "$service" = caddy ]; then container="$CADDY"; else container="$MAILPIT"; fi
  docker inspect "$container" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const x=JSON.parse(s)[0];console.log(JSON.stringify({Id:x.Id,Name:x.Name,Image:x.Image,Created:x.Created,Config:{Image:x.Config.Image,Hostname:x.Config.Hostname,User:x.Config.User,Labels:x.Config.Labels,WorkingDir:x.Config.WorkingDir,Entrypoint:x.Config.Entrypoint,Cmd:x.Config.Cmd,Healthcheck:x.Config.Healthcheck},HostConfig:x.HostConfig,Mounts:x.Mounts,NetworkSettings:{Networks:x.NetworkSettings.Networks,Ports:x.NetworkSettings.Ports},RestartCount:x.RestartCount,State:x.State},null,2))})' > "$OUT/env/$service-container-inspect.json"
done
node - "$OUT/env/app-container-inspect.json" <<'NODE'
const fs = require("node:fs");
const app = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const host = app.HostConfig;
if (host.NanoCpus !== 1_000_000_000 || host.Memory !== 1_073_741_824 || host.ReadonlyRootfs !== true) {
  throw new Error(`app resource contract differs: NanoCpus=${host.NanoCpus} Memory=${host.Memory} ReadonlyRootfs=${host.ReadonlyRootfs}`);
}
if (!(host.SecurityOpt ?? []).includes("no-new-privileges:true")) throw new Error("app no-new-privileges resource contract is missing");
NODE
node - "$OUT/env/caddy-container-inspect.json" "$OUT/env/mailpit-container-inspect.json" <<'NODE'
const fs = require("node:fs");
const caddy = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const mailpit = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (caddy.Config.Image !== "caddy:2-alpine" || caddy.HostConfig.NanoCpus !== 200_000_000 || caddy.HostConfig.Memory !== 134_217_728) throw new Error("Caddy image/resource identity differs from the measurement contract");
if (mailpit.Config.Image !== "axllent/mailpit:v1.30.3" || mailpit.HostConfig.NanoCpus !== 200_000_000 || mailpit.HostConfig.Memory !== 134_217_728) throw new Error("Mailpit image/resource identity differs from the measurement contract");
NODE
docker network inspect tacbookings-measure_default > "$OUT/env/network-inspect.json"
docker port "$CADDY" 8027/tcp > "$OUT/env/caddy-port.txt"
grep -qx '127.0.0.1:8027' "$OUT/env/caddy-port.txt" || { echo "localhost:8027 is not bound by the measurement Caddy" >&2; exit 1; }
docker exec "$CADDY" caddy adapt --config /etc/caddy/Caddyfile --pretty > "$OUT/env/caddy-adapted.json" 2> "$OUT/env/caddy-adapt.stderr"
[ ! -s "$OUT/env/caddy-adapt.stderr" ] || { echo "Caddy adaptation emitted stderr" >&2; exit 1; }
node - "$OUT/env/caddy-adapted.json" <<'NODE'
const fs = require("node:fs");
const config = fs.readFileSync(process.argv[2], "utf8");
if (!config.includes('"app:3000"') || !config.includes('"listen"') || !config.includes(":8027")) throw new Error("measurement Caddy does not bind :8027 to app:3000");
NODE
docker exec "$APP" node -e 'const u=new URL(process.env.DATABASE_URL); console.log(JSON.stringify({protocol:u.protocol,host:u.hostname,port:u.port,database:u.pathname,connection_limit:u.searchParams.get("connection_limit"),pool_timeout:u.searchParams.get("pool_timeout")}))' > "$OUT/env/app-database-target.json"
docker exec "$APP" node -e 'require("node:dns").promises.lookup(new URL(process.env.DATABASE_URL).hostname,{all:true}).then(x=>console.log(JSON.stringify(x)))' > "$OUT/env/app-database-dns.json"
docker exec "$PG" psql -U tac -d tacbookings -tAc 'select current_database() || chr(44) || inet_server_addr() || chr(44) || inet_server_port();' > "$OUT/env/postgres-identity.csv"
PG_IP="$(docker inspect "$PG" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
node - "$OUT/env/app-database-target.json" "$OUT/env/app-database-dns.json" "$OUT/env/postgres-identity.csv" "$PG_IP" <<'NODE'
const fs = require("node:fs");
const [targetPath,dnsPath,identityPath,pgIp] = process.argv.slice(2);
const target = JSON.parse(fs.readFileSync(targetPath,"utf8"));
const dns = JSON.parse(fs.readFileSync(dnsPath,"utf8"));
const [database,address,port] = fs.readFileSync(identityPath,"utf8").trim().split(",");
if (target.host !== "postgres" || target.port !== "5432" || target.database !== "/tacbookings") throw new Error("app DATABASE_URL does not target the measurement Postgres service");
if (!dns.some((entry) => entry.address === pgIp) || address !== pgIp || database !== "tacbookings" || port !== "5432") throw new Error("app/Postgres service, DNS, network, and database identities do not match");
NODE
docker exec "$PG" psql -U tac -d tacbookings -tAc 'SHOW log_statement;' > "$OUT/env/pg-log-statement.txt"
grep -qx 'none' "$OUT/env/pg-log-statement.txt" || { echo "log_statement is not none" >&2; exit 1; }

echo "==> [$SIDE] cold-start segment"
: > "$OUT/cold/about.csv"
for i in $(seq 1 "$COLD_RUNS"); do
  bash measurement/stack/measure-stack.sh restart-app >/dev/null
  sleep 2
  ttfb_line "$BASE/about" >> "$OUT/cold/about.csv"
done

echo "==> [$SIDE] warm sequential segments"
: > "$OUT/warm/cpu-usec.csv"
for route in "${ROUTES[@]}"; do
  safe="$(safe_route "$route")"
  for _ in $(seq 1 "$WARMUP"); do ttfb_line "$BASE$route" >/dev/null; done
  capture_proof "$route" "warm-$safe-before"
  segment="warm-$safe"
  segment_start "$segment"
  cpu0="$(cpu_usec)"
  : > "$OUT/warm/$safe.csv"
  evidence_dir="$OUT/warm/evidence/$safe"
  mkdir -p "$evidence_dir"
  for sample in $(seq 1 "$RUNS"); do
    curl --fail-with-body --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS" \
      -D "$evidence_dir/sample-$sample.headers" -o "$evidence_dir/sample-$sample.body" \
      -w '%{http_code},%{time_starttransfer},%{time_total}\n' "$BASE$route" >> "$OUT/warm/$safe.csv"
  done
  cpu1="$(cpu_usec)"
  segment_end "$segment"
  echo "$route,$RUNS,$cpu0,$cpu1,$((cpu1-cpu0))" >> "$OUT/warm/cpu-usec.csv"
  node measurement/phase2/bin/verify-warm-block.mjs --manifest "$CORRECTNESS_MANIFEST" \
    --side "$SIDE" --route "$route" --evidence-dir "$evidence_dir" \
    --timing-csv "$OUT/warm/$safe.csv" --samples "$RUNS" --out "$OUT/warm/$safe-proof.json"
  capture_proof "$route" "warm-$safe-after"
done

echo "==> [$SIDE] isolated idle recovery cycles"
for cycle in $(seq 1 "$IDLE_CYCLES"); do
  cycle_dir="$OUT/idle/cycle-$cycle"
  mkdir "$cycle_dir"
  # Reset and warm per cycle so every idle window starts its own age clock and
  # cannot be contaminated by cumulative time crossing the 300-second age.
  bash measurement/stack/measure-stack.sh restart-app >/dev/null
  for _ in $(seq 1 "$WARMUP"); do ttfb_line "$BASE/about" >/dev/null; done
  capture_proof /about "idle-$cycle-before"
  segment="idle-$cycle"
  segment_start "$segment"
  window_cpu0="$(cpu_usec)"
  sleep "$IDLE_SECONDS"
  cpu0="$(cpu_usec)"
  curl --fail-with-body --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS" \
    -D "$cycle_dir/first.headers" -o "$cycle_dir/first.body" \
    -w '%{http_code},%{time_starttransfer},%{time_total}\n' "$BASE/about" > "$cycle_dir/first.csv"
  node measurement/phase2/bin/verify-http-proof.mjs --manifest "$CORRECTNESS_MANIFEST" --side "$SIDE" \
    --route /about --phase "idle-$cycle-first" --headers "$cycle_dir/first.headers" \
    --body "$cycle_dir/first.body" --out "$cycle_dir/first-proof.json"
  cpu1="$(cpu_usec)"
  window_cpu1="$(cpu_usec)"
  segment_end "$segment"
  echo "/about,1,$cpu0,$cpu1,$((cpu1-cpu0))" > "$cycle_dir/first-cpu-usec.csv"
  echo "/about,window,$window_cpu0,$window_cpu1,$((window_cpu1-window_cpu0))" > "$cycle_dir/window-cpu-usec.csv"
  capture_proof /about "idle-$cycle-after"
  : > "$cycle_dir/followup.csv"
  for _ in 1 2 3 4; do ttfb_line "$BASE/about" >> "$cycle_dir/followup.csv"; done
done

echo "==> [$SIDE] separate post-age revalidation segment"
bash measurement/stack/measure-stack.sh restart-app >/dev/null
for _ in $(seq 1 "$WARMUP"); do ttfb_line "$BASE/about" >/dev/null; done
capture_proof /about revalidation-before
segment_start revalidation
cpu0="$(cpu_usec)"
sleep "$REVALIDATION_SECONDS"
curl --fail-with-body --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS" \
  -D "$OUT/revalidation/first.headers" -o "$OUT/revalidation/first.body" \
  -w '%{http_code},%{time_starttransfer},%{time_total}\n' "$BASE/about" > "$OUT/revalidation/first.csv"
if [ "$SIDE" = current ]; then expected_revalidation=STALE; else expected_revalidation=ABSENT; fi
node measurement/phase2/bin/verify-http-proof.mjs --manifest "$CORRECTNESS_MANIFEST" --side "$SIDE" \
  --route /about --phase revalidation-first --headers "$OUT/revalidation/first.headers" \
  --body "$OUT/revalidation/first.body" --out "$OUT/revalidation/first-proof.json" \
  --expected-cache "$expected_revalidation"
if [ "$SIDE" = current ]; then
  regenerated=false
  for attempt in $(seq 1 30); do
    curl --fail-with-body --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS" \
      -D "$OUT/revalidation/attempt-$attempt.headers" -o "$OUT/revalidation/attempt-$attempt.body" "$BASE/about"
    node measurement/phase2/bin/verify-http-proof.mjs --manifest "$CORRECTNESS_MANIFEST" --side "$SIDE" \
      --route /about --phase "revalidation-attempt-$attempt" \
      --headers "$OUT/revalidation/attempt-$attempt.headers" --body "$OUT/revalidation/attempt-$attempt.body" \
      --out "$OUT/revalidation/attempt-$attempt-proof.json" --expected-cache 'STALE|HIT'
    cache_state="$(node -e 'process.stdout.write(require(process.argv[1]).next_cache)' "$OUT/revalidation/attempt-$attempt-proof.json")"
    if [ "$cache_state" = HIT ]; then
      cp "$OUT/revalidation/attempt-$attempt-proof.json" "$OUT/revalidation/regenerated-proof.json"
      regenerated=true
      break
    fi
    sleep 1
  done
  [ "$regenerated" = true ] || { echo "revalidation did not reach a confirmed regenerated HIT" >&2; exit 1; }
else
  capture_proof /about revalidation-recovered
fi
cpu1="$(cpu_usec)"
segment_end revalidation
echo "/about,1,$cpu0,$cpu1,$((cpu1-cpu0))" > "$OUT/revalidation/window-cpu-usec.csv"

echo "==> [$SIDE] concurrency segment"
capture_proof /about concurrency-before
segment_start concurrency
cpu0="$(cpu_usec)"
node measurement/phase2/bin/load.mjs --url "$BASE/about" --concurrency "$CONC" \
  --duration "$DURATION" --timeout-ms "$((REQUEST_TIMEOUT_SECONDS*1000))" > "$OUT/conc/about.json"
cpu1="$(cpu_usec)"
segment_end concurrency
echo "/about,conc,$cpu0,$cpu1,$((cpu1-cpu0))" > "$OUT/conc/cpu-usec.csv"
capture_proof /about concurrency-after

if [ -n "${PHASE2_FINGERPRINT_HOOK:-}" ]; then
  [ -x "$PHASE2_FINGERPRINT_HOOK" ] || { echo "fingerprint hook is not executable" >&2; exit 1; }
  "$PHASE2_FINGERPRINT_HOOK" "$SIDE" > "$OUT/env/database-fingerprint-after.txt"
else
  bash measurement/stack/measure-stack.sh database-fingerprint > "$OUT/env/database-fingerprint-after.txt"
fi
[ "$(tr -d '\r\n' < "$OUT/env/database-fingerprint-after.txt")" = "$DATABASE_FINGERPRINT_BEFORE" ] || {
  echo "$SIDE database fingerprint drifted during timing" >&2; exit 1;
}
echo "==> [$SIDE] summarising and sealing"
node measurement/phase2/bin/scan-evidence-secrets.mjs "$OUT" "$OUT/env/secret-scan.json"
node measurement/phase2/bin/summarise.mjs "$OUT" | tee "$OUT/summary.txt"
node measurement/phase2/bin/finalize-run.mjs --dir "$OUT" --side "$SIDE" --pair-id "$PAIR_ID" > "$OUT.finalization.json"
echo "==> [$SIDE] complete: $OUT"
