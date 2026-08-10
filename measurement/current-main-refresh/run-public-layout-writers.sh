#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_BASE_URL:?CORRECTNESS_BASE_URL is required}"
: "${CORRECTNESS_AUTH_STATE:?CORRECTNESS_AUTH_STATE is required}"
: "${CORRECTNESS_APP_CONTAINER:?CORRECTNESS_APP_CONTAINER is required}"
: "${CORRECTNESS_POSTGRES_CONTAINER:?CORRECTNESS_POSTGRES_CONTAINER is required}"
: "${CORRECTNESS_IMAGE_REFERENCE:?CORRECTNESS_IMAGE_REFERENCE is required}"
producer_begin public-layout-writers

COOKIE="" THEME_TOUCHED=false IDENTITY_TOUCHED=false BANNER_ARMED=false BANNER_ID="" CLEANUP_INVOKED=false
BANNER_V1="layout-banner-v1-$CORRECTNESS_RUN_ID" BANNER_V2="layout-banner-v2-$CORRECTNESS_RUN_ID"

api() {
  local method="$1" path="$2" out="$3" payload="${4:-}" status
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method" -H "Cookie: $COOKIE" -H 'Content-Type: application/json')
  [[ -n "$payload" ]] && args+=(--data-binary "@$payload")
  status="$(curl "${args[@]}" "$CORRECTNESS_BASE_URL$path")"; printf '%s\n' "$status" > "$out.status"
  [[ "$status" =~ ^2[0-9][0-9]$ ]]
}
capture_about() {
  local label="$1" status
  status="$(curl -sS -D "$PRODUCER_RAW/$label.headers" -o "$PRODUCER_RAW/$label.body.html" -w '%{http_code}' "$CORRECTNESS_BASE_URL/about")"
  [[ "$status" == 200 ]]; assert_private_no_store "$PRODUCER_RAW/$label.headers"
}
theme_request() {
  node - "$1" "$2" "${3:-}" <<'NODE'
const fs=require("node:fs");const theme=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).theme;
const request={brandGold:theme.brandGold,brandDeep:theme.brandDeep,brandSafety:theme.brandSafety,headingFontKey:theme.headingFontKey,bodyFontKey:theme.bodyFontKey,logoUrl:theme.logoUrl??null,logoDataUrl:theme.logoDataUrl??null,rawCss:theme.rawCss??""};
if(process.argv[4])request.brandGold=process.argv[4];fs.writeFileSync(process.argv[3],JSON.stringify(request));
NODE
}
recover_banner() {
  api GET /api/admin/site-banners "$PRODUCER_RAW/banner-recovery-list.json" || return 1
  node - "$PRODUCER_RAW/banner-recovery-list.json" "$BANNER_V1" "$BANNER_V2" <<'NODE'
const fs=require("node:fs");const body=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));const rows=body.banners??body;
const found=rows.filter((row)=>row?.message===process.argv[3]||row?.message===process.argv[4]);
if(found.length!==1||typeof found[0].id!=="string"||!/^[A-Za-z0-9_-]+$/.test(found[0].id))throw new Error(`banner recovery found ${found.length}`);process.stdout.write(found[0].id);
NODE
}
cleanup() {
  local original_status=$? failed=false before_id after_id
  trap - EXIT; set +e
  if [[ "$BANNER_ARMED" == true && -z "$BANNER_ID" ]]; then BANNER_ID="$(recover_banner 2>/dev/null)" || failed=true; fi
  if [[ -n "$BANNER_ID" ]]; then api DELETE "/api/admin/site-banners/$BANNER_ID" "$PRODUCER_RAW/cleanup-banner-delete.json" || failed=true; fi
  if [[ "$IDENTITY_TOUCHED" == true ]]; then
    api PUT /api/admin/club-identity "$PRODUCER_RAW/cleanup-identity-restore.json" "$PRODUCER_RAW/identity-original.request.json" || failed=true
  fi
  if [[ "$THEME_TOUCHED" == true ]]; then
    api PUT /api/admin/site-style "$PRODUCER_RAW/cleanup-theme-restore.json" "$PRODUCER_RAW/theme-original.request.json" || failed=true
  fi
  before_id="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}' 2>/dev/null)"
  APP_IMAGE="$CORRECTNESS_IMAGE_REFERENCE" bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app \
    > "$PRODUCER_RAW/cleanup-recreate-app.txt" 2>&1 || failed=true
  producer_refresh_app_container || failed=true
  after_id="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}' 2>/dev/null)"
  [[ -n "$after_id" && "$after_id" != "$before_id" ]] || failed=true
  curl -fsS "$CORRECTNESS_BASE_URL/api/health" > "$PRODUCER_RAW/cleanup-health.json" || failed=true
  if api GET /api/admin/site-style "$PRODUCER_RAW/theme-after-cleanup.json" && api GET /api/admin/club-identity "$PRODUCER_RAW/identity-after-cleanup.json"; then
    node - "$PRODUCER_RAW/theme-before.json" "$PRODUCER_RAW/theme-after-cleanup.json" "$PRODUCER_RAW/identity-before.json" "$PRODUCER_RAW/identity-after-cleanup.json" <<'NODE'
const fs=require("node:fs"),assert=require("node:assert/strict");const read=(p)=>JSON.parse(fs.readFileSync(p,"utf8"));
assert.deepStrictEqual(read(process.argv[2]).theme,read(process.argv[3]).theme);assert.deepStrictEqual(read(process.argv[4]).settings,read(process.argv[5]).settings);
NODE
    [[ $? -eq 0 ]] || failed=true
  else failed=true; fi
  printf '{"status":"%s","container_recreated":%s,"audit_residue":"intentional"}\n' \
    "$([[ "$failed" == false ]] && echo passed || echo failed)" "$([[ -n "$after_id" && "$after_id" != "$before_id" ]] && echo true || echo false)" > "$PRODUCER_RAW/layout-cleanup.json"
  local final=1; [[ "$original_status" -eq 0 && "$failed" == false ]] && final=0
  if [[ "$CLEANUP_INVOKED" == true ]]; then return "$final"; fi
  exit "$final"
}
trap cleanup EXIT

