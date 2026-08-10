#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_BASE_URL:?CORRECTNESS_BASE_URL is required}"
: "${CORRECTNESS_AUTH_STATE:?CORRECTNESS_AUTH_STATE is required}"
: "${CORRECTNESS_APP_CONTAINER:?CORRECTNESS_APP_CONTAINER is required}"
: "${CORRECTNESS_POSTGRES_CONTAINER:?CORRECTNESS_POSTGRES_CONTAINER is required}"
: "${CORRECTNESS_IMAGE_REFERENCE:?CORRECTNESS_IMAGE_REFERENCE is required}"
: "${CORRECTNESS_IMAGE_ID:?CORRECTNESS_IMAGE_ID is required}"
: "${CORRECTNESS_COMPOSE_PROJECT:?CORRECTNESS_COMPOSE_PROJECT is required}"
producer_begin setup-transition

SLUG="measure-setup-transition-$CORRECTNESS_RUN_ID"
PATHNAME="/$SLUG"
TITLE="Setup transition evidence $CORRECTNESS_RUN_ID"
CONTENT_MARKER="setup-transition-open-$CORRECTNESS_RUN_ID"
COOKIE="" PAGE_ID="" PAGE_ARMED=false RECOVERY_ALLOWED=false THEME_ARMED=false CLEANUP_INVOKED=false
ORIGINAL_COMPLETED_AT=""

