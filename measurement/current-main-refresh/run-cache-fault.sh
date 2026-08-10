#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_BASE_URL:?CORRECTNESS_BASE_URL is required}"
: "${CORRECTNESS_APP_CONTAINER:?CORRECTNESS_APP_CONTAINER is required}"
: "${CORRECTNESS_IMAGE_REFERENCE:?CORRECTNESS_IMAGE_REFERENCE is required}"
producer_begin cache-fault

FILLER="/app/.next/cache/.issue-2352-cache-fill-$CORRECTNESS_RUN_ID"
CLEANUP_INVOKED=false
FAULT_ARMED=false

cleanup() {
  local original_status=$? failed=false before_id after_id health_status
  trap - EXIT
  set +e
  before_id="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}' 2>/dev/null)"
  if [[ "$FAULT_ARMED" == true ]]; then
    docker exec "$CORRECTNESS_APP_CONTAINER" sh -eu -c '
      target="$1"
      case "$target" in /app/.next/cache/.issue-2352-cache-fill-*) ;; *) exit 91;; esac
      [ ! -L "$target" ] || exit 92
      [ ! -e "$target" ] || rm -f -- "$target"
      [ ! -e "$target" ]
    ' sh "$FILLER" > "$PRODUCER_RAW/cleanup-remove-filler.txt" 2>&1 || failed=true
  fi
  APP_IMAGE="$CORRECTNESS_IMAGE_REFERENCE" \
    bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app \
    > "$PRODUCER_RAW/cleanup-recreate-app.txt" 2>&1 || failed=true
  producer_refresh_app_container || failed=true
  after_id="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}' 2>/dev/null)"
  [[ -n "$after_id" && "$after_id" != "$before_id" ]] || failed=true
  health_status="$(curl -sS -o "$PRODUCER_RAW/cleanup-health.json" -w '%{http_code}' "$CORRECTNESS_BASE_URL/api/health" 2>/dev/null)"
  [[ "$health_status" == 200 ]] || failed=true
  docker exec "$CORRECTNESS_APP_CONTAINER" test ! -e "$FILLER" || failed=true
  node - "$PRODUCER_RAW/fault-cleanup.json" "$([[ "$failed" == false ]] && echo passed || echo failed)" "$before_id" "$after_id" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({
  status: process.argv[3], container_id_before_recovery: process.argv[4], container_id_after_recovery: process.argv[5],
  filler_absent: process.argv[3] === "passed", app_healthy: process.argv[3] === "passed",
}, null, 2) + "\n");
NODE
  local final_status=1
  [[ "$original_status" -eq 0 && "$failed" == false ]] && final_status=0
  if [[ "$CLEANUP_INVOKED" == true ]]; then return "$final_status"; fi
  exit "$final_status"
}
trap cleanup EXIT

docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{json .HostConfig.Tmpfs}}' > "$PRODUCER_RAW/tmpfs-config.json"
docker exec "$CORRECTNESS_APP_CONTAINER" sh -eu -c '
  [ -d /app/.next/cache ]
  [ -w /app/.next/cache ]
  [ ! -e "$1" ]
  df -Pk /app/.next/cache
' sh "$FILLER" > "$PRODUCER_RAW/df-before.txt"
node - "$PRODUCER_RAW/tmpfs-config.json" "$PRODUCER_RAW/df-before.txt" <<'NODE'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const options = config?.["/app/.next/cache"];
if (typeof options !== "string") throw new Error("/app/.next/cache is not a configured tmpfs");
const size = /(?:^|,)size=([^,]+)/.exec(options)?.[1];
if (!new Set(["64m", "67108864"]).has(String(size).toLowerCase())) throw new Error(`cache tmpfs is not exactly 64MiB: ${size}`);
const lines = fs.readFileSync(process.argv[3], "utf8").trim().split(/\r?\n/);
const fields = lines.at(-1).trim().split(/\s+/);
const bytes = Number(fields[1]) * 1024;
if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 64 * 1024 * 1024) throw new Error(`effective cache filesystem is not bounded to 64MiB: ${bytes}`);
NODE

# Start from an empty cache mount, then verify the same exact image came back.
ORIGINAL_ID="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}')"
APP_IMAGE="$CORRECTNESS_IMAGE_REFERENCE" \
  bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app \
  > "$PRODUCER_RAW/pre-fault-recreate-app.txt"
producer_refresh_app_container
EMPTY_ID="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}')"
EMPTY_IMAGE="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Image}}')"
[[ "$EMPTY_ID" != "$ORIGINAL_ID" && "$EMPTY_IMAGE" == "${CORRECTNESS_IMAGE_ID:?CORRECTNESS_IMAGE_ID is required}" ]]

