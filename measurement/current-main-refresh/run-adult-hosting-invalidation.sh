#!/usr/bin/env bash
# Proves that a real adult-member-hosting policy write invalidates and replaces
# an already-warm, full-route ISR page whose body renders the public booking-
# policy token. This is a production-shaped measurement probe for #2352 after
# #2591; it is not a general-purpose admin script.
set -euo pipefail

cd "$(dirname "$0")/../.."

BASE="http://localhost:8027"
APP="tacbookings-measure-app-1"
PG="tacbookings-measure-postgres-1"
CADDY="tacbookings-measure-caddy-1"
PROJECT="tacbookings-measure"
RUN_ID="$(date -u '+%Y%m%d-%H%M%S')-$$-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
PROBE_SLUG="measure-hosting-policy-probe-$RUN_ID"
PROBE_PATH="/$PROBE_SLUG"
PROBE_TITLE="Measurement hosting policy probe $RUN_ID"
PROBE_CONTENT_HTML="<p>hosting-policy-probe-$RUN_ID</p>{{booking-policy-summary}}"
STAMP="$RUN_ID"
OUT="${MEASURE_OUT_DIR:-measurement/current-main-refresh/adult-hosting-invalidation/$STAMP}"
AUTH_STATE="e2e/.auth/e2e-admin.state.json"
LOCK_DIR_IN_PG="/tmp/tacbookings-measure-adult-hosting-invalidation.lock"

EXPECTED_BASELINE_COPY="Non-member guests are asked to stay with an adult member on the same booking. A booking without one is still made, and the club looks at it."
EXPECTED_CHANGED_COPY="Non-member guests are asked to be covered by an adult member staying at the lodge. A booking without one is not confirmed until it is corrected or the club decides otherwise."

mkdir -p "$OUT"
: > "$OUT/timeline.txt"

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { printf '%s  %s\n' "$(stamp)" "$*" | tee -a "$OUT/timeline.txt"; }

COOKIE=""
ORIGINAL_SETTINGS_COUNT=""
ORIGINAL_HOST_COUNT=""
ORIGINAL_AUDIT_COUNT=""
STATE_CAPTURED=false
PAGE_CREATED=false
PAGE_TOUCHED=false
PAGE_ID=""
PAGE_CREATE_RECOVERY_ALLOWED=false
SETTINGS_TOUCHED=false
HOST_TOUCHED=false
TEST_PASSED=false
LOCK_HELD=false

psql_scalar() {
  docker exec "$PG" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 -tAc "$1" |
    tr -d '[:space:]'
}

api_json() {
  local method="$1"
  local path="$2"
  local output="$3"
  local payload="${4:-}"
  local status
  local -a args=(
    -sS
    -o "$output"
    -w '%{http_code}'
    -X "$method"
    -H "Cookie: $COOKIE"
    -H 'Content-Type: application/json'
  )
  if [[ -n "$payload" ]]; then
    args+=(--data-binary "@$payload")
  fi
  if ! status="$(curl "${args[@]}" "$BASE$path")"; then
    log "FAIL $method $path could not be completed"
    return 1
  fi
  printf '%s\n' "$status" > "$output.status"
  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    log "FAIL $method $path returned HTTP $status (body: $output)"
    return 1
  fi
}

public_get() {
  local label="$1"
  local status
  if ! status="$(curl -sS \
    -D "$OUT/$label.headers" \
    -o "$OUT/$label.body.html" \
    -w '%{http_code}' \
    "$BASE$PROBE_PATH")"; then
    log "FAIL public GET $PROBE_PATH could not be completed"
    return 1
  fi
  printf '%s\n' "$status" > "$OUT/$label.status"
  if [[ "$status" != "200" ]]; then
    log "FAIL public GET $PROBE_PATH returned HTTP $status ($label)"
    return 1
  fi
}

assert_header() {
  local file="$1"
  local pattern="$2"
  local description="$3"
  if ! grep -Eiq "$pattern" "$file"; then
    log "FAIL $description (headers: $file)"
    return 1
  fi
}

assert_absent_header() {
  local file="$1"
  local pattern="$2"
  local description="$3"
  if grep -Eiq "$pattern" "$file"; then
    log "FAIL $description (headers: $file)"
    return 1
  fi
}

assert_private_no_store_cache() {
  local file="$1"
  local description="$2"
  if ! node - "$file" <<'NODE'
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/);
const values = lines
  .filter((line) => /^cache-control\s*:/i.test(line))
  .map((line) => line.replace(/^[^:]+:/, "").trim());
if (values.length !== 1) {
  throw new Error(`expected exactly one Cache-Control header, got ${values.length}`);
}
const parts = [];
let current = "";
let inQuotes = false;
let escaped = false;
for (const character of values[0]) {
  if (escaped) {
    current += character;
    escaped = false;
  } else if (inQuotes && character === "\\") {
    current += character;
    escaped = true;
  } else if (character === '"') {
    current += character;
    inQuotes = !inQuotes;
  } else if (character === "," && !inQuotes) {
    parts.push(current);
    current = "";
  } else {
    current += character;
  }
}
if (inQuotes || escaped) throw new Error("Cache-Control contains an unterminated quoted value");
parts.push(current);
if (parts.some((part) => part.trim().length === 0)) {
  throw new Error("Cache-Control contains an empty directive");
}
const directivePattern = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:\s*=\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+|"(?:[^"\\]|\\.)*"))?$/;
const directives = new Map();
for (const part of parts) {
  const match = directivePattern.exec(part.trim());
  if (!match) throw new Error(`malformed Cache-Control directive: ${part.trim()}`);
  const name = match[1].toLowerCase();
  if (directives.has(name)) throw new Error(`duplicate Cache-Control directive: ${name}`);
  directives.set(name, match[2]);
}
if (!directives.has("private") || directives.get("private") !== undefined ||
    !directives.has("no-store") || directives.get("no-store") !== undefined) {
  throw new Error("Cache-Control must include exact private and no-store directives");
}
for (const forbidden of ["public", "s-maxage", "stale-while-revalidate"]) {
  if (directives.has(forbidden)) {
    throw new Error(`Cache-Control contains forbidden ${forbidden} directive`);
  }
}
NODE
  then
    log "FAIL $description (headers: $file)"
    return 1
  fi
}