psql_scalar() { docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 -tAc "$1" | tr -d '\r\n'; }
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
  printf '%s\n' "$status" > "$PRODUCER_RAW/$label.status"
  [[ "$status" == 200 ]]; assert_private_no_store "$PRODUCER_RAW/$label.headers" "$label"
}
theme_request() {
  node - "$PRODUCER_RAW/theme-before.json" "$1" "$2" <<'NODE'
const fs=require("node:fs");const theme=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).theme;
const request={brandGold:theme.brandGold,brandDeep:theme.brandDeep,brandSafety:theme.brandSafety,headingFontKey:theme.headingFontKey,bodyFontKey:theme.bodyFontKey,logoUrl:theme.logoUrl??null,logoDataUrl:theme.logoDataUrl??null,rawCss:theme.rawCss??"",completeSetup:process.argv[4]==="true"};
fs.writeFileSync(process.argv[3],JSON.stringify(request));
NODE
}
recover_page_id() {
  [[ "$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\"='$SLUG' AND \"path\"='$PATHNAME' AND \"title\"='$TITLE' AND \"sortOrder\"=9344;")" == 1 ]] || return 1
  psql_scalar "SELECT \"id\" FROM \"PageContent\" WHERE \"slug\"='$SLUG' AND \"path\"='$PATHNAME' AND \"title\"='$TITLE' AND \"sortOrder\"=9344;"
}
cleanup() {
  local original_status=$? failed=false count before_id after_id
  trap - EXIT; set +e
  if [[ "$THEME_ARMED" == true ]]; then
    api PUT /api/admin/site-style "$PRODUCER_RAW/cleanup-theme-restore.json" "$PRODUCER_RAW/theme-complete.request.json" || failed=true
    if [[ "$ORIGINAL_COMPLETED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[T\ ][0-9:.+-]+$ ]]; then
      docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
        -c "UPDATE \"ClubTheme\" SET \"completedAt\"='$ORIGINAL_COMPLETED_AT'::timestamptz WHERE \"id\"='default';" \
        > "$PRODUCER_RAW/cleanup-completed-at-restore.txt" 2>&1 || failed=true
    else failed=true; fi
  fi
  if [[ "$PAGE_ARMED" == true ]]; then
    [[ -n "$PAGE_ID" ]] || { [[ "$RECOVERY_ALLOWED" == true ]] && PAGE_ID="$(recover_page_id 2>/dev/null)"; }
    if [[ "$PAGE_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
      printf '{"id":"%s","published":false}' "$PAGE_ID" > "$PRODUCER_RAW/cleanup-unpublish.request.json"
      api PATCH /api/admin/page-content "$PRODUCER_RAW/cleanup-unpublish.json" "$PRODUCER_RAW/cleanup-unpublish.request.json" || failed=true
      docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
        -c "DELETE FROM \"PageContent\" WHERE \"id\"='$PAGE_ID' AND \"slug\"='$SLUG' AND \"path\"='$PATHNAME' AND \"title\"='$TITLE' AND \"sortOrder\"=9344 AND \"published\"=false;" \
        > "$PRODUCER_RAW/cleanup-page-delete.txt" 2>&1 || failed=true
    else failed=true; fi
  fi
  before_id="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}' 2>/dev/null)"
  APP_IMAGE="$CORRECTNESS_IMAGE_REFERENCE" bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app \
    > "$PRODUCER_RAW/cleanup-recreate-app.txt" 2>&1 || failed=true
  producer_refresh_app_container || failed=true
  after_id="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}' 2>/dev/null)"
  [[ -n "$after_id" && "$after_id" != "$before_id" && "$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Image}}' 2>/dev/null)" == "$CORRECTNESS_IMAGE_ID" ]] || failed=true
  curl -fsS "$CORRECTNESS_BASE_URL/api/health" > "$PRODUCER_RAW/cleanup-health.json" || failed=true
  count="$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\"='$SLUG' OR \"path\"='$PATHNAME';" 2>/dev/null)"
  [[ "$count" == 0 ]] || failed=true
  if api GET /api/admin/site-style "$PRODUCER_RAW/theme-after-cleanup.json"; then
    node - "$PRODUCER_RAW/theme-before.json" "$PRODUCER_RAW/theme-after-cleanup.json" <<'NODE'
const fs=require("node:fs"),assert=require("node:assert/strict");const read=p=>JSON.parse(fs.readFileSync(p,"utf8")).theme;assert.deepStrictEqual(read(process.argv[2]),read(process.argv[3]));
NODE
    [[ $? -eq 0 ]] || failed=true
  else failed=true; fi
  printf '{"status":"%s","page_rows_after":%s,"theme_snapshot_restored":%s,"container_recreated":%s,"audit_residue":"intentional"}\n' \
    "$([[ "$failed" == false ]] && echo passed || echo failed)" "${count:-null}" "$([[ "$failed" == false ]] && echo true || echo false)" "$([[ -n "$after_id" && "$after_id" != "$before_id" ]] && echo true || echo false)" \
    > "$PRODUCER_RAW/setup-cleanup.json"
  local final=1; [[ "$original_status" -eq 0 && "$failed" == false ]] && final=0
  if [[ "$CLEANUP_INVOKED" == true ]]; then return "$final"; fi
  exit "$final"
}
trap cleanup EXIT

COOKIE="$(node - "$CORRECTNESS_AUTH_STATE" <<'NODE'
const state=require(process.argv[2]);const cookie=state.cookies.find((candidate)=>candidate.name==="authjs.session-token");if(!cookie?.value)throw new Error("admin session cookie missing");process.stdout.write(`${cookie.name}=${cookie.value}`);
NODE
)"
api GET /api/admin/site-style "$PRODUCER_RAW/theme-before.json"
ORIGINAL_COMPLETED_AT="$(psql_scalar "SELECT to_char(\"completedAt\" AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US') || '+00' FROM \"ClubTheme\" WHERE \"id\"='default';")"
[[ "$ORIGINAL_COMPLETED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+\+00$ ]] || { echo "setup-transition requires an initially complete default ClubTheme" >&2; exit 1; }
theme_request "$PRODUCER_RAW/theme-incomplete.request.json" false
theme_request "$PRODUCER_RAW/theme-complete.request.json" true

[[ "$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\"='$SLUG' OR \"path\"='$PATHNAME';")" == 0 ]]
node - "$SLUG" "$TITLE" "$PRODUCER_RAW/page-create.request.json" <<'NODE'
const fs=require("node:fs");fs.writeFileSync(process.argv[4],JSON.stringify({slug:process.argv[2],caption:process.argv[3],menuTitle:"",title:process.argv[3],headerText:"",sortOrder:9344}));
NODE
PAGE_ARMED=true; RECOVERY_ALLOWED=true
api POST /api/admin/page-content "$PRODUCER_RAW/page-create.json" "$PRODUCER_RAW/page-create.request.json"
PAGE_ID="$(node - "$PRODUCER_RAW/page-create.json" "$SLUG" <<'NODE'
const page=require(process.argv[2]).page;if(typeof page?.id!=="string"||page.slug!==process.argv[3])throw new Error("page create identity mismatch");process.stdout.write(page.id);
NODE
)"
[[ "$PAGE_ID" =~ ^[A-Za-z0-9_-]+$ ]]; RECOVERY_ALLOWED=false
node - "$PAGE_ID" "$SLUG" "$TITLE" "$CONTENT_MARKER" "$PRODUCER_RAW/page-save.request.json" <<'NODE'
const fs=require("node:fs");fs.writeFileSync(process.argv[6],JSON.stringify({id:process.argv[2],slug:process.argv[3],caption:process.argv[4],menuTitle:"",title:process.argv[4],headerText:"",sortOrder:9344,contentHtml:`<p>${process.argv[5]}</p>`}));
NODE
api PUT /api/admin/page-content "$PRODUCER_RAW/page-save.json" "$PRODUCER_RAW/page-save.request.json"

APP_IMAGE="$CORRECTNESS_IMAGE_REFERENCE" bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app > "$PRODUCER_RAW/scenario-recreate-app.txt"
producer_refresh_app_container
[[ "$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Image}}')" == "$CORRECTNESS_IMAGE_ID" ]]
docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{"app_image_id":"{{.Image}}","app_project":"{{index .Config.Labels "com.docker.compose.project"}}","app_service":"{{index .Config.Labels "com.docker.compose.service"}}"}' > "$PRODUCER_RAW/stack-binding.json"
node - "$PRODUCER_RAW/stack-binding.json" "$CORRECTNESS_IMAGE_ID" "$CORRECTNESS_COMPOSE_PROJECT" <<'NODE'
const row=require(process.argv[2]);if(row.app_image_id!==process.argv[3]||row.app_project!==process.argv[4]||row.app_service!=="app")throw new Error("setup-transition stack binding mismatch");
NODE

PRIME_TICK="$(docker exec "$CORRECTNESS_APP_CONTAINER" node -e 'process.stdout.write(String(process.hrtime.bigint()))')"
PRIME_STATUS="$(curl -sS -D "$PRODUCER_RAW/prime-complete.headers" -o "$PRODUCER_RAW/prime-complete.body.html" -w '%{http_code}' "$CORRECTNESS_BASE_URL/contact")"
[[ "$PRIME_STATUS" == 200 ]]
docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
  -c "UPDATE \"ClubTheme\" SET \"completedAt\"=NULL WHERE \"id\"='default';" > "$PRODUCER_RAW/direct-enter-pre-setup.txt"
THEME_ARMED=true
api PUT /api/admin/site-style "$PRODUCER_RAW/incomplete-transition.json" "$PRODUCER_RAW/theme-incomplete.request.json"
node - "$PRODUCER_RAW/incomplete-transition.json" <<'NODE'
if(require(process.argv[2])?.theme?.completedAt!==null)throw new Error("incomplete transition unexpectedly completed setup");
NODE
capture holding-miss
HOLDING_TICK="$(docker exec "$CORRECTNESS_APP_CONTAINER" node -e 'process.stdout.write(String(process.hrtime.bigint()))')"
ELAPSED_MS=$(( (HOLDING_TICK - PRIME_TICK) / 1000000 ))
printf 'setup_gate_prime_to_holding_miss_ms=%s\nsetup_gate_ttl_ms=15000\n' "$ELAPSED_MS" > "$PRODUCER_RAW/setup-gate-window.txt"
(( ELAPSED_MS >= 0 && ELAPSED_MS < 15000 )) || { echo "setup gate complete memo expired before the holding page render" >&2; exit 1; }
[[ "$(header_value "$PRODUCER_RAW/holding-miss.headers" x-nextjs-cache)" == MISS ]]
grep -Fq 'Site setup in progress' "$PRODUCER_RAW/holding-miss.body.html"
! grep -Fq "$CONTENT_MARKER" "$PRODUCER_RAW/holding-miss.body.html"
capture holding-hit
[[ "$(header_value "$PRODUCER_RAW/holding-hit.headers" x-nextjs-cache)" == HIT ]]
cmp -s "$PRODUCER_RAW/holding-miss.body.html" "$PRODUCER_RAW/holding-hit.body.html"

api PUT /api/admin/site-style "$PRODUCER_RAW/complete-transition.json" "$PRODUCER_RAW/theme-complete.request.json"
node - "$PRODUCER_RAW/complete-transition.json" <<'NODE'
if(typeof require(process.argv[2])?.theme?.completedAt!=="string")throw new Error("real site-style PUT did not complete setup");
NODE
capture opened-miss
[[ "$(header_value "$PRODUCER_RAW/opened-miss.headers" x-nextjs-cache)" == MISS ]]
grep -Fq "$CONTENT_MARKER" "$PRODUCER_RAW/opened-miss.body.html"
! grep -Fq 'Site setup in progress' "$PRODUCER_RAW/opened-miss.body.html"
capture opened-hit
[[ "$(header_value "$PRODUCER_RAW/opened-hit.headers" x-nextjs-cache)" == HIT ]]
cmp -s "$PRODUCER_RAW/opened-miss.body.html" "$PRODUCER_RAW/opened-hit.body.html"
! cmp -s "$PRODUCER_RAW/holding-hit.body.html" "$PRODUCER_RAW/opened-miss.body.html"

docker logs --since "$PRODUCER_STARTED_AT" "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/app-scenario.log" 2>&1
producer_complete_cleanup cleanup "$PRODUCER_RAW/setup-cleanup.json"
producer_write_cleanup_passed "unique CMS page deleted, exact functional theme/completion snapshot restored, and exact-image app recreated" \
  "setup-cleanup.json" "cleanup-page-delete.txt" "cleanup-completed-at-restore.txt" "theme-after-cleanup.json" "cleanup-health.json"
HOLDING="$(producer_relative "$PRODUCER_RAW/holding-hit.body.html")"
OPENED="$(producer_relative "$PRODUCER_RAW/opened-miss.body.html")"
WINDOW="$(producer_relative "$PRODUCER_RAW/setup-gate-window.txt")"
STACK="$(producer_relative "$PRODUCER_RAW/stack-binding.json")"
CLEANUP="$(producer_relative "$PRODUCER_RAW/setup-cleanup.json")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"BND-10","outcome":"PASS","assertions":["inside the setup gate's measured 15-second complete-state memo, an incomplete ClubTheme produced a stored CMS holding page (MISS then byte-identical HIT); the real authenticated site-style completeSetup PUT invalidated it and the next request was a MISS containing only the unique live CMS content, followed by a stable HIT"],"evidence_paths":["$HOLDING","$OPENED","$WINDOW","$STACK","$CLEANUP"]}
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
