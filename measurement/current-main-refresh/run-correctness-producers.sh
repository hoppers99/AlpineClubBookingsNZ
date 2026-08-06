#!/usr/bin/env bash
# Source/image/database-bound correctness producer orchestrator for #2352.
# It deliberately does not finalize or write COMPLETED.json; the independent
# finalizer owns raw enumeration, secret scanning, report computation, and seal.
set -euo pipefail
cd "$(dirname "$0")/../.."

usage() {
  cat >&2 <<'EOF'
usage: run-correctness-producers.sh \
  --run-root ABS --run-id ID --side current|baseline \
  --source-archive ABS --source-sha256 HEX --source-commit HEX \
  --image-reference IMMUTABLE --image-id sha256:HEX --oci-revision HEX \
  --database-archive ABS --database-sha256 HEX --database-fingerprint HEX \
  --app-container NAME --postgres-container NAME --auth-state ABS \
  [--base-url http://127.0.0.1:8027] [--compose-project tacbookings-measure]
EOF
  exit 2
}

RUN_ROOT="" RUN_ID="" SIDE="" SOURCE_ARCHIVE="" SOURCE_SHA="" SOURCE_COMMIT=""
IMAGE_REFERENCE="" IMAGE_ID="" OCI_REVISION="" DATABASE_ARCHIVE="" DATABASE_SHA="" DATABASE_FINGERPRINT=""
APP_CONTAINER="" POSTGRES_CONTAINER="" AUTH_STATE="" BASE_URL="http://127.0.0.1:8027" COMPOSE_PROJECT="tacbookings-measure"
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --run-root) RUN_ROOT="$2";; --run-id) RUN_ID="$2";; --side) SIDE="$2";;
    --source-archive) SOURCE_ARCHIVE="$2";; --source-sha256) SOURCE_SHA="$2";; --source-commit) SOURCE_COMMIT="$2";;
    --image-reference) IMAGE_REFERENCE="$2";; --image-id) IMAGE_ID="$2";; --oci-revision) OCI_REVISION="$2";;
    --database-archive) DATABASE_ARCHIVE="$2";; --database-sha256) DATABASE_SHA="$2";; --database-fingerprint) DATABASE_FINGERPRINT="$2";;
    --app-container) APP_CONTAINER="$2";; --postgres-container) POSTGRES_CONTAINER="$2";; --auth-state) AUTH_STATE="$2";;
    --base-url) BASE_URL="$2";; --compose-project) COMPOSE_PROJECT="$2";; *) usage;;
  esac
  shift 2
done
for value in RUN_ROOT RUN_ID SIDE SOURCE_ARCHIVE SOURCE_SHA SOURCE_COMMIT IMAGE_REFERENCE IMAGE_ID OCI_REVISION DATABASE_ARCHIVE DATABASE_SHA DATABASE_FINGERPRINT APP_CONTAINER POSTGRES_CONTAINER AUTH_STATE; do
  [[ -n "${!value}" ]] || { echo "$value is required" >&2; usage; }
