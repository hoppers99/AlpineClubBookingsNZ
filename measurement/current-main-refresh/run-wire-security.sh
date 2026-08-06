#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_BASE_URL:?CORRECTNESS_BASE_URL is required}"
: "${CORRECTNESS_APP_CONTAINER:?CORRECTNESS_APP_CONTAINER is required}"
producer_begin wire-security

SUMMARY="$PRODUCER_RAW/summary.txt"
: > "$SUMMARY"
log() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }
safe_name() { printf '%s' "${1#/}" | sed 's#[^A-Za-z0-9._-]#_#g; s#^$#root#'; }

capture() {
  local route="$1" variant="$2" method="${3:-GET}" header="${4:-}"
  local safe status
  safe="$(safe_name "$route")-$variant"
  local -a args=(-sS -D "$PRODUCER_RAW/$safe.headers" -o "$PRODUCER_RAW/$safe.body" -w '%{http_code}')
  [[ "$method" == HEAD ]] && args+=(-I)
  [[ -n "$header" ]] && args+=(-H "$header")
  status="$(curl "${args[@]}" "$CORRECTNESS_BASE_URL$route")"
  [[ "$status" =~ ^[234][0-9][0-9]$ ]] || { log "FAIL $route $variant returned HTTP $status"; return 1; }
  printf '%s\n' "$status" > "$PRODUCER_RAW/$safe.status"
  assert_private_no_store "$PRODUCER_RAW/$safe.headers"
}

for route in /pay /dashboard/nope /admin/typo /definitely-missing /API/x.png; do
  capture "$route" generate
  capture "$route" stored
  capture "$route" head HEAD
  capture "$route" stale-hint GET 'Cookie: signed-in-hint=1'
  safe="$(safe_name "$route")-stale-hint"
  marker_cookie="$(header_value "$PRODUCER_RAW/$safe.headers" set-cookie)"
  [[ "$marker_cookie" == *signed-in-hint* ]] || { log "FAIL $route did not expire the marker cookie"; exit 1; }
  log "PASS $route generated/stored/HEAD/stale-hint variants stayed private,no-store"
done

for route in /robots.txt /sitemap.xml; do
  safe="$(safe_name "$route")"
  status="$(curl -sS -D "$PRODUCER_RAW/$safe.headers" -o "$PRODUCER_RAW/$safe.body" -w '%{http_code}' "$CORRECTNESS_BASE_URL$route")"
  [[ "$status" == 200 ]] || { log "FAIL $route returned HTTP $status"; exit 1; }
  cache="$(header_value "$PRODUCER_RAW/$safe.headers" cache-control)"
  [[ "${cache,,}" != *s-maxage* && "${cache,,}" != *31536000* ]] || { log "FAIL $route is long/shared-cacheable: $cache"; exit 1; }
  log "PASS $route has no long/shared cache directive"
done

status="$(curl -sS -D "$PRODUCER_RAW/real-image.headers" -o "$PRODUCER_RAW/real-image.body" -w '%{http_code}' \
  -H 'Cookie: signed-in-hint=1' "$CORRECTNESS_BASE_URL/branding/favicon.example.ico")"
[[ "$status" == 200 ]] || { log "FAIL real static image returned HTTP $status"; exit 1; }
image_cache="$(header_value "$PRODUCER_RAW/real-image.headers" cache-control)"
image_cookie="$(header_value "$PRODUCER_RAW/real-image.headers" set-cookie)"
[[ "${image_cache,,}" != *no-store* && "$image_cookie" != *signed-in-hint* ]] || {
  log "FAIL static image crossed the dynamic marker-cookie/cache boundary"; exit 1;
}
log "PASS static image retained its distinct filesystem-cache boundary"

release_id="$(docker exec "$CORRECTNESS_APP_CONTAINER" printenv RELEASE_ID | tr -d '\r\n')"
[[ -n "$release_id" ]] || { log "FAIL RELEASE_ID is absent in the measured app"; exit 1; }
expected_nonce="$(node -e \
  "process.stdout.write(require('node:crypto').createHash('sha256').update('alpine-club-bookings:public-website-csp-nonce:v1:'+process.argv[1]).digest('base64'))" \
  "$release_id")"
printf 'release_id=%s\nexpected_nonce=%s\n' "$release_id" "$expected_nonce" > "$PRODUCER_RAW/release-nonce.txt"