assert_hosting_response_shape() {
  local file="$1"
  if ! node - "$file" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const modes = new Set(["DISABLED", "ADMIN_REVIEW_REQUIRED", "ENFORCED"]);
const effectiveModes = new Set(["DISABLED", "ADMIN_REVIEW_REQUIRED", "ENFORCED"]);
const isScopeSet = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === "sameBooking,sameBookingOwner" &&
  typeof value.sameBooking === "boolean" &&
  typeof value.sameBookingOwner === "boolean";
if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body is not an object");
if (body.scopeKey !== "club-wide" || body.lodgeId !== null) throw new Error("response is not club-wide");
if (!modes.has(body.mode)) throw new Error("club-wide mode must be concrete and cannot inherit");
if (body.capacityMode !== null && body.capacityMode !== "HOLD" && body.capacityMode !== "NO_HOLD") {
  throw new Error("invalid capacityMode");
}
if (body.hostScopes !== null && !isScopeSet(body.hostScopes)) throw new Error("invalid hostScopes");
if (!Number.isInteger(body.version) || typeof body.configured !== "boolean") {
  throw new Error("invalid version/configured fields");
}
if (body.configured) {
  if (body.version < 1 || body.capacityMode === null ||
      typeof body.id !== "string" || body.id.trim().length === 0) {
    throw new Error("configured response lacks persisted-row fields");
  }
} else {
  if (body.version !== 0 || body.capacityMode !== null || body.mode !== "DISABLED" ||
      body.hostScopes !== null || Object.hasOwn(body, "id")) {
    throw new Error("unconfigured response is not the documented synthetic club default");
  }
}
const effective = body.effective;
if (!effective || typeof effective !== "object" || Array.isArray(effective) ||
    !effectiveModes.has(effective.mode) || !isScopeSet(effective.hostScopes) ||
    typeof effective.preview !== "string" || effective.preview.trim().length === 0) {
  throw new Error("invalid effective policy block");
}
if (effective.mode !== body.mode) throw new Error("effective mode disagrees with club-wide mode");
const expectedModeSource = body.configured ? "CLUB_WIDE" : "BUILT_IN_DEFAULT";
if (effective.modeSource !== expectedModeSource || effective.modeSource === "LODGE") {
  throw new Error("effective mode source disagrees with configured state");
}
const scopesEqual = (left, right) =>
  left.sameBooking === right.sameBooking &&
  left.sameBookingOwner === right.sameBookingOwner;
const builtInScopes = { sameBooking: true, sameBookingOwner: false };
if (body.hostScopes === null) {
  if (effective.hostScopeSource !== "BUILT_IN_DEFAULT" ||
      !scopesEqual(effective.hostScopes, builtInScopes)) {
    throw new Error("inherited club scopes disagree with the built-in default");
  }
} else if (effective.hostScopeSource !== "CLUB_WIDE" ||
           effective.hostScopeSource === "LODGE" ||
           !scopesEqual(effective.hostScopes, body.hostScopes)) {
  throw new Error("effective host scopes disagree with the configured club scopes");
}
NODE
  then
    log "FAIL adult-hosting API response does not match the #2591 contract (body: $file)"
    return 1
  fi
}

assert_contains() {
  local file="$1"
  local needle="$2"
  local description="$3"
  if ! grep -Fq -- "$needle" "$file"; then
    log "FAIL $description (body: $file)"
    return 1
  fi
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  local description="$3"
  if grep -Fq -- "$needle" "$file"; then
    log "FAIL $description (body: $file)"
    return 1
  fi
}

csp_header() {
  awk 'BEGIN { IGNORECASE=1 } /^Content-Security-Policy:/ { sub(/\r$/, ""); print; exit }' "$1"
}

release_lock() {
  if [[ "$LOCK_HELD" == true ]]; then
    if ! docker exec "$PG" rmdir "$LOCK_DIR_IN_PG"; then
      log "FAIL could not release Postgres-container single-flight lock $LOCK_DIR_IN_PG"
      return 1
    fi
    LOCK_HELD=false
  fi
}

