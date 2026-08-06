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
  --app-source-archive ABS --app-source-sha256 HEX --app-source-commit HEX \
  --producer-source-archive ABS --producer-source-sha256 HEX --producer-source-commit HEX \
  --image-reference IMMUTABLE --image-id sha256:HEX --oci-revision HEX \
  --database-archive ABS --database-sha256 HEX --database-fingerprint HEX \
  --app-container NAME --postgres-container NAME --auth-state ABS \
  [--base-url http://127.0.0.1:8027] [--mailpit-url http://127.0.0.1:8127] [--compose-project tacbookings-measure]
EOF
  exit 2
}

RUN_ROOT="" RUN_ID="" SIDE="" APP_SOURCE_ARCHIVE="" APP_SOURCE_SHA="" APP_SOURCE_COMMIT=""
PRODUCER_SOURCE_ARCHIVE="" PRODUCER_SOURCE_SHA="" PRODUCER_SOURCE_COMMIT=""
IMAGE_REFERENCE="" IMAGE_ID="" OCI_REVISION="" DATABASE_ARCHIVE="" DATABASE_SHA="" DATABASE_FINGERPRINT=""
APP_CONTAINER="" POSTGRES_CONTAINER="" AUTH_STATE="" BASE_URL="http://127.0.0.1:8027" MAILPIT_URL="http://127.0.0.1:8127" COMPOSE_PROJECT="tacbookings-measure"
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --run-root) RUN_ROOT="$2";; --run-id) RUN_ID="$2";; --side) SIDE="$2";;
    --app-source-archive) APP_SOURCE_ARCHIVE="$2";; --app-source-sha256) APP_SOURCE_SHA="$2";; --app-source-commit) APP_SOURCE_COMMIT="$2";;
    --producer-source-archive) PRODUCER_SOURCE_ARCHIVE="$2";; --producer-source-sha256) PRODUCER_SOURCE_SHA="$2";; --producer-source-commit) PRODUCER_SOURCE_COMMIT="$2";;
    --image-reference) IMAGE_REFERENCE="$2";; --image-id) IMAGE_ID="$2";; --oci-revision) OCI_REVISION="$2";;
    --database-archive) DATABASE_ARCHIVE="$2";; --database-sha256) DATABASE_SHA="$2";; --database-fingerprint) DATABASE_FINGERPRINT="$2";;
    --app-container) APP_CONTAINER="$2";; --postgres-container) POSTGRES_CONTAINER="$2";; --auth-state) AUTH_STATE="$2";;
    --base-url) BASE_URL="$2";; --mailpit-url) MAILPIT_URL="$2";; --compose-project) COMPOSE_PROJECT="$2";; *) usage;;
  esac
  shift 2
done
for value in RUN_ROOT RUN_ID SIDE APP_SOURCE_ARCHIVE APP_SOURCE_SHA APP_SOURCE_COMMIT PRODUCER_SOURCE_ARCHIVE PRODUCER_SOURCE_SHA PRODUCER_SOURCE_COMMIT IMAGE_REFERENCE IMAGE_ID OCI_REVISION DATABASE_ARCHIVE DATABASE_SHA DATABASE_FINGERPRINT APP_CONTAINER POSTGRES_CONTAINER AUTH_STATE; do
  [[ -n "${!value}" ]] || { echo "$value is required" >&2; usage; }