COOKIE="$(node - "$CORRECTNESS_AUTH_STATE" <<'NODE'
const state=require(process.argv[2]);const c=state.cookies.find((v)=>v.name==="authjs.session-token");if(!c?.value)throw new Error("admin session cookie missing");process.stdout.write(`${c.name}=${c.value}`);
NODE
)"
api GET /api/admin/site-style "$PRODUCER_RAW/theme-before.json"
api GET /api/admin/club-identity "$PRODUCER_RAW/identity-before.json"
theme_request "$PRODUCER_RAW/theme-before.json" "$PRODUCER_RAW/theme-original.request.json"
node - "$PRODUCER_RAW/identity-before.json" "$PRODUCER_RAW/identity-original.request.json" <<'NODE'
const fs=require("node:fs");fs.writeFileSync(process.argv[3],JSON.stringify(JSON.parse(fs.readFileSync(process.argv[2],"utf8")).settings));
NODE

capture_about initial-miss
capture_about initial-hit
[[ "$(header_value "$PRODUCER_RAW/initial-hit.headers" x-nextjs-cache)" == HIT ]]
cmp -s "$PRODUCER_RAW/initial-miss.body.html" "$PRODUCER_RAW/initial-hit.body.html"

NEW_GOLD="$(node - "$PRODUCER_RAW/theme-before.json" <<'NODE'
const t=require(process.argv[2]).theme;process.stdout.write(String(t.brandGold).toLowerCase()==="#d4a72c"?"#b7791f":"#d4a72c");
NODE
)"
theme_request "$PRODUCER_RAW/theme-before.json" "$PRODUCER_RAW/theme-change.request.json" "$NEW_GOLD"
THEME_TOUCHED=true
api PUT /api/admin/site-style "$PRODUCER_RAW/theme-change.json" "$PRODUCER_RAW/theme-change.request.json"
node - "$PRODUCER_RAW/theme-change.json" "$NEW_GOLD" <<'NODE'
const body=require(process.argv[2]);if(String(body?.theme?.brandGold).toLowerCase()!==process.argv[3])throw new Error("theme write was normalized away from the selected value");
NODE
capture_about after-theme
[[ "$(header_value "$PRODUCER_RAW/after-theme.headers" x-nextjs-cache)" == MISS ]]
! cmp -s "$PRODUCER_RAW/initial-hit.body.html" "$PRODUCER_RAW/after-theme.body.html"
api PUT /api/admin/site-style "$PRODUCER_RAW/theme-restore.json" "$PRODUCER_RAW/theme-original.request.json"
THEME_TOUCHED=false
capture_about after-theme-restore
[[ "$(header_value "$PRODUCER_RAW/after-theme-restore.headers" x-nextjs-cache)" == MISS ]]
cmp -s "$PRODUCER_RAW/initial-hit.body.html" "$PRODUCER_RAW/after-theme-restore.body.html"