cleanup() {
  local original_status=$?
  local cleanup_failed=false
  local direct_db_cleanup=false
  local current_settings_count
  local current_host_count
  local current_page_count
  local current_audit_count
  local recoverable_page_count
  trap - EXIT
  set +e

  log "cleanup starting"

  if [[ "$STATE_CAPTURED" != true ]]; then
    log "cleanup not required; no state-changing request was armed"
    printf 'FAIL: probe stopped during preflight; isolated state was not changed.\n' > "$OUT/summary.txt"
    if [[ "$original_status" -eq 0 ]]; then
      original_status=1
    fi
    release_lock || original_status=1
    exit "$original_status"
  fi

  if [[ "$HOST_TOUCHED" == true && -n "$COOKIE" ]]; then
    if [[ "$ORIGINAL_HOST_COUNT" == "1" ]]; then
      if api_json GET "/api/admin/booking-policies/adult-member-hosting" \
        "$OUT/90-hosting-current-for-restore.json"; then
        if ! assert_hosting_response_shape "$OUT/90-hosting-current-for-restore.json"; then
          cleanup_failed=true
        fi
        node - \
          "$OUT/07-hosting-before.json" \
          "$OUT/90-hosting-current-for-restore.json" \
          "$OUT/91-hosting-restore.request.json" <<'NODE'
const fs = require("node:fs");
const before = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const current = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (!before.configured || !current.configured) {
  throw new Error("configured hosting row disappeared during cleanup");
}
const request = {
  mode: before.mode,
  hostScopes: before.hostScopes,
  capacityMode: before.capacityMode,
  version: current.version,
};
fs.writeFileSync(process.argv[4], JSON.stringify(request));
NODE
        if ! api_json PUT "/api/admin/booking-policies/adult-member-hosting" \
          "$OUT/91-hosting-restore.json" \
          "$OUT/91-hosting-restore.request.json"; then
          cleanup_failed=true
        elif ! assert_hosting_response_shape "$OUT/91-hosting-restore.json"; then
          cleanup_failed=true
        fi
      else
        cleanup_failed=true
      fi
    elif [[ "$ORIGINAL_HOST_COUNT" == "0" ]]; then
      if ! docker exec "$PG" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
        -c 'DELETE FROM "AdultMemberHostingPolicy" WHERE "scopeKey" = '\''club-wide'\'';' \
        > "$OUT/91-hosting-delete.txt" 2>&1; then
        cleanup_failed=true
      fi
      direct_db_cleanup=true
    fi
  fi

  if [[ "$SETTINGS_TOUCHED" == true && -n "$COOKIE" ]]; then
    if [[ "$ORIGINAL_SETTINGS_COUNT" == "1" ]]; then
      node - \
        "$OUT/05-public-settings-before.json" \
        "$OUT/92-public-settings-restore.request.json" <<'NODE'
const fs = require("node:fs");
const before = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
fs.writeFileSync(process.argv[3], JSON.stringify(before.settings));
NODE
      if ! api_json PUT "/api/admin/public-content-settings" \
        "$OUT/92-public-settings-restore.json" \
        "$OUT/92-public-settings-restore.request.json"; then
        cleanup_failed=true
      fi
    elif [[ "$ORIGINAL_SETTINGS_COUNT" == "0" ]]; then
      if ! docker exec "$PG" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
        -c 'DELETE FROM "PublicContentSettings" WHERE "id" = '\''default'\'';' \
        > "$OUT/92-public-settings-delete.txt" 2>&1; then
        cleanup_failed=true
      fi
      direct_db_cleanup=true
    fi
  fi

  if [[ ( "$PAGE_TOUCHED" == true || "$PAGE_CREATED" == true ) && -n "$COOKIE" ]]; then
    if [[ "$PAGE_CREATED" == true ]]; then
      if [[ -n "$PAGE_ID" && ! "$PAGE_ID" =~ ^[[:alnum:]_-]+$ ]]; then
        log "WARN discarding an unexpected response page id and recovering only from exact probe material"
        PAGE_ID=""
      fi
      if [[ -z "$PAGE_ID" && "$PAGE_CREATE_RECOVERY_ALLOWED" == true ]]; then
        recoverable_page_count="$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\" = '$PROBE_SLUG' AND \"path\" = '$PROBE_PATH' AND \"caption\" = '$PROBE_TITLE' AND \"menuTitle\" = '' AND \"title\" = '$PROBE_TITLE' AND \"headerText\" = '' AND \"sortOrder\" = 9300 AND \"contentHtml\" IN ('', '$PROBE_CONTENT_HTML');" 2>/dev/null)"
        if [[ "$recoverable_page_count" == "1" ]]; then
          PAGE_ID="$(psql_scalar "SELECT \"id\" FROM \"PageContent\" WHERE \"slug\" = '$PROBE_SLUG' AND \"path\" = '$PROBE_PATH' AND \"caption\" = '$PROBE_TITLE' AND \"menuTitle\" = '' AND \"title\" = '$PROBE_TITLE' AND \"headerText\" = '' AND \"sortOrder\" = 9300 AND \"contentHtml\" IN ('', '$PROBE_CONTENT_HTML');" 2>/dev/null)"
          log "cleanup recovered the committed probe page id after a missing API response"
        elif [[ "$recoverable_page_count" != "0" ]]; then
          log "FAIL cleanup found $recoverable_page_count exact probe-page rows"
          cleanup_failed=true
        fi
      fi
      if [[ -n "$PAGE_ID" && ! "$PAGE_ID" =~ ^[[:alnum:]_-]+$ ]]; then
        log "FAIL refusing cleanup with an unexpected recovered page id shape"
        PAGE_ID=""
        cleanup_failed=true
      elif [[ -n "$PAGE_ID" ]]; then
        printf '{"id":"%s","published":false}' "$PAGE_ID" \
          > "$OUT/93-page-unpublish.request.json"
        if ! api_json PATCH "/api/admin/page-content" \
          "$OUT/93-page-unpublish.json" \
          "$OUT/93-page-unpublish.request.json"; then
          cleanup_failed=true
        fi
        if ! docker exec "$PG" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
          -c "DELETE FROM \"PageContent\" WHERE \"id\" = '$PAGE_ID' AND \"slug\" = '$PROBE_SLUG' AND \"path\" = '$PROBE_PATH' AND \"caption\" = '$PROBE_TITLE' AND \"menuTitle\" = '' AND \"title\" = '$PROBE_TITLE' AND \"headerText\" = '' AND \"sortOrder\" = 9300 AND \"contentHtml\" IN ('', '$PROBE_CONTENT_HTML') AND \"published\" = false;" \
          > "$OUT/94-page-delete.txt" 2>&1; then
          cleanup_failed=true
        fi
      fi
      direct_db_cleanup=true
    fi
  fi

  if [[ "$direct_db_cleanup" == true ]]; then
    if ! bash measurement/stack/measure-stack.sh restart-app \
      > "$OUT/95-restart-after-cleanup.txt" 2>&1; then
      cleanup_failed=true
    fi
  fi

  current_settings_count="$(psql_scalar 'SELECT count(*) FROM "PublicContentSettings" WHERE "id" = '\''default'\'';' 2>/dev/null)"
  current_host_count="$(psql_scalar 'SELECT count(*) FROM "AdultMemberHostingPolicy" WHERE "scopeKey" = '\''club-wide'\'';' 2>/dev/null)"
  current_page_count="$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"id\" = '$PAGE_ID' OR \"slug\" = '$PROBE_SLUG' OR \"path\" = '$PROBE_PATH';" 2>/dev/null)"
  current_audit_count="$(psql_scalar 'SELECT count(*) FROM "AuditLog";' 2>/dev/null)"
  {
    printf 'public_settings_before=%s after=%s\n' "$ORIGINAL_SETTINGS_COUNT" "$current_settings_count"
    printf 'club_hosting_before=%s after=%s\n' "$ORIGINAL_HOST_COUNT" "$current_host_count"
    printf 'probe_page_before=0 after=%s\n' "$current_page_count"
    printf 'audit_rows_before=%s after=%s (immutable probe audit entries intentionally remain)\n' "$ORIGINAL_AUDIT_COUNT" "$current_audit_count"
  } > "$OUT/96-cleanup-counts.txt"

  if [[ -n "$ORIGINAL_SETTINGS_COUNT" && "$current_settings_count" != "$ORIGINAL_SETTINGS_COUNT" ]]; then
    cleanup_failed=true
  fi
  if [[ -n "$ORIGINAL_HOST_COUNT" && "$current_host_count" != "$ORIGINAL_HOST_COUNT" ]]; then
    cleanup_failed=true
  fi
  if [[ "$current_page_count" != "0" ]]; then
    cleanup_failed=true
  fi
  if [[ ! "$current_audit_count" =~ ^[0-9]+$ ||
        ! "$ORIGINAL_AUDIT_COUNT" =~ ^[0-9]+$ ]]; then
    log "FAIL audit row counts are not integers"
    cleanup_failed=true
  elif (( current_audit_count <= ORIGINAL_AUDIT_COUNT )); then
    log "FAIL audit row count did not increase during the mutation probe"
    cleanup_failed=true
  fi

  if [[ -n "$COOKIE" ]]; then
    if ! api_json GET "/api/admin/public-content-settings" \
      "$OUT/96-public-settings-after-cleanup.json"; then
      cleanup_failed=true
    fi
    if ! api_json GET "/api/admin/booking-policies/adult-member-hosting" \
      "$OUT/96-hosting-after-cleanup.json"; then
      cleanup_failed=true
    elif ! assert_hosting_response_shape "$OUT/96-hosting-after-cleanup.json"; then
      cleanup_failed=true
    fi
    if ! api_json GET "/api/admin/page-content" \
      "$OUT/96-page-list-after-cleanup.json"; then
      cleanup_failed=true
    fi
  fi

  if [[ -f "$OUT/96-public-settings-after-cleanup.json" &&
        -f "$OUT/96-hosting-after-cleanup.json" &&
        -f "$OUT/96-page-list-after-cleanup.json" ]]; then
    if ! node - \
      "$OUT/05-public-settings-before.json" \
      "$OUT/96-public-settings-after-cleanup.json" \
      "$OUT/07-hosting-before.json" \
      "$OUT/96-hosting-after-cleanup.json" \
      "$OUT/04-page-original.json" \
      "$OUT/96-page-list-after-cleanup.json" \
      "$PAGE_ID" "$PROBE_SLUG" "$PROBE_PATH" \
      > "$OUT/96-cleanup-functional.json" <<'NODE'