done
[[ "$RUN_ROOT" = /* || "$RUN_ROOT" =~ ^[A-Za-z]:[/\\] ]] || { echo "run root must be absolute" >&2; exit 1; }
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "invalid run id" >&2; exit 1; }
[[ "$SIDE" == current || "$SIDE" == baseline ]] || { echo "invalid side" >&2; exit 1; }
[[ ! -e "$RUN_ROOT" ]] || { echo "run root already exists: $RUN_ROOT" >&2; exit 1; }
mkdir "$RUN_ROOT"
mkdir "$RUN_ROOT/inputs" "$RUN_ROOT/raw" "$RUN_ROOT/producer-results"
RUN_ROOT="$(cd "$RUN_ROOT" && pwd -P)"

sha256_file() { sha256sum "$1" | awk '{print $1}'; }
utc_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
[[ -f "$SOURCE_ARCHIVE" && "$(sha256_file "$SOURCE_ARCHIVE")" == "$SOURCE_SHA" ]] || { echo "source archive checksum mismatch" >&2; exit 1; }
[[ -f "$DATABASE_ARCHIVE" && "$(sha256_file "$DATABASE_ARCHIVE")" == "$DATABASE_SHA" ]] || { echo "database archive checksum mismatch" >&2; exit 1; }
[[ -f "$AUTH_STATE" ]] || { echo "auth state missing" >&2; exit 1; }

LOCK_DIR="/tmp/tacbookings-issue-2352-correctness.lock"
LOCK_HELD=false
release_lock() {
  if [[ "$LOCK_HELD" == true ]]; then
    docker exec "$POSTGRES_CONTAINER" rmdir "$LOCK_DIR" >/dev/null || {
      echo "failed to release correctness lock $LOCK_DIR" >&2
      return 1
    }
    LOCK_HELD=false
  fi
}
trap 'status=$?; trap - EXIT; release_lock || status=1; exit "$status"' EXIT
docker exec "$POSTGRES_CONTAINER" mkdir "$LOCK_DIR" || {
  echo "another correctness run is active, or stale lock needs review: $LOCK_DIR" >&2
  exit 1
}
LOCK_HELD=true

node - "$PWD/measurement/current-main-refresh/check-census.json" "$RUN_ROOT/inputs/check-census.json" <<'NODE'
const fs = require("node:fs");
fs.copyFileSync(process.argv[2], process.argv[3], fs.constants.COPYFILE_EXCL);
NODE
CENSUS="$RUN_ROOT/inputs/check-census.json"
CENSUS_SHA="$(sha256_file "$CENSUS")"
node measurement/current-main-refresh/bin/build-producer-manifest.mjs \
  --repo-root "$PWD" --out "$RUN_ROOT/inputs/producer-files.sha256"
PRODUCER_FILES="$RUN_ROOT/inputs/producer-files.sha256"
PRODUCER_FILES_SHA="$(sha256_file "$PRODUCER_FILES")"

ACTUAL_IMAGE_ID="$(docker image inspect "$IMAGE_REFERENCE" --format '{{.Id}}')"
ACTUAL_REVISION="$(docker image inspect "$IMAGE_REFERENCE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$ACTUAL_IMAGE_ID" == "$IMAGE_ID" && "$ACTUAL_REVISION" == "$OCI_REVISION" ]] || {
  echo "image inspection disagrees with supplied identity" >&2; exit 1;
}
node - "$RUN_ROOT/inputs/image-inspect.json" "$ACTUAL_IMAGE_ID" "$ACTUAL_REVISION" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({ id: process.argv[3], oci_revision: process.argv[4] }, null, 2) + "\n", { flag: "wx" });
NODE
IMAGE_INSPECT="$RUN_ROOT/inputs/image-inspect.json"
IMAGE_INSPECT_SHA="$(sha256_file "$IMAGE_INSPECT")"

CONTAINER_ID="$(docker inspect "$APP_CONTAINER" --format '{{.Id}}')"
CONTAINER_IMAGE_ID="$(docker inspect "$APP_CONTAINER" --format '{{.Image}}')"
CONTAINER_PROJECT="$(docker inspect "$APP_CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}')"
CONTAINER_SERVICE="$(docker inspect "$APP_CONTAINER" --format '{{index .Config.Labels "com.docker.compose.service"}}')"
[[ "$CONTAINER_IMAGE_ID" == "$IMAGE_ID" && "$CONTAINER_PROJECT" == "$COMPOSE_PROJECT" && "$CONTAINER_SERVICE" == app ]] || {
  echo "running app container disagrees with image/project/service identity" >&2; exit 1;
}
node - "$RUN_ROOT/inputs/container-inspect.json" "$CONTAINER_ID" "$CONTAINER_IMAGE_ID" "$CONTAINER_PROJECT" "$CONTAINER_SERVICE" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({
  id: process.argv[3], image_id: process.argv[4], compose_project: process.argv[5], compose_service: process.argv[6],
}, null, 2) + "\n", { flag: "wx" });
NODE
CONTAINER_INSPECT="$RUN_ROOT/inputs/container-inspect.json"
CONTAINER_INSPECT_SHA="$(sha256_file "$CONTAINER_INSPECT")"

RELEASE_ID="$(docker exec "$APP_CONTAINER" printenv RELEASE_ID | tr -d '\r\n')"
[[ -n "$RELEASE_ID" ]] || { echo "measured image has no RELEASE_ID" >&2; exit 1; }
RELEASE_ID_SHA="$(printf '%s' "$RELEASE_ID" | sha256sum | awk '{print $1}')"
LIVE_DATABASE_FINGERPRINT="$(bash measurement/stack/measure-stack.sh database-fingerprint)"
[[ "$LIVE_DATABASE_FINGERPRINT" == "$DATABASE_FINGERPRINT" ]] || { echo "database fingerprint mismatch before producers" >&2; exit 1; }

node measurement/current-main-refresh/bin/create-immutable-inputs.mjs \
  --run-id "$RUN_ID" --side "$SIDE" --source-archive "$SOURCE_ARCHIVE" --source-sha256 "$SOURCE_SHA" --source-commit "$SOURCE_COMMIT" \
  --image-reference "$IMAGE_REFERENCE" --image-id "$IMAGE_ID" --oci-revision "$OCI_REVISION" \
  --database-archive "$DATABASE_ARCHIVE" --database-sha256 "$DATABASE_SHA" --database-fingerprint "$DATABASE_FINGERPRINT" \
  --census "$CENSUS" --census-sha256 "$CENSUS_SHA" --producer-files "$PRODUCER_FILES" --producer-files-sha256 "$PRODUCER_FILES_SHA" \
  --image-inspect "$IMAGE_INSPECT" --image-inspect-sha256 "$IMAGE_INSPECT_SHA" \
  --container-inspect "$CONTAINER_INSPECT" --container-inspect-sha256 "$CONTAINER_INSPECT_SHA" \
  --base-url "$BASE_URL" --compose-project "$COMPOSE_PROJECT" --release-id-sha256 "$RELEASE_ID_SHA" \
  --out "$RUN_ROOT/inputs/immutable-inputs.json"

export CORRECTNESS_RUN_ROOT="$RUN_ROOT"
export CORRECTNESS_RUN_ID="$RUN_ID"
export CORRECTNESS_SIDE="$SIDE"
export CORRECTNESS_CENSUS="$CENSUS"
export CORRECTNESS_BASE_URL="$BASE_URL"
export CORRECTNESS_APP_CONTAINER="$APP_CONTAINER"
export CORRECTNESS_POSTGRES_CONTAINER="$POSTGRES_CONTAINER"
export CORRECTNESS_AUTH_STATE="$AUTH_STATE"
export CORRECTNESS_STARTED_AT="$(utc_now)"

bash measurement/current-main-refresh/run-route-manifests.sh
bash measurement/current-main-refresh/run-cms-lifecycle.sh
if [[ "$SIDE" == current ]]; then
  bash measurement/current-main-refresh/run-source-census.sh
  bash measurement/current-main-refresh/run-wire-security.sh
  bash measurement/current-main-refresh/run-stored-404.sh
  bash measurement/current-main-refresh/run-adult-hosting-producer.sh
fi

DATABASE_AFTER="$(bash measurement/stack/measure-stack.sh database-fingerprint)"
[[ "$DATABASE_AFTER" == "$DATABASE_FINGERPRINT" ]] || { echo "database fingerprint changed across correctness producers" >&2; exit 1; }
HEALTH_BODY="$(curl -fsS "$BASE_URL/api/health")"
printf '%s' "$HEALTH_BODY" | node -e '
let body=""; process.stdin.on("data", (chunk) => body += chunk).on("end", () => {
  const parsed=JSON.parse(body); if (parsed?.status !== "healthy" || parsed?.checks?.db?.status !== "ok") throw new Error("app health is not healthy");
});'
mkdir "$RUN_ROOT/raw/orchestrator"
node - "$RUN_ROOT/raw/orchestrator/app-health.json" "$HEALTH_BODY" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(process.argv[3]);
fs.writeFileSync(process.argv[2], JSON.stringify(body, null, 2) + "\n", { flag: "wx" });
NODE
node - "$RUN_ROOT/postconditions.json" "$RUN_ID" "$SIDE" "$DATABASE_FINGERPRINT" "$DATABASE_AFTER" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({
  schema_version: 1,
  run_id: process.argv[3],
  side: process.argv[4],
  database_fingerprint_before: process.argv[5],
  database_fingerprint_after: process.argv[6],
  database_unchanged: process.argv[5] === process.argv[6],
  app_health: { status: "passed", evidence_paths: ["raw/orchestrator/app-health.json"] },
  completed_at: new Date().toISOString(),
}, null, 2) + "\n", { flag: "wx" });
NODE

release_lock
trap - EXIT
printf 'correctness producers completed without a final seal: %s\n' "$RUN_ROOT"