FAULT_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
FAULT_ARMED=true
set +e
docker exec "$CORRECTNESS_APP_CONTAINER" sh -eu -c '
  target="$1"
  case "$target" in /app/.next/cache/.issue-2352-cache-fill-*) ;; *) exit 91;; esac
  [ ! -e "$target" ]
  dd if=/dev/zero of="$target" bs=1048576 count=128
' sh "$FILLER" > "$PRODUCER_RAW/fill.stdout.txt" 2> "$PRODUCER_RAW/fill.stderr.txt"
FILL_STATUS=$?
set -e
[[ "$FILL_STATUS" -ne 0 ]] || { echo "cache fill unexpectedly fit 128MiB in the 64MiB tmpfs" >&2; exit 1; }
printf '%s\n' "$FILL_STATUS" > "$PRODUCER_RAW/fill.exit-code.txt"
docker exec "$CORRECTNESS_APP_CONTAINER" df -Pk /app/.next/cache > "$PRODUCER_RAW/df-full.txt"
docker exec "$CORRECTNESS_APP_CONTAINER" sh -c 'wc -c < "$1"; test -f "$1"' sh "$FILLER" > "$PRODUCER_RAW/filler-bytes.txt"

for label in fault-first fault-second; do
  status="$(curl -sS -D "$PRODUCER_RAW/$label.headers" -o "$PRODUCER_RAW/$label.body.html" -w '%{http_code}' "$CORRECTNESS_BASE_URL/about")"
  printf '%s\n' "$status" > "$PRODUCER_RAW/$label.status"
  [[ "$status" == 200 ]] || { echo "$label returned HTTP $status" >&2; exit 1; }
  assert_private_no_store "$PRODUCER_RAW/$label.headers"
  ! grep -Fqi 'session-token' "$PRODUCER_RAW/$label.body.html"
done
cmp -s "$PRODUCER_RAW/fault-first.body.html" "$PRODUCER_RAW/fault-second.body.html"
docker logs --since "$FAULT_STARTED_AT" "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/app-fault.log" 2>&1
grep -Eiq 'ENOSPC|no space left on device' "$PRODUCER_RAW/app-fault.log" || {
  echo "the configured cache did not record an observed cache-write failure" >&2; exit 1;
}
docker stats --no-stream --format '{{json .}}' "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/docker-stats.jsonl"
docker exec "$CORRECTNESS_APP_CONTAINER" sh -c '
  for file in /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events; do
    printf "== %s ==\n" "$file"; cat "$file";
  done
' > "$PRODUCER_RAW/cgroup-memory.txt"

producer_complete_cleanup cleanup "$PRODUCER_RAW/fault-cleanup.json"
status="$(curl -sS -D "$PRODUCER_RAW/recovered.headers" -o "$PRODUCER_RAW/recovered.body.html" -w '%{http_code}' "$CORRECTNESS_BASE_URL/about")"
[[ "$status" == 200 ]]
assert_private_no_store "$PRODUCER_RAW/recovered.headers"
cmp -s "$PRODUCER_RAW/fault-first.body.html" "$PRODUCER_RAW/recovered.body.html"

producer_write_cleanup_passed "exact filler removed and app force-recreated from the same immutable image" \
  "fault-cleanup.json" "cleanup-recreate-app.txt" "cleanup-health.json"
FAULT_LOG="$(producer_relative "$PRODUCER_RAW/app-fault.log")"
FAULT_BODY="$(producer_relative "$PRODUCER_RAW/fault-first.body.html")"
TMPFS="$(producer_relative "$PRODUCER_RAW/tmpfs-config.json")"
MEMORY="$(producer_relative "$PRODUCER_RAW/cgroup-memory.txt")"
RECOVERY="$(producer_relative "$PRODUCER_RAW/fault-cleanup.json")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"MC-07","outcome":"PASS","assertions":["the actual 64MiB cache tmpfs refused a 128MiB write, two /about requests returned byte-identical private,no-store content, ENOSPC was observed, and exact-image recreation recovered"],"evidence_paths":["$FAULT_LOG","$FAULT_BODY","$RECOVERY"]},
  {"check_id":"MC-08A","outcome":"PASS","assertions":["container configuration and effective filesystem both bounded /app/.next/cache to at most 64MiB while cgroup memory remained observable during saturation"],"evidence_paths":["$TMPFS","$MEMORY","$RECOVERY"]}
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