nonce_of() {
  local route="$1" label="$2" extra_header="${3:-}"
  local -a args=(-sS -D "$PRODUCER_RAW/$label.headers" -o "$PRODUCER_RAW/$label.body")
  [[ -n "$extra_header" ]] && args+=(-H "$extra_header")
  curl "${args[@]}" "$CORRECTNESS_BASE_URL$route"
  node - "$PRODUCER_RAW/$label.headers" <<'NODE'
const fs = require("node:fs");
const headers = fs.readFileSync(process.argv[2], "utf8");
const values = headers.split(/\r?\n/).filter((line) => /^content-security-policy\s*:/i.test(line));
if (values.length !== 1) throw new Error(`expected one CSP header, got ${values.length}`);
const matches = [...values[0].matchAll(/'nonce-([^']+)'/g)].map((match) => match[1]);
if (matches.length === 0 || new Set(matches).size !== 1) throw new Error("CSP has no single consistent nonce");
process.stdout.write(matches[0]);
NODE
}

for route in / /about /join /contact /join/apply; do
  safe="fixed-$(safe_name "$route")"
  first="$(nonce_of "$route" "$safe-1")"
  second="$(nonce_of "$route" "$safe-2")"
  [[ "$first" == "$expected_nonce" && "$second" == "$expected_nonce" ]] || {
    log "FAIL fixed-route nonce mismatch on $route"; exit 1;
  }
  log "PASS $route uses the release-bound fixed nonce"
done

for route in /hut-leader-instructions /join/SOMECODE /join/verify/sometoken /login /register /display /dashboard/nope /admin/typo; do
  safe="fresh-$(safe_name "$route")"
  first="$(nonce_of "$route" "$safe-1")"
  second="$(nonce_of "$route" "$safe-2")"
  [[ -n "$first" && -n "$second" && "$first" != "$second" && "$first" != "$expected_nonce" && "$second" != "$expected_nonce" ]] || {
    log "FAIL request-scoped nonce contract on $route"; exit 1;
  }
  log "PASS $route uses fresh request-scoped nonces"
done

for header in 'Purpose: prefetch' 'Next-Router-Prefetch: 1' 'Sec-Purpose: prefetch'; do
  safe="prefetch-$(safe_name "$header")"
  nonce="$(nonce_of /about "$safe" "$header")"
  [[ "$nonce" == "$expected_nonce" ]] || { log "FAIL prefetch nonce for $header"; exit 1; }
  log "PASS prefetch $header retains the fixed public nonce"
done

docker logs --since "$PRODUCER_STARTED_AT" "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/app-scenario.log" 2>&1

producer_write_cleanup_passed "read-only HTTP, container-environment, and manifest-boundary inspection"
SUMMARY_REL="$(producer_relative "$SUMMARY")"
NONCE_REL="$(producer_relative "$PRODUCER_RAW/release-nonce.txt")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"MC-05","outcome":"PASS","assertions":["sensitive and unmatched generated/stored responses remained private,no-store"],"evidence_paths":["$SUMMARY_REL"]},
  {"check_id":"MC-06","outcome":"PASS","assertions":["marker-cookie expiry never made a response shared-cacheable and static files did not mutate the marker"],"evidence_paths":["$SUMMARY_REL"]},
  {"check_id":"BND-04","outcome":"PASS","assertions":["/pay generated, stored, HEAD, and stale-hint responses remained private,no-store"],"evidence_paths":["$SUMMARY_REL"]},
  {"check_id":"BND-05","outcome":"PASS","assertions":["/dashboard/nope generated, stored, HEAD, and stale-hint responses remained private,no-store"],"evidence_paths":["$SUMMARY_REL"]},
  {"check_id":"BND-06","outcome":"PASS","assertions":["/admin/typo generated, stored, HEAD, and stale-hint responses remained private,no-store"],"evidence_paths":["$SUMMARY_REL"]},
  {"check_id":"BND-07","outcome":"PASS","assertions":["approved public routes used the release-bound nonce while narrowed routes used fresh request nonces"],"evidence_paths":["$SUMMARY_REL","$NONCE_REL"]},
  {"check_id":"BND-11","outcome":"PASS","assertions":["all cache-observation variants preserved private,no-store and no anonymous dynamic response became shared-cache eligible"],"evidence_paths":["$SUMMARY_REL"]}
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
