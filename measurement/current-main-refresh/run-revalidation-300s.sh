#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_BASE_URL:?CORRECTNESS_BASE_URL is required}"
: "${CORRECTNESS_AUTH_STATE:?CORRECTNESS_AUTH_STATE is required}"
: "${CORRECTNESS_APP_CONTAINER:?CORRECTNESS_APP_CONTAINER is required}"
: "${CORRECTNESS_POSTGRES_CONTAINER:?CORRECTNESS_POSTGRES_CONTAINER is required}"
: "${CORRECTNESS_IMAGE_REFERENCE:?CORRECTNESS_IMAGE_REFERENCE is required}"
producer_begin revalidation-300s

SLUG="measure-revalidation-300s-$CORRECTNESS_RUN_ID"
PATHNAME="/$SLUG"
TITLE="Correctness 300 second backstop $CORRECTNESS_RUN_ID"
ORIGINAL="backstop-original-$CORRECTNESS_RUN_ID"
EDITED="backstop-db-edit-$CORRECTNESS_RUN_ID"
COOKIE="" PAGE_ID="" PAGE_ARMED=false RECOVERY_ALLOWED=false CLEANUP_INVOKED=false

psql_scalar() { docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 -tAc "$1" | tr -d '[:space:]'; }
api() {
  local method="$1" path="$2" out="$3" payload="${4:-}" status
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method" -H "Cookie: $COOKIE" -H 'Content-Type: application/json')
  [[ -n "$payload" ]] && args+=(--data-binary "@$payload")
  status="$(curl "${args[@]}" "$CORRECTNESS_BASE_URL$path")"; printf '%s\n' "$status" > "$out.status"
  [[ "$status" =~ ^2[0-9][0-9]$ ]]
}
capture() {
  local label="$1" status
  status="$(curl -sS -D "$PRODUCER_RAW/$label.headers" -o "$PRODUCER_RAW/$label.body.html" -w '%{http_code}' "$CORRECTNESS_BASE_URL$PATHNAME")"
  printf '%s\n' "$status" > "$PRODUCER_RAW/$label.status"; [[ "$status" == 200 ]]
  assert_private_no_store "$PRODUCER_RAW/$label.headers"
}
recover_id() {
  [[ "$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\"='$SLUG' AND \"path\"='$PATHNAME' AND \"title\"='$TITLE' AND \"sortOrder\"=9343;")" == 1 ]] || return 1
  psql_scalar "SELECT \"id\" FROM \"PageContent\" WHERE \"slug\"='$SLUG' AND \"path\"='$PATHNAME' AND \"title\"='$TITLE' AND \"sortOrder\"=9343;"
}
cleanup() {
  local original_status=$? failed=false count before_id after_id
  trap - EXIT; set +e
  if [[ "$PAGE_ARMED" == true ]]; then
    [[ -n "$PAGE_ID" ]] || { [[ "$RECOVERY_ALLOWED" == true ]] && PAGE_ID="$(recover_id 2>/dev/null)"; }
    if [[ "$PAGE_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
      printf '{"id":"%s","published":false}' "$PAGE_ID" > "$PRODUCER_RAW/cleanup-unpublish.request.json"
      api PATCH /api/admin/page-content "$PRODUCER_RAW/cleanup-unpublish.json" "$PRODUCER_RAW/cleanup-unpublish.request.json" || failed=true
      docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
        -c "DELETE FROM \"PageContent\" WHERE \"id\"='$PAGE_ID' AND \"slug\"='$SLUG' AND \"path\"='$PATHNAME' AND \"title\"='$TITLE' AND \"sortOrder\"=9343 AND \"published\"=false;" \
        > "$PRODUCER_RAW/cleanup-delete.txt" 2>&1 || failed=true
    else failed=true; fi
  fi
  before_id="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}' 2>/dev/null)"
  APP_IMAGE="$CORRECTNESS_IMAGE_REFERENCE" bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app \
    > "$PRODUCER_RAW/cleanup-recreate-app.txt" 2>&1 || failed=true
  producer_refresh_app_container || failed=true
  after_id="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}' 2>/dev/null)"
  [[ -n "$after_id" && "$after_id" != "$before_id" ]] || failed=true
  curl -fsS "$CORRECTNESS_BASE_URL/api/health" > "$PRODUCER_RAW/cleanup-health.json" || failed=true
  count="$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\"='$SLUG' OR \"path\"='$PATHNAME';" 2>/dev/null)"
  [[ "$count" == 0 ]] || failed=true
  printf '{"status":"%s","page_rows_after":%s,"container_recreated":%s,"audit_residue":"intentional"}\n' \
    "$([[ "$failed" == false ]] && echo passed || echo failed)" "${count:-null}" "$([[ -n "$after_id" && "$after_id" != "$before_id" ]] && echo true || echo false)" \
    > "$PRODUCER_RAW/backstop-cleanup.json"
  local final=1; [[ "$original_status" -eq 0 && "$failed" == false ]] && final=0
  if [[ "$CLEANUP_INVOKED" == true ]]; then return "$final"; fi
  exit "$final"
}
trap cleanup EXIT

COOKIE="$(node - "$CORRECTNESS_AUTH_STATE" <<'NODE'
const state = require(process.argv[2]);
const cookie = state.cookies.find((candidate) => candidate.name === "authjs.session-token");
if (!cookie?.value) throw new Error("admin session cookie missing");
process.stdout.write(`${cookie.name}=${cookie.value}`);
NODE
)"
[[ "$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\"='$SLUG' OR \"path\"='$PATHNAME';")" == 0 ]]
node - "$SLUG" "$TITLE" "$PRODUCER_RAW/create.request.json" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[4], JSON.stringify({ slug: process.argv[2], caption: process.argv[3], menuTitle: "", title: process.argv[3], headerText: "", sortOrder: 9343 }));
NODE
PAGE_ARMED=true; RECOVERY_ALLOWED=true
api POST /api/admin/page-content "$PRODUCER_RAW/create.json" "$PRODUCER_RAW/create.request.json"
PAGE_ID="$(node - "$PRODUCER_RAW/create.json" "$SLUG" <<'NODE'
const page=require(process.argv[2]).page;
if(typeof page?.id!=="string"||page.slug!==process.argv[3])throw new Error("create identity mismatch");process.stdout.write(page.id);
NODE
)"
[[ "$PAGE_ID" =~ ^[A-Za-z0-9_-]+$ ]]; RECOVERY_ALLOWED=false
node - "$PAGE_ID" "$SLUG" "$TITLE" "$ORIGINAL" "$PRODUCER_RAW/save-original.request.json" <<'NODE'
const fs=require("node:fs");fs.writeFileSync(process.argv[6],JSON.stringify({id:process.argv[2],slug:process.argv[3],caption:process.argv[4],menuTitle:"",title:process.argv[4],headerText:"",sortOrder:9343,contentHtml:`<p>${process.argv[5]}</p>`}));
NODE
api PUT /api/admin/page-content "$PRODUCER_RAW/save-original.json" "$PRODUCER_RAW/save-original.request.json"