done
[[ "$RUN_ROOT" = /* || "$RUN_ROOT" =~ ^[A-Za-z]:[/\\] ]] || { echo "run root must be absolute" >&2; exit 1; }
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "invalid run id" >&2; exit 1; }
[[ "$SIDE" == current || "$SIDE" == baseline ]] || { echo "invalid side" >&2; exit 1; }
[[ "$PRODUCER_SOURCE_COMMIT" =~ ^[a-f0-9]{40,64}$ ]] || { echo "invalid producer source commit" >&2; exit 1; }
if [[ "$SIDE" == current ]]; then EXPECTED_APP_SOURCE_COMMIT="bfe53aeab6dd54ed5bfcf3636a1643451f277bef"; else EXPECTED_APP_SOURCE_COMMIT="f442e389e0e5d4c2e18fa330b2fb155550b12871"; fi
[[ "$APP_SOURCE_COMMIT" == "$EXPECTED_APP_SOURCE_COMMIT" ]] || { echo "$SIDE application source commit is not the approved target" >&2; exit 1; }
[[ "$PRODUCER_SOURCE_COMMIT" != "$APP_SOURCE_COMMIT" && "$PRODUCER_SOURCE_SHA" != "$APP_SOURCE_SHA" ]] || { echo "producer and application source authorities must be distinct" >&2; exit 1; }
GIT_TOP="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
[[ "$GIT_TOP" == "$PWD" ]] || { echo "runner must start at the producer integration worktree root" >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$PRODUCER_SOURCE_COMMIT" ]] || { echo "live producer worktree is not the producer source commit" >&2; exit 1; }
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] || { echo "live producer worktree is dirty" >&2; exit 1; }

FROZEN_PRODUCER_ROOT=""
cleanup_frozen_producer() {
  [[ -n "$FROZEN_PRODUCER_ROOT" ]] || return 0
  [[ "$FROZEN_PRODUCER_ROOT" == /tmp/issue-2352-producer-source.* && -d "$FROZEN_PRODUCER_ROOT" && ! -L "$FROZEN_PRODUCER_ROOT" ]] || {
    echo "refusing to remove unsafe frozen producer root: $FROZEN_PRODUCER_ROOT" >&2
    return 1
  }
  rm -rf -- "$FROZEN_PRODUCER_ROOT"
  FROZEN_PRODUCER_ROOT=""
}
FROZEN_PRODUCER_ROOT="$(mktemp -d /tmp/issue-2352-producer-source.XXXXXX)"
trap 'status=$?; trap - EXIT; cleanup_frozen_producer || status=1; exit "$status"' EXIT
git archive --format=tar "$PRODUCER_SOURCE_COMMIT" -- \
  measurement/current-main-refresh measurement/phase2 measurement/stack docker-compose.yml Caddyfile.staging |
  tar -xf - -C "$FROZEN_PRODUCER_ROOT"
source "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/lib/producer.sh"
NODE_PROCESS_PATH="$(node -p 'process.execPath')"
if command -v cygpath >/dev/null 2>&1; then
  PRODUCER_SOURCE_GUARD_NODE="$(cygpath -u "$NODE_PROCESS_PATH")"
else
  PRODUCER_SOURCE_GUARD_NODE="$NODE_PROCESS_PATH"
fi
[[ "$PRODUCER_SOURCE_GUARD_NODE" = /* && -f "$PRODUCER_SOURCE_GUARD_NODE" && ! -L "$PRODUCER_SOURCE_GUARD_NODE" ]] || { echo "Node executable is not an absolute canonical regular file" >&2; exit 1; }
export PATH="$(dirname "$PRODUCER_SOURCE_GUARD_NODE"):$PATH"
[[ "$(node -p 'process.execPath')" == "$NODE_PROCESS_PATH" ]] || { echo "Node executable changed while binding the producer runtime" >&2; exit 1; }
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo "correctness producers require Node 24" >&2; exit 1; }
PRODUCER_SOURCE_GUARD_TOOL="$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/build-producer-manifest.mjs"
PRODUCER_SOURCE_GUARD_MANIFEST="$FROZEN_PRODUCER_ROOT/producer-files.sha256"
PRODUCER_SOURCE_GUARD_ARCHIVE="$PRODUCER_SOURCE_ARCHIVE"
PRODUCER_SOURCE_GUARD_COMMIT="$PRODUCER_SOURCE_COMMIT"
PRODUCER_SOURCE_GUARD_LIVE_ROOT="$PWD"
"$PRODUCER_SOURCE_GUARD_NODE" "$PRODUCER_SOURCE_GUARD_TOOL" \
  --producer-source-archive "$PRODUCER_SOURCE_ARCHIVE" --producer-source-commit "$PRODUCER_SOURCE_COMMIT" \
  --out "$PRODUCER_SOURCE_GUARD_MANIFEST"
export PRODUCER_SOURCE_GUARD_NODE PRODUCER_SOURCE_GUARD_TOOL PRODUCER_SOURCE_GUARD_MANIFEST PRODUCER_SOURCE_GUARD_ARCHIVE PRODUCER_SOURCE_GUARD_COMMIT PRODUCER_SOURCE_GUARD_LIVE_ROOT
producer_source_guard_verify
"$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/validate-orchestrator-inputs.mjs" \
  --compose-project "$COMPOSE_PROJECT" --app-container "$APP_CONTAINER" --postgres-container "$POSTGRES_CONTAINER" \
  --base-url "$BASE_URL" --mailpit-url "$MAILPIT_URL" --auth-state "$AUTH_STATE"

sha256_file() { sha256sum "$1" | awk '{print $1}'; }
utc_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
[[ -f "$APP_SOURCE_ARCHIVE" && "$(sha256_file "$APP_SOURCE_ARCHIVE")" == "$APP_SOURCE_SHA" ]] || { echo "application source archive checksum mismatch" >&2; exit 1; }
[[ -f "$PRODUCER_SOURCE_ARCHIVE" && "$(sha256_file "$PRODUCER_SOURCE_ARCHIVE")" == "$PRODUCER_SOURCE_SHA" ]] || { echo "producer source archive checksum mismatch" >&2; exit 1; }
[[ -f "$DATABASE_ARCHIVE" && "$(sha256_file "$DATABASE_ARCHIVE")" == "$DATABASE_SHA" ]] || { echo "database archive checksum mismatch" >&2; exit 1; }

APP_CONTAINER="$("$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/resolve-measure-container.mjs" app --image-id "$IMAGE_ID")"
POSTGRES_CONTAINER="$("$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/resolve-measure-container.mjs" postgres)"
CADDY_CONTAINER="$("$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/resolve-measure-container.mjs" caddy)"
MAILPIT_CONTAINER="$("$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/resolve-measure-container.mjs" mailpit)"

[[ ! -e "$RUN_ROOT" ]] || { echo "run root already exists: $RUN_ROOT" >&2; exit 1; }
mkdir "$RUN_ROOT"
mkdir "$RUN_ROOT/inputs" "$RUN_ROOT/raw" "$RUN_ROOT/producer-results"
RUN_ROOT="$(cd "$RUN_ROOT" && pwd -P)"
PRODUCER_SOURCE_GUARD_RUN_ROOT="$RUN_ROOT"
export PRODUCER_SOURCE_GUARD_RUN_ROOT
"$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/runtime-provenance.mjs" --root "$PWD" --out "$RUN_ROOT/inputs/runtime-provenance.json"
RUNTIME_PROVENANCE="$RUN_ROOT/inputs/runtime-provenance.json"
RUNTIME_PROVENANCE_SHA="$(sha256_file "$RUNTIME_PROVENANCE")"

LOCK_DIR="/tmp/tacbookings-issue-2352-correctness.lock"
LOCK_HELD=false
HANDOFF_EVIDENCE_ARMED=false
release_lock() {
  if [[ "$LOCK_HELD" == true ]]; then
    docker exec "$POSTGRES_CONTAINER" rmdir "$LOCK_DIR" >/dev/null || {
      echo "failed to release correctness lock $LOCK_DIR" >&2
      return 1
    }
    LOCK_HELD=false
  fi
}
session_exit() {
  local status=$?
  trap - EXIT
  if [[ "$HANDOFF_EVIDENCE_ARMED" == true ]]; then producer_source_guard_invalidate_handoff || status=1; fi
  release_lock || status=1
  cleanup_frozen_producer || status=1
  exit "$status"
}
trap session_exit EXIT
docker exec "$POSTGRES_CONTAINER" mkdir "$LOCK_DIR" || {
  echo "another correctness run is active, or stale lock needs review: $LOCK_DIR" >&2
  exit 1
}
LOCK_HELD=true

"$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/extract-archive-member.mjs" \
  --archive "$PRODUCER_SOURCE_ARCHIVE" --commit "$PRODUCER_SOURCE_COMMIT" \
  --member measurement/current-main-refresh/check-census.json --out "$RUN_ROOT/inputs/check-census.json"
CENSUS="$RUN_ROOT/inputs/check-census.json"
CENSUS_SHA="$(sha256_file "$CENSUS")"
"$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/extract-archive-member.mjs" \
  --archive "$PRODUCER_SOURCE_ARCHIVE" --commit "$PRODUCER_SOURCE_COMMIT" \
  --member measurement/current-main-refresh/public-writer-census.json --out "$RUN_ROOT/inputs/public-writer-census.json"
WRITER_CENSUS="$RUN_ROOT/inputs/public-writer-census.json"
WRITER_CENSUS_SHA="$(sha256_file "$WRITER_CENSUS")"
cp "$PRODUCER_SOURCE_GUARD_MANIFEST" "$RUN_ROOT/inputs/producer-files.sha256"
PRODUCER_FILES="$RUN_ROOT/inputs/producer-files.sha256"
PRODUCER_FILES_SHA="$(sha256_file "$PRODUCER_FILES")"

ACTUAL_IMAGE_ID="$(docker image inspect "$IMAGE_REFERENCE" --format '{{.Id}}')"
ACTUAL_REVISION="$(docker image inspect "$IMAGE_REFERENCE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$ACTUAL_IMAGE_ID" == "$IMAGE_ID" && "$ACTUAL_REVISION" == "$OCI_REVISION" && "$ACTUAL_REVISION" == "$APP_SOURCE_COMMIT" ]] || {
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

docker exec -i "$APP_CONTAINER" node --input-type=module - "$IMAGE_ID" "$OCI_REVISION" \
  < "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/scan-image-build.mjs" \
  > "$RUN_ROOT/inputs/image-build-scan.raw.json"
IMAGE_BUILD_RAW="$RUN_ROOT/inputs/image-build-scan.raw.json"
docker exec "$APP_CONTAINER" node -e '
const imageId=process.argv[1]; const value=process.env.NEXT_PUBLIC_SENTRY_DSN;
process.stdout.write(JSON.stringify({schema_version:1,image_id:imageId,present:value!==undefined,blank:value===undefined||value===""},null,2)+"\n");
' "$IMAGE_ID" > "$RUN_ROOT/inputs/image-build-runtime-env.json"
IMAGE_BUILD_RUNTIME="$RUN_ROOT/inputs/image-build-runtime-env.json"
"$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/validate-image-build-scan.mjs" \
  --run-root "$RUN_ROOT" --image-id "$IMAGE_ID" --oci-revision "$OCI_REVISION" \
  --raw "$IMAGE_BUILD_RAW" --runtime-env "$IMAGE_BUILD_RUNTIME" \
  --out "$RUN_ROOT/inputs/image-build-identity.json"
IMAGE_BUILD_EVIDENCE="$RUN_ROOT/inputs/image-build-identity.json"
IMAGE_BUILD_RAW_SHA="$(sha256_file "$IMAGE_BUILD_RAW")"
IMAGE_BUILD_RUNTIME_SHA="$(sha256_file "$IMAGE_BUILD_RUNTIME")"
IMAGE_BUILD_EVIDENCE_SHA="$(sha256_file "$IMAGE_BUILD_EVIDENCE")"

RELEASE_ID="$(docker exec "$APP_CONTAINER" printenv RELEASE_ID | tr -d '\r\n')"
[[ -n "$RELEASE_ID" ]] || { echo "measured image has no RELEASE_ID" >&2; exit 1; }
RELEASE_ID_SHA="$(printf '%s' "$RELEASE_ID" | sha256sum | awk '{print $1}')"
LIVE_DATABASE_FINGERPRINT="$(bash measurement/stack/measure-stack.sh database-fingerprint)"
[[ "$LIVE_DATABASE_FINGERPRINT" == "$DATABASE_FINGERPRINT" ]] || { echo "database fingerprint mismatch before producers" >&2; exit 1; }

capture_stack_component_evidence() {
  local directory="$1" stage="$2" fingerprint="$3"
  docker inspect "$APP_CONTAINER" --format '{"schema_version":1,"service":"app","container_id":"{{.Id}}","image_id":"{{.Image}}","compose_project":"{{index .Config.Labels "com.docker.compose.project"}}","compose_service":"{{index .Config.Labels "com.docker.compose.service"}}","network_mode":"{{.HostConfig.NetworkMode}}","networks":{{json .NetworkSettings.Networks}},"ports":{{json .NetworkSettings.Ports}}}' \
    > "$directory/app-container-inspect.json"
  docker inspect "$POSTGRES_CONTAINER" --format '{"schema_version":1,"service":"postgres","container_id":"{{.Id}}","image_id":"{{.Image}}","compose_project":"{{index .Config.Labels "com.docker.compose.project"}}","compose_service":"{{index .Config.Labels "com.docker.compose.service"}}","network_mode":"{{.HostConfig.NetworkMode}}","networks":{{json .NetworkSettings.Networks}},"ports":{{json .NetworkSettings.Ports}}}' \
    > "$directory/postgres-container-inspect.json"
  docker exec "$POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 -tAc \
    "SELECT json_build_object('schema_version',1,'version',current_setting('server_version'),'version_num',current_setting('server_version_num'),'database',current_database(),'user',current_user);" \
    > "$directory/postgres-server-version.json"
  node - "$directory/database-fingerprint.json" "$fingerprint" <<'NODE'
const fs=require("node:fs");
if(!/^[a-f0-9]{64}$/.test(process.argv[3])) throw new Error("database fingerprint is invalid");
fs.writeFileSync(process.argv[2],JSON.stringify({schema_version:1,logical_fingerprint:process.argv[3]},null,2)+"\n",{flag:"wx"});
NODE
  "$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/build-stack-identity.mjs" \
    --run-root "$RUN_ROOT" --stage "$stage" --compose-project "$COMPOSE_PROJECT" --image-id "$IMAGE_ID" --database-fingerprint "$fingerprint" \
    --app "$directory/app-container-inspect.json" --postgres "$directory/postgres-container-inspect.json" \
    --postgres-server "$directory/postgres-server-version.json" --database "$directory/database-fingerprint.json" \
    --out "$directory/stack-identity-$stage.json"
}
capture_stack_component_evidence "$RUN_ROOT/inputs" before "$LIVE_DATABASE_FINGERPRINT"
STACK_IDENTITY_BEFORE="$RUN_ROOT/inputs/stack-identity-before.json"
STACK_IDENTITY_BEFORE_SHA="$(sha256_file "$STACK_IDENTITY_BEFORE")"

"$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/create-immutable-inputs.mjs" \
  --run-id "$RUN_ID" --side "$SIDE" --app-source-archive "$APP_SOURCE_ARCHIVE" --app-source-sha256 "$APP_SOURCE_SHA" --app-source-commit "$APP_SOURCE_COMMIT" \
  --producer-source-archive "$PRODUCER_SOURCE_ARCHIVE" --producer-source-sha256 "$PRODUCER_SOURCE_SHA" --producer-source-commit "$PRODUCER_SOURCE_COMMIT" \
  --image-reference "$IMAGE_REFERENCE" --image-id "$IMAGE_ID" --oci-revision "$OCI_REVISION" \
  --database-archive "$DATABASE_ARCHIVE" --database-sha256 "$DATABASE_SHA" --database-fingerprint "$DATABASE_FINGERPRINT" \
  --census "$CENSUS" --census-sha256 "$CENSUS_SHA" --writer-census "$WRITER_CENSUS" --writer-census-sha256 "$WRITER_CENSUS_SHA" \
  --producer-files "$PRODUCER_FILES" --producer-files-sha256 "$PRODUCER_FILES_SHA" \
  --image-inspect "$IMAGE_INSPECT" --image-inspect-sha256 "$IMAGE_INSPECT_SHA" \
  --container-inspect "$CONTAINER_INSPECT" --container-inspect-sha256 "$CONTAINER_INSPECT_SHA" \
  --image-build-raw "$IMAGE_BUILD_RAW" --image-build-raw-sha256 "$IMAGE_BUILD_RAW_SHA" \
  --image-build-evidence "$IMAGE_BUILD_EVIDENCE" --image-build-evidence-sha256 "$IMAGE_BUILD_EVIDENCE_SHA" \
  --image-build-runtime "$IMAGE_BUILD_RUNTIME" --image-build-runtime-sha256 "$IMAGE_BUILD_RUNTIME_SHA" \
  --runtime-provenance "$RUNTIME_PROVENANCE" --runtime-provenance-sha256 "$RUNTIME_PROVENANCE_SHA" \
  --stack-identity-before "$STACK_IDENTITY_BEFORE" --stack-identity-before-sha256 "$STACK_IDENTITY_BEFORE_SHA" \
  --base-url "$BASE_URL" --compose-project "$COMPOSE_PROJECT" --release-id-sha256 "$RELEASE_ID_SHA" \
  --out "$RUN_ROOT/inputs/immutable-inputs.json"

export CORRECTNESS_RUN_ROOT="$RUN_ROOT"
export CORRECTNESS_RUN_ID="$RUN_ID"
export CORRECTNESS_SIDE="$SIDE"
export CORRECTNESS_CENSUS="$CENSUS"
export CORRECTNESS_BASE_URL="$BASE_URL"
export CORRECTNESS_APP_CONTAINER="$APP_CONTAINER"
export CORRECTNESS_POSTGRES_CONTAINER="$POSTGRES_CONTAINER"
export CORRECTNESS_CADDY_CONTAINER="$CADDY_CONTAINER"
export CORRECTNESS_MAILPIT_CONTAINER="$MAILPIT_CONTAINER"
export CORRECTNESS_AUTH_STATE="$AUTH_STATE"
export CORRECTNESS_MAILPIT_URL="$MAILPIT_URL"
export CORRECTNESS_IMAGE_REFERENCE="$IMAGE_REFERENCE"
export CORRECTNESS_IMAGE_ID="$IMAGE_ID"
export CORRECTNESS_COMPOSE_PROJECT="$COMPOSE_PROJECT"
export CORRECTNESS_APP_SOURCE_ARCHIVE="$APP_SOURCE_ARCHIVE"
export CORRECTNESS_APP_SOURCE_COMMIT="$APP_SOURCE_COMMIT"
export CORRECTNESS_PRODUCER_SOURCE_COMMIT="$PRODUCER_SOURCE_COMMIT"
export CORRECTNESS_RUNTIME_PROVENANCE="$RUNTIME_PROVENANCE"
export CORRECTNESS_WRITER_CENSUS="$WRITER_CENSUS"
export CORRECTNESS_STARTED_AT="$(utc_now)"

refresh_measure_container_ids() {
  CORRECTNESS_APP_CONTAINER="$("$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/resolve-measure-container.mjs" app --image-id "$IMAGE_ID")"
  CORRECTNESS_POSTGRES_CONTAINER="$("$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/resolve-measure-container.mjs" postgres)"
  CORRECTNESS_CADDY_CONTAINER="$("$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/resolve-measure-container.mjs" caddy)"
  CORRECTNESS_MAILPIT_CONTAINER="$("$PRODUCER_SOURCE_GUARD_NODE" "$FROZEN_PRODUCER_ROOT/measurement/current-main-refresh/bin/resolve-measure-container.mjs" mailpit)"
  export CORRECTNESS_APP_CONTAINER CORRECTNESS_POSTGRES_CONTAINER CORRECTNESS_CADDY_CONTAINER CORRECTNESS_MAILPIT_CONTAINER
  APP_CONTAINER="$CORRECTNESS_APP_CONTAINER"
  POSTGRES_CONTAINER="$CORRECTNESS_POSTGRES_CONTAINER"
  CADDY_CONTAINER="$CORRECTNESS_CADDY_CONTAINER"
  MAILPIT_CONTAINER="$CORRECTNESS_MAILPIT_CONTAINER"
}
run_producer() {
  producer_source_guard_verify
  refresh_measure_container_ids
  bash "$1"
  refresh_measure_container_ids
  producer_source_guard_verify
}

run_producer measurement/current-main-refresh/run-route-manifests.sh
run_producer measurement/current-main-refresh/run-cms-lifecycle.sh
if [[ "$SIDE" == current ]]; then
  run_producer measurement/current-main-refresh/run-cache-fault.sh
  run_producer measurement/current-main-refresh/run-source-census.sh
  run_producer measurement/current-main-refresh/run-browser-suite.sh
  run_producer measurement/current-main-refresh/run-wire-security.sh
  run_producer measurement/current-main-refresh/run-stored-404.sh
  run_producer measurement/current-main-refresh/run-public-layout-writers.sh
  run_producer measurement/current-main-refresh/run-setup-transition.sh
  run_producer measurement/current-main-refresh/run-revalidation-300s.sh
  run_producer measurement/current-main-refresh/run-warm-db.sh
  run_producer measurement/current-main-refresh/run-adult-hosting-producer.sh
  run_producer measurement/current-main-refresh/run-deploy-warmup.sh
  run_producer measurement/current-main-refresh/run-log-noise.sh
fi

producer_source_guard_verify
RESTORED_DATABASE_FINGERPRINT="$(bash measurement/stack/measure-stack.sh restore-canonical-dump "$DATABASE_ARCHIVE" "$DATABASE_SHA")"
[[ "$RESTORED_DATABASE_FINGERPRINT" == "$DATABASE_FINGERPRINT" ]] || { echo "canonical database restore did not recover the input fingerprint" >&2; exit 1; }
producer_source_guard_verify
APP_IMAGE="$IMAGE_REFERENCE" bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app caddy
refresh_measure_container_ids
RESTORED_IMAGE_ID="$(docker inspect "$APP_CONTAINER" --format '{{.Image}}')"
[[ "$RESTORED_IMAGE_ID" == "$IMAGE_ID" ]] || { echo "restored app container does not run the selected immutable image" >&2; exit 1; }
DATABASE_AFTER="$(bash measurement/stack/measure-stack.sh database-fingerprint)"
[[ "$DATABASE_AFTER" == "$DATABASE_FINGERPRINT" ]] || { echo "database fingerprint changed after canonical restore" >&2; exit 1; }
producer_source_guard_verify
HEALTH_BODY="$(curl -fsS "$BASE_URL/api/health")"
printf '%s' "$HEALTH_BODY" | node -e '
let body=""; process.stdin.on("data", (chunk) => body += chunk).on("end", () => {
  const parsed=JSON.parse(body); if (parsed?.status !== "healthy" || parsed?.checks?.db?.status !== "ok") throw new Error("app health is not healthy");
});'
producer_source_guard_verify
HANDOFF_EVIDENCE_ARMED=true
mkdir "$RUN_ROOT/postcondition-evidence"
capture_stack_component_evidence "$RUN_ROOT/postcondition-evidence" after "$DATABASE_AFTER"
mkdir "$RUN_ROOT/raw/orchestrator"
node - "$RUN_ROOT/raw/orchestrator/app-health.json" "$HEALTH_BODY" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(process.argv[3]);
fs.writeFileSync(process.argv[2], JSON.stringify(body, null, 2) + "\n", { flag: "wx" });
NODE
producer_source_guard_verify
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

producer_source_guard_final_check
release_lock
producer_source_guard_final_check
HANDOFF_EVIDENCE_ARMED=false
cleanup_frozen_producer
trap - EXIT
printf 'correctness producers completed without a final seal: %s\n' "$RUN_ROOT"