const fs = require("node:fs");
const assert = require("node:assert/strict");
const read = (index) => JSON.parse(fs.readFileSync(process.argv[index], "utf8"));
const settingsBefore = read(2);
const settingsAfter = read(3);
const hostingBefore = read(4);
const hostingAfter = read(5);
const pageBefore = read(6);
const pageListAfter = read(7);
const [pageId, probeSlug, probePath] = process.argv.slice(8, 11);
assert.deepStrictEqual(settingsAfter.settings, settingsBefore.settings, "public settings differ");
const functionalHosting = (row) => ({
  scopeKey: row.scopeKey,
  lodgeId: row.lodgeId,
  configured: row.configured,
  mode: row.mode,
  capacityMode: row.capacityMode,
  hostScopes: row.hostScopes,
  effective: row.effective,
});
assert.deepStrictEqual(functionalHosting(hostingAfter), functionalHosting(hostingBefore), "hosting policy differs");
if (!pageListAfter || !Array.isArray(pageListAfter.pages)) throw new Error("cleanup page list shape is invalid");
const collisions = pageListAfter.pages.filter((page) =>
  page.id === pageId || page.slug === probeSlug || page.path === probePath);
assert.equal(pageBefore, null, "pre-write probe page snapshot was not empty");
assert.deepStrictEqual(collisions, [], "created probe page or an identity collision remains");
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};
process.stdout.write(JSON.stringify(canonicalize({
  result: "PASS exact functional settings, hosting, and page state restored",
  publicSettings: { before: settingsBefore.settings, after: settingsAfter.settings },
  adultHosting: { before: functionalHosting(hostingBefore), after: functionalHosting(hostingAfter) },
  probePage: { before: pageBefore, after: collisions },
}), null, 2) + "\n");
NODE
    then
      cleanup_failed=true
    fi
  else
    cleanup_failed=true
  fi

  {
    printf '%s\n' 'Functional values are compared exactly in canonical 96-cleanup-functional.json.'
    printf '%s\n' 'The cleanup is intentionally not a bit-for-bit database rewind.'
    printf '%s\n' 'Immutable audit rows from the probe and its compensating API writes remain.'
    printf '%s\n' 'A restored existing hosting row has a later revision/version and write metadata.'
    printf '%s\n' 'A restored existing settings row has later updatedAt/updatedBy metadata.'
    printf '%s\n' 'The unique probe page row is removed, but its immutable audit rows remain.'
  } > "$OUT/96-cleanup-metadata-residue.txt"

  if ! release_lock; then
    cleanup_failed=true
  fi

  if [[ "$cleanup_failed" == true ]]; then
    log "FAIL cleanup did not restore the isolated measurement state"
    printf 'FAIL: cleanup incomplete; inspect timeline and 9x artefacts.\n' > "$OUT/summary.txt"
    exit 1
  fi

  log "PASS cleanup restored the isolated measurement state"
  if [[ "$original_status" -eq 0 && "$TEST_PASSED" == true ]]; then
    printf '%s\n' \
      'PASS: adult-hosting policy write invalidated and replaced the warm CMS page.' \
      'Cleanup: functional state restored exactly; audit/revision metadata residue is documented.' \
      "Evidence: $OUT" > "$OUT/summary.txt"
    exit 0
  fi
  printf 'FAIL: probe stopped before all assertions passed; cleanup succeeded.\n' > "$OUT/summary.txt"
  if [[ "$original_status" -eq 0 ]]; then
    original_status=1
  fi
  exit "$original_status"
}
trap cleanup EXIT

