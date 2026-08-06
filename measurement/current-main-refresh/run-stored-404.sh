#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_BASE_URL:?CORRECTNESS_BASE_URL is required}"
: "${CORRECTNESS_AUTH_STATE:?CORRECTNESS_AUTH_STATE is required}"
producer_begin stored-404

ROUTE="/admin/issue-2352-stored-404-$CORRECTNESS_RUN_ID"
MARKER="issue-2352-clear-trigger-$CORRECTNESS_RUN_ID"
COOKIE=""
BANNER_ID=""
MUTATION_ARMED=false
CLEANED=false

api() {
  local method="$1" path="$2" output="$3" payload="${4:-}" status
  local -a args=(-sS -o "$output" -w '%{http_code}' -X "$method" -H "Cookie: $COOKIE" -H 'Content-Type: application/json')
  [[ -n "$payload" ]] && args+=(--data-binary "@$payload")
  status="$(curl "${args[@]}" "$CORRECTNESS_BASE_URL$path")"
  printf '%s\n' "$status" > "$output.status"
  [[ "$status" =~ ^2[0-9][0-9]$ ]]
}

recover_banner_id() {
  api GET /api/admin/site-banners "$PRODUCER_RAW/banner-list.json" || return 1
  node - "$PRODUCER_RAW/banner-list.json" "$MARKER" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rows = (body.banners ?? body).filter((row) => row?.message === process.argv[3]);
if (rows.length !== 1 || typeof rows[0].id !== "string" || !/^[A-Za-z0-9_-]+$/.test(rows[0].id)) {
  throw new Error(`expected one exact clearing-trigger banner, got ${rows.length}`);
}
process.stdout.write(rows[0].id);
NODE
}

cleanup() {
  local original_status=$? cleanup_failed=false
  trap - EXIT
  set +e
  if [[ "$MUTATION_ARMED" == true && -z "$BANNER_ID" ]]; then
    BANNER_ID="$(recover_banner_id 2>/dev/null)" || cleanup_failed=true
  fi
  if [[ -n "$BANNER_ID" ]]; then
    api DELETE "/api/admin/site-banners/$BANNER_ID" "$PRODUCER_RAW/banner-delete.json" || cleanup_failed=true
  fi
  if api GET /api/admin/site-banners "$PRODUCER_RAW/banner-list-after-cleanup.json"; then
    if node - "$PRODUCER_RAW/banner-list-after-cleanup.json" "$MARKER" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rows = body.banners ?? body;
if (!Array.isArray(rows) || rows.some((row) => row?.message === process.argv[3])) {
  throw new Error("clearing-trigger banner residue remains");
}
NODE
    then CLEANED=true; else cleanup_failed=true; fi
  else cleanup_failed=true
  fi
  if [[ "$cleanup_failed" == true ]]; then
    printf '{"status":"failed","marker":"%s"}\n' "$MARKER" > "$PRODUCER_RAW/mutation-cleanup.json"
    exit 1
  fi
  printf '{"status":"passed","marker":"%s","audit_residue":"intentional"}\n' "$MARKER" > "$PRODUCER_RAW/mutation-cleanup.json"
  exit "$original_status"
}
trap cleanup EXIT

[[ -f "$CORRECTNESS_AUTH_STATE" ]] || { echo "auth storage state is missing" >&2; exit 1; }
COOKIE="$(node - "$CORRECTNESS_AUTH_STATE" <<'NODE'
const state = require(process.argv[2]);
const cookie = state.cookies.find((candidate) => candidate.name === "authjs.session-token");
if (!cookie?.value) throw new Error("admin session cookie missing");
process.stdout.write(`${cookie.name}=${cookie.value}`);
NODE
)"

capture_404() {
  local label="$1" status
  status="$(curl -sS -D "$PRODUCER_RAW/$label.headers" -o "$PRODUCER_RAW/$label.body.html" -w '%{http_code}' "$CORRECTNESS_BASE_URL$ROUTE")"
  printf '%s\n' "$status" > "$PRODUCER_RAW/$label.status"
  [[ "$status" == 404 ]] || { echo "$label returned HTTP $status" >&2; return 1; }
  assert_private_no_store "$PRODUCER_RAW/$label.headers"
  if grep -Fq -- "${COOKIE#*=}" "$PRODUCER_RAW/$label.body.html"; then
    echo "$label exposed the authenticated session value" >&2
    return 1
  fi
}