capture store-miss
[[ "$(header_value "$PRODUCER_RAW/store-miss.headers" x-nextjs-cache)" == MISS ]]
grep -Fq "$ORIGINAL" "$PRODUCER_RAW/store-miss.body.html"
STORE_EPOCH="$(date +%s)"
capture warm-hit
[[ "$(header_value "$PRODUCER_RAW/warm-hit.headers" x-nextjs-cache)" == HIT ]]
cmp -s "$PRODUCER_RAW/store-miss.body.html" "$PRODUCER_RAW/warm-hit.body.html"

docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
  -c "UPDATE \"PageContent\" SET \"contentHtml\"='<p>$EDITED</p>' WHERE \"id\"='$PAGE_ID' AND \"slug\"='$SLUG' AND \"path\"='$PATHNAME';" \
  > "$PRODUCER_RAW/direct-db-edit.txt"
capture fresh-window-hit
[[ "$(header_value "$PRODUCER_RAW/fresh-window-hit.headers" x-nextjs-cache)" == HIT ]]
grep -Fq "$ORIGINAL" "$PRODUCER_RAW/fresh-window-hit.body.html"
! grep -Fq "$EDITED" "$PRODUCER_RAW/fresh-window-hit.body.html"

WAIT_SECONDS=$(( STORE_EPOCH + 315 - $(date +%s) ))
printf 'store_epoch=%s\nwait_seconds=%s\n' "$STORE_EPOCH" "$WAIT_SECONDS" > "$PRODUCER_RAW/wait-window.txt"
(( WAIT_SECONDS <= 0 )) || sleep "$WAIT_SECONDS"
capture expired-stale
[[ "$(header_value "$PRODUCER_RAW/expired-stale.headers" x-nextjs-cache)" == STALE ]]
grep -Fq "$ORIGINAL" "$PRODUCER_RAW/expired-stale.body.html"

REGENERATED=false
for attempt in $(seq 1 30); do
  capture "regenerated-$attempt"
  if grep -Fq "$EDITED" "$PRODUCER_RAW/regenerated-$attempt.body.html" && \
     [[ "$(header_value "$PRODUCER_RAW/regenerated-$attempt.headers" x-nextjs-cache)" == HIT ]]; then
    printf '%s\n' "$attempt" > "$PRODUCER_RAW/regenerated-attempt.txt"
    REGENERATED=true
    break
  fi
  sleep 1
done
[[ "$REGENERATED" == true ]] || { echo "stale route did not regenerate to an edited HIT" >&2; exit 1; }

docker logs --since "$PRODUCER_STARTED_AT" "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/app-scenario.log" 2>&1
producer_complete_cleanup cleanup "$PRODUCER_RAW/backstop-cleanup.json"
producer_write_cleanup_passed "unique backstop page deleted and app force-recreated from the exact image" \
  "backstop-cleanup.json" "cleanup-delete.txt" "cleanup-health.json"
STALE="$(producer_relative "$PRODUCER_RAW/expired-stale.headers")"
REGENERATED_EVIDENCE="$(producer_relative "$PRODUCER_RAW/regenerated-attempt.txt")"
WINDOW="$(producer_relative "$PRODUCER_RAW/wait-window.txt")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"BND-03","outcome":"PASS","assertions":["a direct DB edit stayed behind a fresh HIT, the first request after 315 seconds was STALE with the stored body, and a bounded follow-up became HIT with the edited body"],"evidence_paths":["$WINDOW","$STALE","$REGENERATED_EVIDENCE"]}
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
