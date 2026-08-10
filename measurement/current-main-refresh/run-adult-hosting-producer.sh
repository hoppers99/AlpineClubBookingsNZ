#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

producer_begin adult-hosting
MEASURE_OUT_DIR="$PRODUCER_RAW" \
  bash measurement/current-main-refresh/run-adult-hosting-invalidation.sh

grep -Fqx 'PASS: adult-hosting policy write invalidated and replaced the warm CMS page.' \
  "$PRODUCER_RAW/summary.txt"
[[ -s "$PRODUCER_RAW/96-cleanup-functional.json" && -s "$PRODUCER_RAW/96-cleanup-counts.txt" ]] || {
  echo "adult-hosting probe returned without its cleanup evidence" >&2
  exit 1
}
docker logs --since "$PRODUCER_STARTED_AT" "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/app-scenario.log" 2>&1

producer_write_cleanup_passed \
  "probe rows/settings restored exactly; immutable audit entries retained as documented" \
  "96-cleanup-functional.json" "96-cleanup-counts.txt" "96-cleanup-metadata-residue.txt"
SUMMARY="$(producer_relative "$PRODUCER_RAW/summary.txt")"
TIMELINE="$(producer_relative "$PRODUCER_RAW/timeline.txt")"
CLEANUP="$(producer_relative "$PRODUCER_RAW/96-cleanup-functional.json")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"MC-04D","outcome":"PASS","assertions":["the adult-member-hosting writer invalidated an already warm CMS route and the next request rendered the changed policy"],"evidence_paths":["$SUMMARY","$TIMELINE","$CLEANUP"]},
  {"check_id":"BND-11","outcome":"PASS","assertions":["MISS, HIT, and post-invalidation responses all retained strict private,no-store and emitted no anonymous Set-Cookie"],"evidence_paths":["$SUMMARY","$TIMELINE"]}
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
