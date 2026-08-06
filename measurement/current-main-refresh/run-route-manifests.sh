#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_APP_CONTAINER:?CORRECTNESS_APP_CONTAINER is required}"
producer_begin route-manifests

docker inspect "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/container-inspect.json"
mapfile -t manifest_roots < <(
  docker exec "$CORRECTNESS_APP_CONTAINER" sh -c \
    'find /app -type f -path "*/server/app-path-routes-manifest.json" -print' |
    sed 's#/server/app-path-routes-manifest.json$##'
)
[[ "${#manifest_roots[@]}" -eq 1 && -n "${manifest_roots[0]}" ]] || {
  echo "expected exactly one app-path-routes-manifest.json root, found ${#manifest_roots[@]}" >&2
  exit 1
}
manifest_root="${manifest_roots[0]}"
docker exec "$CORRECTNESS_APP_CONTAINER" cat "$manifest_root/server/app-path-routes-manifest.json" > "$PRODUCER_RAW/app-path-routes-manifest.json"
docker exec "$CORRECTNESS_APP_CONTAINER" cat "$manifest_root/prerender-manifest.json" > "$PRODUCER_RAW/prerender-manifest.json"
docker exec "$CORRECTNESS_APP_CONTAINER" cat "$manifest_root/routes-manifest.json" > "$PRODUCER_RAW/routes-manifest.json"

node measurement/current-main-refresh/bin/analyse-route-manifests.mjs \
  --side "$CORRECTNESS_SIDE" \
  --app-paths "$PRODUCER_RAW/app-path-routes-manifest.json" \
  --prerender "$PRODUCER_RAW/prerender-manifest.json" \
  --routes "$PRODUCER_RAW/routes-manifest.json" \
  --out "$PRODUCER_RAW/analysis.json"
producer_write_cleanup_passed "read-only image manifest extraction; no runtime state changed"

ANALYSIS="$(producer_relative "$PRODUCER_RAW/analysis.json")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {
    "check_id": "BND-01",
    "outcome": "PASS",
    "assertions": [
      "exact approved and narrowed routes exist in the image app-path manifest",
      "only current CMS catch-all enters the public ISR census",
      "four fixed routes and three narrowed routes remain outside prerender output"
    ],
    "evidence_paths": ["$ANALYSIS", "$(producer_relative "$PRODUCER_RAW/app-path-routes-manifest.json")", "$(producer_relative "$PRODUCER_RAW/prerender-manifest.json")", "$(producer_relative "$PRODUCER_RAW/routes-manifest.json")", "$(producer_relative "$PRODUCER_RAW/container-inspect.json")"]
  }
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