capture_404 first
capture_404 second
node measurement/current-main-refresh/bin/observe-stored-404-browser.mjs \
  --base-url "$CORRECTNESS_BASE_URL" --route "$ROUTE" \
  --out "$PRODUCER_RAW/browser.json" --screenshot "$PRODUCER_RAW/stored-404.png"

api GET /api/admin/site-banners "$PRODUCER_RAW/banner-list-before.json"
node - "$PRODUCER_RAW/banner-list-before.json" "$MARKER" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rows = body.banners ?? body;
if (!Array.isArray(rows) || rows.some((row) => row?.message === process.argv[3])) throw new Error("marker collision");
NODE
node - "$MARKER" "$PRODUCER_RAW/banner-create.request.json" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[3], JSON.stringify({
  message: process.argv[2], priority: "NOTIFY", startDate: "2099-01-01", endDate: "2099-01-01", active: false,
}));
NODE
MUTATION_ARMED=true
if api POST /api/admin/site-banners "$PRODUCER_RAW/banner-create.json" "$PRODUCER_RAW/banner-create.request.json"; then
  BANNER_ID="$(node - "$PRODUCER_RAW/banner-create.json" <<'NODE'
const body = require(process.argv[2]);
if (typeof body?.banner?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.banner.id)) throw new Error("invalid banner id");
process.stdout.write(body.banner.id);
NODE
)"
else
  BANNER_ID="$(recover_banner_id)"
  echo "banner create response failed after the exact row was recovered; refusing evidence" >&2
  exit 1
fi
capture_404 cleared

node measurement/current-main-refresh/bin/analyse-stored-404.mjs \
  --first-headers "$PRODUCER_RAW/first.headers" --first-body "$PRODUCER_RAW/first.body.html" --first-status "$PRODUCER_RAW/first.status" \
  --second-headers "$PRODUCER_RAW/second.headers" --second-body "$PRODUCER_RAW/second.body.html" --second-status "$PRODUCER_RAW/second.status" \
  --cleared-headers "$PRODUCER_RAW/cleared.headers" --cleared-body "$PRODUCER_RAW/cleared.body.html" --cleared-status "$PRODUCER_RAW/cleared.status" \
  --browser "$PRODUCER_RAW/browser.json" --out "$PRODUCER_RAW/analysis.json"

api DELETE "/api/admin/site-banners/$BANNER_ID" "$PRODUCER_RAW/banner-delete.json"
BANNER_ID=""
api GET /api/admin/site-banners "$PRODUCER_RAW/banner-list-after-cleanup.json"
node - "$PRODUCER_RAW/banner-list-after-cleanup.json" "$MARKER" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rows = body.banners ?? body;
if (!Array.isArray(rows) || rows.some((row) => row?.message === process.argv[3])) throw new Error("banner cleanup failed");
NODE
CLEANED=true
printf '{"status":"passed","marker":"%s","audit_residue":"intentional"}\n' "$MARKER" > "$PRODUCER_RAW/mutation-cleanup.json"
trap - EXIT

producer_write_cleanup_passed "unique clearing-trigger banner removed; immutable audit entry retained" \
  "mutation-cleanup.json" "banner-list-after-cleanup.json"
ANALYSIS="$(producer_relative "$PRODUCER_RAW/analysis.json")"
SCREENSHOT="$(producer_relative "$PRODUCER_RAW/stored-404.png")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"MC-05","outcome":"PASS","assertions":["two 404 responses stayed private,no-store, reused the accepted stored document, and exposed no session value"],"evidence_paths":["$ANALYSIS","$SCREENSHOT"]},
  {"check_id":"BND-12","outcome":"PASS","assertions":["first policy/document nonce matched, later policy differed from stored HTML, browser-visible text was blank, and an admin invalidation trigger generated a fresh matching document"],"evidence_paths":["$ANALYSIS","$SCREENSHOT"]}
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
