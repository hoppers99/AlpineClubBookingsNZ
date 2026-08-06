#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

producer_begin source-census
node measurement/current-main-refresh/bin/generate-source-census.mjs \
  --repo-root "$PWD" \
  --expected measurement/current-main-refresh/public-writer-census.json \
  --out "$PRODUCER_RAW/source-census.json"
producer_write_cleanup_passed "read-only source census; no runtime state changed"

SOURCE_EVIDENCE="$(producer_relative "$PRODUCER_RAW/source-census.json")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {
    "check_id": "MC-03D",
    "outcome": "OWNER_DISPOSITION_NEEDED",
    "assertions": [
      "page-content endpoint exports no DELETE operation",
      "absence of an endpoint is not itself an owner disposition",
      "producer never converts structural absence into PASS or NOT_APPLICABLE"
    ],
    "evidence_paths": ["$SOURCE_EVIDENCE"]
  },
  {
    "check_id": "MC-04D",
    "outcome": "UNVERIFIED",
    "assertions": [
      "source-level public revalidation writer census matches the reviewed list",
      "runtime coverage remains incomplete while any writer lacks a sealed runtime producer"
    ],
    "evidence_paths": ["$SOURCE_EVIDENCE"]
  }
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