log "preflight: verifying the isolated current-main measurement stack"
for container_and_service in "$APP:app" "$PG:postgres" "$CADDY:caddy"; do
  container="${container_and_service%%:*}"
  expected_service="${container_and_service#*:}"
  actual_project="$(docker inspect "$container" --format '{{ index .Config.Labels "com.docker.compose.project" }}')"
  [[ "$actual_project" == "$PROJECT" ]] || {
    log "FAIL $container belongs to compose project $actual_project, not $PROJECT"
    exit 1
  }
  actual_service="$(docker inspect "$container" --format '{{ index .Config.Labels "com.docker.compose.service" }}')"
  [[ "$actual_service" == "$expected_service" ]] || {
    log "FAIL $container is compose service $actual_service, not $expected_service"
    exit 1
  }
done

EXPECTED_NETWORK="${PROJECT}_default"
actual_network_project="$(docker network inspect "$EXPECTED_NETWORK" --format '{{ index .Labels "com.docker.compose.project" }}')"
[[ "$actual_network_project" == "$PROJECT" ]] || {
  log "FAIL $EXPECTED_NETWORK belongs to compose project $actual_network_project, not $PROJECT"
  exit 1
}
expected_network_id="$(docker network inspect "$EXPECTED_NETWORK" --format '{{.Id}}')"
for container in "$APP" "$PG" "$CADDY"; do
  network_names="$(docker inspect "$container" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' | sed '/^$/d' | sort)"
  [[ "$network_names" == "$EXPECTED_NETWORK" ]] || {
    log "FAIL $container network set is not exactly $EXPECTED_NETWORK"
    exit 1
  }
  container_network_id="$(docker inspect "$container" --format "{{(index .NetworkSettings.Networks \"$EXPECTED_NETWORK\").NetworkID}}")"
  [[ "$container_network_id" == "$expected_network_id" ]] || {
    log "FAIL $container is not attached to the inspected $EXPECTED_NETWORK identity"
    exit 1
  }
done

postgres_aliases="$(docker inspect "$PG" --format "{{json (index .NetworkSettings.Networks \"$EXPECTED_NETWORK\").Aliases}}")"
POSTGRES_ALIASES="$postgres_aliases" node <<'NODE'
const aliases = JSON.parse(process.env.POSTGRES_ALIASES ?? "null");
if (!Array.isArray(aliases) || !aliases.includes("postgres")) {
  throw new Error("measurement postgres container lacks the postgres service alias");
}
NODE

docker exec "$APP" node -e '
const raw = process.env.DATABASE_URL;
if (!raw) throw new Error("measurement app DATABASE_URL is empty");
let url;
try {
  url = new URL(raw);
} catch {
  throw new Error("measurement app DATABASE_URL is not a valid URL");
}
if (url.protocol !== "postgresql:" || url.username !== "tac" || !url.password ||
    url.hostname !== "postgres" || url.port !== "5432" || url.pathname !== "/tacbookings") {
  throw new Error("measurement app DATABASE_URL does not identify tac@postgres:5432/tacbookings");
}
const expectedParams = new URLSearchParams({ connection_limit: "10", pool_timeout: "10" });
if ([...url.searchParams].length !== 2 ||
    [...expectedParams].some(([key, value]) => url.searchParams.get(key) !== value)) {
  throw new Error("measurement app DATABASE_URL does not carry the web-measure pool identity");
}
process.stdout.write(
  "protocol=postgresql\nuser=tac\nhost=postgres\nport=5432\ndatabase=tacbookings\n" +
  "connection_limit=10\npool_timeout=10\npassword_present=true\n"
);
' > "$OUT/00-database-identity.txt"

postgres_network_ip="$(docker inspect "$PG" --format "{{(index .NetworkSettings.Networks \"$EXPECTED_NETWORK\").IPAddress}}")"
[[ "$postgres_network_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  log "FAIL measurement postgres has no IPv4 identity on $EXPECTED_NETWORK"
  exit 1
}
resolved_postgres_ips="$(docker exec "$APP" node -e '
require("node:dns").promises.lookup("postgres", { all: true, family: 4 })
  .then((rows) => process.stdout.write([...new Set(rows.map((row) => row.address))].sort().join("\n")));
')"
[[ "$resolved_postgres_ips" == "$postgres_network_ip" ]] || {
  log "FAIL postgres DNS in the app does not resolve only to the inspected postgres container"
  exit 1
}

for binding in "$APP:3000/tcp:127.0.0.1:3003" "$PG:5432/tcp:127.0.0.1:5435" "$CADDY:8027/tcp:127.0.0.1:8027"; do
  container="${binding%%:*}"
  remainder="${binding#*:}"
  container_port="${remainder%%:*}"
  remainder="${remainder#*:}"
  expected_host_ip="${remainder%%:*}"
  expected_host_port="${remainder#*:}"
  binding_json="$(docker inspect "$container" --format "{{json (index .NetworkSettings.Ports \"$container_port\")}}")"
  BINDING_JSON="$binding_json" EXPECTED_HOST_IP="$expected_host_ip" EXPECTED_HOST_PORT="$expected_host_port" node <<'NODE'
const bindings = JSON.parse(process.env.BINDING_JSON ?? "null");
if (!Array.isArray(bindings) || bindings.length !== 1 ||
    bindings[0].HostIp !== process.env.EXPECTED_HOST_IP ||
    bindings[0].HostPort !== process.env.EXPECTED_HOST_PORT) {
  throw new Error("measurement container is not bound to its exact loopback host identity");
}
NODE
done

actual_image="$(docker inspect "$APP" --format '{{.Config.Image}}')"
[[ "$actual_image" == "tacbookings-measure-app:current" ]] || {
  log "FAIL app container uses $actual_image, not tacbookings-measure-app:current"
  exit 1
}

expected_head="$(git rev-parse origin/main)"
worktree_head="$(git rev-parse HEAD)"
image_head="$(docker exec "$APP" printenv GIT_COMMIT_SHA | tr -d '\r')"
[[ "$worktree_head" == "$expected_head" ]] || {
  log "FAIL worktree HEAD is not current origin/main"
  exit 1
}
[[ "$image_head" == "$expected_head" ]] || {
  log "FAIL current image commit does not match current origin/main"
  exit 1
}
[[ "$(docker exec "$APP" printenv APP_RUNTIME_ROLE | tr -d '\r')" == "web-measure" ]] || {
  log "FAIL app runtime role is not web-measure"
  exit 1
}
[[ "$(docker exec "$APP" printenv CRON_ENABLED | tr -d '\r')" == "false" ]] || {
  log "FAIL cron is not disabled in the measurement app"
  exit 1
}

health_status="$(curl -sS -o "$OUT/00-health.json" -w '%{http_code}' "$BASE/api/health")"
[[ "$health_status" == "200" ]] || {
  log "FAIL measurement app health returned HTTP $health_status"
  exit 1
}
node - "$OUT/00-health.json" <<'NODE'
const fs = require("node:fs");
const health = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (health?.status !== "healthy" || health?.checks?.db?.status !== "ok") {
  throw new Error("measurement health body does not report a healthy database");
}
NODE

# Serialize harness runs in the already-verified measurement Postgres container,
# not in one checkout's host /tmp. Atomic mkdir also fails closed on a stale lock.
if ! docker exec "$PG" mkdir "$LOCK_DIR_IN_PG"; then
  log "FAIL another adult-hosting invalidation probe is active, or stale Postgres-container lock $LOCK_DIR_IN_PG needs review"
  exit 1
fi
LOCK_HELD=true

[[ -f "$AUTH_STATE" ]] || {
  log "FAIL missing $AUTH_STATE; run the measurement Playwright setup project"
  exit 1
}
COOKIE="$(node -e "const s=require('./$AUTH_STATE'); const c=s.cookies.find((v)=>v.name==='authjs.session-token'); if(!c) throw new Error('admin session cookie missing'); process.stdout.write(c.name+'='+c.value)")"

{
  printf 'worktree_head=%s\n' "$worktree_head"
  printf 'origin_main=%s\n' "$expected_head"
  printf 'image_commit=%s\n' "$image_head"
  printf 'image=%s\n' "$actual_image"
  printf 'compose_project=%s\n' "$PROJECT"
  printf 'compose_network=%s\n' "$EXPECTED_NETWORK"
  printf 'base_url=%s\n' "$BASE"
  printf 'database_identity=%s\n' "$OUT/00-database-identity.txt"
  printf 'app_runtime_role=web-measure\n'
  printf 'cron_enabled=false\n'
} > "$OUT/00-preflight.txt"

ORIGINAL_SETTINGS_COUNT="$(psql_scalar 'SELECT count(*) FROM "PublicContentSettings" WHERE "id" = '\''default'\'';')"
ORIGINAL_HOST_COUNT="$(psql_scalar 'SELECT count(*) FROM "AdultMemberHostingPolicy" WHERE "scopeKey" = '\''club-wide'\'';')"
ORIGINAL_AUDIT_COUNT="$(psql_scalar 'SELECT count(*) FROM "AuditLog";')"
[[ "$ORIGINAL_SETTINGS_COUNT" =~ ^[01]$ ]] || {
  log "FAIL unexpected PublicContentSettings singleton count: $ORIGINAL_SETTINGS_COUNT"
  exit 1
}
[[ "$ORIGINAL_HOST_COUNT" =~ ^[01]$ ]] || {
  log "FAIL unexpected club-wide hosting row count: $ORIGINAL_HOST_COUNT"
  exit 1
}
[[ "$ORIGINAL_AUDIT_COUNT" =~ ^[0-9]+$ ]] || {
  log "FAIL unexpected AuditLog row count: $ORIGINAL_AUDIT_COUNT"
  exit 1
}

api_json GET "/api/admin/page-content" "$OUT/01-page-list-before.json"
node - \
  "$OUT/01-page-list-before.json" \
  "$PROBE_SLUG" "$PROBE_PATH" \
  "$OUT/04-page-original.json" <<'NODE'
const fs = require("node:fs");
const listed = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!listed || typeof listed !== "object" || !Array.isArray(listed.pages)) {
  throw new Error("page-content GET response has no pages array");
}
for (const page of listed.pages) {
  if (!page || typeof page !== "object" || typeof page.id !== "string" ||
      typeof page.slug !== "string" || typeof page.path !== "string") {
    throw new Error("page-content GET returned an invalid page identity");
  }
}
const collisions = listed.pages.filter((page) =>
  page.slug === process.argv[3] || page.path === process.argv[4]);
if (collisions.length !== 0) {
  throw new Error("unique probe slug/path already exists; refusing to overwrite it");
}
fs.writeFileSync(process.argv[5], "null");
NODE

api_json GET "/api/admin/public-content-settings" \
  "$OUT/05-public-settings-before.json"
node - "$OUT/05-public-settings-before.json" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const settings = body?.settings;
const booleanKeys = ["membershipTypes", "entranceFees", "hutFees", "bookingPolicySummary", "cancellationPolicy", "annualFees", "showBookNow"];
if (!settings || typeof settings !== "object" || !Array.isArray(body.pages) ||
    booleanKeys.some((key) => typeof settings[key] !== "boolean") ||
    !["BOOKING_FLOW", "PAGE"].includes(settings.bookNowTarget) ||
    (settings.bookNowPageId !== null && typeof settings.bookNowPageId !== "string") ||
    !["NONE", "CIRCLE", "SQUARE"].includes(settings.committeePhotoDisplay)) {
  throw new Error("public-content-settings GET response shape is invalid");
}
NODE

api_json GET "/api/admin/booking-policies/adult-member-hosting" \
  "$OUT/07-hosting-before.json"
assert_hosting_response_shape "$OUT/07-hosting-before.json"

STATE_CAPTURED=true

node - "$PROBE_SLUG" "$PROBE_TITLE" "$OUT/02-page-create.request.json" <<'NODE'
const fs = require("node:fs");
const request = {
  slug: process.argv[2],
  caption: process.argv[3],
  menuTitle: "",
  title: process.argv[3],
  headerText: "",
  sortOrder: 9300,
};
fs.writeFileSync(process.argv[4], JSON.stringify(request));
NODE
# Arm cleanup before sending the write: curl can lose the response after the
# server commits, so cleanup can recover only this run's exact unique material.
PAGE_CREATED=true
PAGE_CREATE_RECOVERY_ALLOWED=true
if ! api_json POST "/api/admin/page-content" \
  "$OUT/02-page-create.json" \
  "$OUT/02-page-create.request.json"; then
  create_status=""
  if [[ -f "$OUT/02-page-create.json.status" ]]; then
    create_status="$(tr -d '[:space:]' < "$OUT/02-page-create.json.status")"
  fi
  if [[ "$create_status" == "409" ]]; then
    # A completed conflict response proves this run did not create the row.
    # Never reinterpret the colliding row as ours, recover it, or delete it.
    PAGE_CREATE_RECOVERY_ALLOWED=false
    PAGE_CREATED=false
    log "FAIL page create returned HTTP 409; collision cleanup is deliberately disarmed"
  fi
  exit 1
fi
PAGE_ID="$(node - \
  "$OUT/02-page-create.json" "$PROBE_SLUG" "$PROBE_PATH" "$PROBE_TITLE" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const page = body?.page;
if (!page || typeof page.id !== "string" || page.slug !== process.argv[3] ||
    page.path !== process.argv[4] || page.caption !== process.argv[5] ||
    page.title !== process.argv[5] || page.menuTitle !== "" || page.headerText !== "" ||
    page.sortOrder !== 9300 || page.contentHtml !== "" || page.published !== true) {
  throw new Error("page-content POST response did not bind the exact created page");
}
process.stdout.write(page.id);
NODE
)"

[[ "$PAGE_ID" =~ ^[[:alnum:]_-]+$ ]] || {
  log "FAIL unexpected page id shape"
  exit 1
}
PAGE_CREATE_RECOVERY_ALLOWED=false

node - "$PAGE_ID" "$PROBE_SLUG" "$PROBE_TITLE" "$PROBE_CONTENT_HTML" "$OUT/03-page-save.request.json" <<'NODE'
const fs = require("node:fs");
const request = {
  id: process.argv[2],
  slug: process.argv[3],
  caption: process.argv[4],
  menuTitle: "",
  title: process.argv[4],
  headerText: "",
  sortOrder: 9300,
  contentHtml: process.argv[5],
};
fs.writeFileSync(process.argv[6], JSON.stringify(request));
NODE
PAGE_TOUCHED=true
api_json PUT "/api/admin/page-content" \
  "$OUT/03-page-save.json" \
  "$OUT/03-page-save.request.json"
node - "$OUT/03-page-save.json" "$PAGE_ID" "$PROBE_SLUG" "$PROBE_PATH" "$PROBE_TITLE" "$PROBE_CONTENT_HTML" <<'NODE'
const fs = require("node:fs");
const page = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))?.page;
if (!page || page.id !== process.argv[3] || page.slug !== process.argv[4] ||
    page.path !== process.argv[5] || page.caption !== process.argv[6] ||
    page.title !== process.argv[6] || page.menuTitle !== "" || page.headerText !== "" ||
    page.sortOrder !== 9300 || page.contentHtml !== process.argv[7] || page.published !== true) {
  throw new Error("page-content PUT response did not preserve the exact probe identity/material");
}
NODE

printf '{"id":"%s","published":true}' "$PAGE_ID" \
  > "$OUT/04-page-publish.request.json"
api_json PATCH "/api/admin/page-content" \
  "$OUT/04-page-publish.json" \
  "$OUT/04-page-publish.request.json"
node - "$OUT/04-page-publish.json" "$PAGE_ID" "$PROBE_SLUG" "$PROBE_PATH" "$PROBE_CONTENT_HTML" <<'NODE'
const fs = require("node:fs");
const page = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))?.page;
if (!page || page.id !== process.argv[3] || page.slug !== process.argv[4] ||
    page.path !== process.argv[5] || page.contentHtml !== process.argv[6] || page.published !== true) {
  throw new Error("page-content PATCH response did not publish the exact probe page");
}
NODE

node - \
  "$OUT/05-public-settings-before.json" \
  "$OUT/06-public-settings-enable.request.json" <<'NODE'
const fs = require("node:fs");
const before = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const request = { ...before.settings, bookingPolicySummary: true };
fs.writeFileSync(process.argv[3], JSON.stringify(request));
NODE
SETTINGS_TOUCHED=true
api_json PUT "/api/admin/public-content-settings" \
  "$OUT/06-public-settings-enable.json" \
  "$OUT/06-public-settings-enable.request.json"
node - "$OUT/06-public-settings-enable.request.json" "$OUT/06-public-settings-enable.json" <<'NODE'
const fs = require("node:fs");
const assert = require("node:assert/strict");
const requested = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const response = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
assert.deepStrictEqual(response, { settings: requested }, "public settings PUT response shape/value mismatch");
NODE

node - \
  "$OUT/07-hosting-before.json" \
  "$OUT/08-hosting-baseline.request.json" <<'NODE'
const fs = require("node:fs");
const before = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const request = {
  mode: "ADMIN_REVIEW_REQUIRED",
  hostScopes: { sameBooking: true, sameBookingOwner: false },
  capacityMode: before.capacityMode ?? "NO_HOLD",
};
if (before.configured) request.version = before.version;
fs.writeFileSync(process.argv[3], JSON.stringify(request));
NODE
HOST_TOUCHED=true
api_json PUT "/api/admin/booking-policies/adult-member-hosting" \
  "$OUT/08-hosting-baseline.json" \
  "$OUT/08-hosting-baseline.request.json"
assert_hosting_response_shape "$OUT/08-hosting-baseline.json"

log "warming the CMS probe under the baseline hosting policy"
public_get "09-baseline-miss"
assert_header "$OUT/09-baseline-miss.headers" '^X-Nextjs-Cache:[[:space:]]*MISS[[:space:]]*$' \
  "baseline first request was not an ISR MISS"
assert_header "$OUT/09-baseline-miss.headers" '^X-Nextjs-Prerender:[[:space:]]*1[[:space:]]*$' \
  "baseline response was not prerendered"
assert_header "$OUT/09-baseline-miss.headers" '^X-Nextjs-Stale-Time:[[:space:]]*300[[:space:]]*$' \
  "baseline response did not carry the 300-second ISR window"
assert_private_no_store_cache "$OUT/09-baseline-miss.headers" \
  "baseline MISS did not retain the strict private/no-store wire-cache boundary"
assert_absent_header "$OUT/09-baseline-miss.headers" '^Set-Cookie:' \
  "anonymous baseline response unexpectedly wrote a cookie"
assert_contains "$OUT/09-baseline-miss.body.html" "$EXPECTED_BASELINE_COPY" \
  "baseline hosting wording was absent"
assert_not_contains "$OUT/09-baseline-miss.body.html" "$EXPECTED_CHANGED_COPY" \
  "changed hosting wording appeared before the policy change"

public_get "10-baseline-hit"
assert_header "$OUT/10-baseline-hit.headers" '^X-Nextjs-Cache:[[:space:]]*HIT[[:space:]]*$' \
  "baseline second request was not an ISR HIT"
assert_private_no_store_cache "$OUT/10-baseline-hit.headers" \
  "baseline HIT did not retain the strict private/no-store wire-cache boundary"
assert_absent_header "$OUT/10-baseline-hit.headers" '^Set-Cookie:' \
  "anonymous baseline HIT unexpectedly wrote a cookie"
cmp -s "$OUT/09-baseline-miss.body.html" "$OUT/10-baseline-hit.body.html" || {
  log "FAIL baseline MISS and HIT bodies differ"
  exit 1
}

node - \
  "$OUT/08-hosting-baseline.json" \
  "$OUT/11-hosting-change.request.json" <<'NODE'
const fs = require("node:fs");
const baseline = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!baseline.configured || !Number.isInteger(baseline.version)) {
  throw new Error("baseline hosting response has no compare-and-swap version");
}
const request = {
  mode: "ENFORCED",
  hostScopes: { sameBooking: false, sameBookingOwner: true },
  capacityMode: baseline.capacityMode,
  version: baseline.version,
};
fs.writeFileSync(process.argv[3], JSON.stringify(request));
NODE

log "writing the materially different hosting policy"
api_json PUT "/api/admin/booking-policies/adult-member-hosting" \
  "$OUT/11-hosting-change.json" \
  "$OUT/11-hosting-change.request.json"
assert_hosting_response_shape "$OUT/11-hosting-change.json"

public_get "12-after-change-miss"
assert_header "$OUT/12-after-change-miss.headers" '^X-Nextjs-Cache:[[:space:]]*MISS[[:space:]]*$' \
  "first request after the hosting write was not an ISR MISS"
assert_header "$OUT/12-after-change-miss.headers" '^X-Nextjs-Prerender:[[:space:]]*1[[:space:]]*$' \
  "regenerated response was not prerendered"
assert_header "$OUT/12-after-change-miss.headers" '^X-Nextjs-Stale-Time:[[:space:]]*300[[:space:]]*$' \
  "regenerated response did not carry the 300-second ISR window"
assert_private_no_store_cache "$OUT/12-after-change-miss.headers" \
  "regenerated MISS did not retain the strict private/no-store wire-cache boundary"
assert_absent_header "$OUT/12-after-change-miss.headers" '^Set-Cookie:' \
  "anonymous regenerated response unexpectedly wrote a cookie"
assert_contains "$OUT/12-after-change-miss.body.html" "$EXPECTED_CHANGED_COPY" \
  "changed hosting wording was not visible on the next request"
assert_not_contains "$OUT/12-after-change-miss.body.html" "$EXPECTED_BASELINE_COPY" \
  "the invalidated page still carried baseline hosting wording"
cmp -s "$OUT/10-baseline-hit.body.html" "$OUT/12-after-change-miss.body.html" && {
  log "FAIL hosting write did not replace the stored response body"
  exit 1
}

baseline_csp="$(csp_header "$OUT/10-baseline-hit.headers")"
changed_csp="$(csp_header "$OUT/12-after-change-miss.headers")"
[[ -n "$baseline_csp" && "$baseline_csp" == "$changed_csp" ]] || {
  log "FAIL regenerated response changed or lost the fixed-release CSP"
  exit 1
}

public_get "13-after-change-hit"
assert_header "$OUT/13-after-change-hit.headers" '^X-Nextjs-Cache:[[:space:]]*HIT[[:space:]]*$' \
  "second request after the hosting write was not an ISR HIT"
assert_private_no_store_cache "$OUT/13-after-change-hit.headers" \
  "regenerated HIT did not retain the strict private/no-store wire-cache boundary"
assert_absent_header "$OUT/13-after-change-hit.headers" '^Set-Cookie:' \
  "anonymous regenerated HIT unexpectedly wrote a cookie"
cmp -s "$OUT/12-after-change-miss.body.html" "$OUT/13-after-change-hit.body.html" || {
  log "FAIL regenerated MISS and HIT bodies differ"
  exit 1
}

log "PASS hosting policy write invalidated and replaced the warm CMS page"
TEST_PASSED=true