node - "$PRODUCER_RAW/identity-before.json" "$BANNER_V1" "$PRODUCER_RAW/identity-change.request.json" <<'NODE'
const fs=require("node:fs");const settings=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).settings;settings.name=process.argv[3];fs.writeFileSync(process.argv[4],JSON.stringify(settings));
NODE
IDENTITY_TOUCHED=true
api PUT /api/admin/club-identity "$PRODUCER_RAW/identity-change.json" "$PRODUCER_RAW/identity-change.request.json"
capture_about after-identity
[[ "$(header_value "$PRODUCER_RAW/after-identity.headers" x-nextjs-cache)" == MISS ]]
grep -Fq "$BANNER_V1" "$PRODUCER_RAW/after-identity.body.html"
api PUT /api/admin/club-identity "$PRODUCER_RAW/identity-restore.json" "$PRODUCER_RAW/identity-original.request.json"
IDENTITY_TOUCHED=false
capture_about after-identity-restore
[[ "$(header_value "$PRODUCER_RAW/after-identity-restore.headers" x-nextjs-cache)" == MISS ]]
! grep -Fq "$BANNER_V1" "$PRODUCER_RAW/after-identity-restore.body.html"

NZ_DATE="$(node -e 'const p=Object.fromEntries(new Intl.DateTimeFormat("en-NZ",{timeZone:"Pacific/Auckland",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts().map(v=>[v.type,v.value]));process.stdout.write(`${p.year}-${p.month}-${p.day}`)')"
node - "$BANNER_V1" "$NZ_DATE" "$PRODUCER_RAW/banner-create.request.json" <<'NODE'
const fs=require("node:fs");fs.writeFileSync(process.argv[4],JSON.stringify({message:process.argv[2],priority:"NOTIFY",startDate:process.argv[3],endDate:process.argv[3],active:true}));
NODE
BANNER_ARMED=true
api POST /api/admin/site-banners "$PRODUCER_RAW/banner-create.json" "$PRODUCER_RAW/banner-create.request.json"
BANNER_ID="$(node - "$PRODUCER_RAW/banner-create.json" <<'NODE'
const id=require(process.argv[2])?.banner?.id;if(typeof id!=="string"||!/^[A-Za-z0-9_-]+$/.test(id))throw new Error("invalid banner id");process.stdout.write(id);
NODE
)"
capture_about after-banner-create
[[ "$(header_value "$PRODUCER_RAW/after-banner-create.headers" x-nextjs-cache)" == MISS ]]
grep -Fq "$BANNER_V1" "$PRODUCER_RAW/after-banner-create.body.html"
printf '{"message":"%s"}' "$BANNER_V2" > "$PRODUCER_RAW/banner-update.request.json"
api PATCH "/api/admin/site-banners/$BANNER_ID" "$PRODUCER_RAW/banner-update.json" "$PRODUCER_RAW/banner-update.request.json"
capture_about after-banner-update
[[ "$(header_value "$PRODUCER_RAW/after-banner-update.headers" x-nextjs-cache)" == MISS ]]
grep -Fq "$BANNER_V2" "$PRODUCER_RAW/after-banner-update.body.html"; ! grep -Fq "$BANNER_V1" "$PRODUCER_RAW/after-banner-update.body.html"
api DELETE "/api/admin/site-banners/$BANNER_ID" "$PRODUCER_RAW/banner-delete.json"
BANNER_ID=""; BANNER_ARMED=false
capture_about after-banner-delete
[[ "$(header_value "$PRODUCER_RAW/after-banner-delete.headers" x-nextjs-cache)" == MISS ]]
! grep -Fq "$BANNER_V2" "$PRODUCER_RAW/after-banner-delete.body.html"

docker logs --since "$PRODUCER_STARTED_AT" "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/app-scenario.log" 2>&1
producer_complete_cleanup cleanup "$PRODUCER_RAW/layout-cleanup.json"
producer_write_cleanup_passed "theme and identity restored exactly, unique banner deleted, app recreated" \
  "layout-cleanup.json" "theme-after-cleanup.json" "identity-after-cleanup.json" "cleanup-health.json"
THEME="$(producer_relative "$PRODUCER_RAW/after-theme.body.html")"
IDENTITY="$(producer_relative "$PRODUCER_RAW/after-identity.body.html")"
BANNER="$(producer_relative "$PRODUCER_RAW/after-banner-update.body.html")"
CLEANUP="$(producer_relative "$PRODUCER_RAW/layout-cleanup.json")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"MC-04A","outcome":"PASS","assertions":["theme PUT replaced an already warm /about body on the next MISS and restoring the snapshot restored the exact original body"],"evidence_paths":["$THEME","$CLEANUP"]},
  {"check_id":"MC-04B","outcome":"PASS","assertions":["club identity PUT replaced an already warm /about body with the exact marker on the next MISS and restored cleanly"],"evidence_paths":["$IDENTITY","$CLEANUP"]},
  {"check_id":"MC-04C","outcome":"PASS","assertions":["banner create, update, and delete each replaced the already warm /about route on the next MISS with the exact expected body"],"evidence_paths":["$BANNER","$CLEANUP"]}
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
