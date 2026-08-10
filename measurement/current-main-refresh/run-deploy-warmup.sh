#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_BASE_URL:?CORRECTNESS_BASE_URL is required}"
: "${CORRECTNESS_APP_CONTAINER:?CORRECTNESS_APP_CONTAINER is required}"
: "${CORRECTNESS_IMAGE_REFERENCE:?CORRECTNESS_IMAGE_REFERENCE is required}"
: "${CORRECTNESS_IMAGE_ID:?CORRECTNESS_IMAGE_ID is required}"
producer_begin deploy-warmup

CLEANUP_INVOKED=false
cleanup() {
  local original_status=$? failed=false before_id after_id
  trap - EXIT; set +e
  before_id="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}' 2>/dev/null)"
  APP_IMAGE="$CORRECTNESS_IMAGE_REFERENCE" bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app \
    > "$PRODUCER_RAW/cleanup-recreate-app.txt" 2>&1 || failed=true
  producer_refresh_app_container || failed=true
  after_id="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}' 2>/dev/null)"
  [[ -n "$after_id" && "$after_id" != "$before_id" ]] || failed=true
  [[ "$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Image}}' 2>/dev/null)" == "$CORRECTNESS_IMAGE_ID" ]] || failed=true
  curl -fsS "$CORRECTNESS_BASE_URL/api/health" > "$PRODUCER_RAW/cleanup-health.json" 2>&1 || failed=true
  printf '{"status":"%s","container_id_before":"%s","container_id_after":"%s","cache_cleared_by_recreation":%s}\n' \
    "$([[ "$failed" == false ]] && echo passed || echo failed)" "$before_id" "$after_id" "$([[ "$failed" == false ]] && echo true || echo false)" \
    > "$PRODUCER_RAW/warmup-cleanup.json"
  local final=1; [[ "$original_status" -eq 0 && "$failed" == false ]] && final=0
  if [[ "$CLEANUP_INVOKED" == true ]]; then return "$final"; fi
  exit "$final"
}
trap cleanup EXIT

ANON_STATUS="$(curl -sS -D "$PRODUCER_RAW/anonymous.headers" -o "$PRODUCER_RAW/anonymous.body.json" -w '%{http_code}' "$CORRECTNESS_BASE_URL/api/deploy/warmup?format=json")"
printf '%s\n' "$ANON_STATUS" > "$PRODUCER_RAW/anonymous.status"
[[ "$ANON_STATUS" == 401 ]] || { echo "anonymous deploy warm-up returned HTTP $ANON_STATUS, expected 401" >&2; exit 1; }

docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{"container_id":"{{.Id}}","image_id":"{{.Image}}"}' > "$PRODUCER_RAW/container-identity.json"
docker exec -i "$CORRECTNESS_APP_CONTAINER" node --input-type=module - <<'NODE' > "$PRODUCER_RAW/direct-report.json"
const secret = process.env.CRON_SECRET;
if (!secret) throw new Error("CRON_SECRET is absent in the target container");
const response = await fetch("http://127.0.0.1:3000/api/deploy/warmup?format=json&concurrency=2", { headers: { "x-cron-secret": secret } });
const body = await response.text();
let report; try { report = JSON.parse(body); } catch { throw new Error("warm-up response was not JSON"); }
process.stdout.write(JSON.stringify({ status: response.status, cache_control: response.headers.get("cache-control"), content_type: response.headers.get("content-type"), report }, null, 2) + "\n");
NODE
docker exec -i "$CORRECTNESS_APP_CONTAINER" node --input-type=module - <<'NODE' > "$PRODUCER_RAW/direct-report.txt.json"
const secret = process.env.CRON_SECRET;
if (!secret) throw new Error("CRON_SECRET is absent in the target container");
const response = await fetch("http://127.0.0.1:3000/api/deploy/warmup?format=text&concurrency=2", { headers: { "x-cron-secret": secret } });
process.stdout.write(JSON.stringify({ status: response.status, cache_control: response.headers.get("cache-control"), content_type: response.headers.get("content-type"), body: await response.text() }, null, 2) + "\n");
NODE

node measurement/current-main-refresh/bin/analyse-deploy-warmup.mjs \
  --json-response "$PRODUCER_RAW/direct-report.json" --text-response "$PRODUCER_RAW/direct-report.txt.json" \
  --container "$PRODUCER_RAW/container-identity.json" --image-id "$CORRECTNESS_IMAGE_ID" --out "$PRODUCER_RAW/analysis.json"
docker logs --since "$PRODUCER_STARTED_AT" "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/app-scenario.log" 2>&1

producer_complete_cleanup cleanup "$PRODUCER_RAW/warmup-cleanup.json"
producer_write_cleanup_passed "warm-up was read-only apart from target-local cache population; exact-image recreation cleared that cache" \
  "warmup-cleanup.json" "cleanup-recreate-app.txt" "cleanup-health.json"
ANALYSIS="$(producer_relative "$PRODUCER_RAW/analysis.json")"
DIRECT="$(producer_relative "$PRODUCER_RAW/direct-report.json")"
IDENTITY="$(producer_relative "$PRODUCER_RAW/container-identity.json")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"MC-10","outcome":"PASS","assertions":["anonymous access was refused; the selected container directly warmed every discovered critical and CMS route through 127.0.0.1:3000 with complete rendering and applicable-cache verification, then emitted both JSON pass and the text pass sentinel"],"evidence_paths":["$ANALYSIS","$DIRECT","$IDENTITY"]}
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
