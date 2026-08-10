#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

producer_begin log-noise
required=(
  raw/cache-fault/app-fault.log
  raw/cms-lifecycle/app-scenario.log
  raw/browser-suite/app-scenario.log
  raw/wire-security/app-scenario.log
  raw/stored-404/app-scenario.log
  raw/public-layout-writers/app-scenario.log
  raw/revalidation-300s/app-scenario.log
  raw/warm-db/app-scenario.log
  raw/adult-hosting/app-scenario.log
  raw/deploy-warmup/app-scenario.log
  raw/setup-transition/app-scenario.log
)
logs=()
for relative in "${required[@]}"; do
  path="$CORRECTNESS_RUN_ROOT/$relative"
  [[ -f "$path" && ! -L "$path" ]] || { echo "required scenario log missing: $relative" >&2; exit 1; }
  logs+=("$path")
done
node measurement/current-main-refresh/bin/analyse-log-noise.mjs --out "$PRODUCER_RAW/analysis.json" --logs "${logs[@]}"
producer_write_cleanup_passed "read-only analysis of the exact scenario log census"
ANALYSIS="$(producer_relative "$PRODUCER_RAW/analysis.json")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"MC-09","outcome":"PASS","assertions":["all miss/invalidation/revalidation producer logs were retained; no non-fault fatal line or warning/error signature repeated three times"],"evidence_paths":["$ANALYSIS"]}
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
