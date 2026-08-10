#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

producer_begin source-census
: "${CORRECTNESS_APP_SOURCE_ARCHIVE:?CORRECTNESS_APP_SOURCE_ARCHIVE is required}"
: "${CORRECTNESS_APP_SOURCE_COMMIT:?CORRECTNESS_APP_SOURCE_COMMIT is required}"
: "${CORRECTNESS_WRITER_CENSUS:?CORRECTNESS_WRITER_CENSUS is required}"
node measurement/current-main-refresh/bin/generate-source-census.mjs \
  --expected "$CORRECTNESS_WRITER_CENSUS" \
  --app-source-archive "$CORRECTNESS_APP_SOURCE_ARCHIVE" \
  --app-source-commit "$CORRECTNESS_APP_SOURCE_COMMIT" \
  --out "$PRODUCER_RAW/source-census.json"
producer_write_cleanup_passed "read-only source census; no runtime state changed"

SOURCE_EVIDENCE="$(producer_relative "$PRODUCER_RAW/source-census.json")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {
    "check_id": "MC-03D",
    "outcome": "PASS",
    "assertions": [
      "the measured application archive exports a supported DELETE operation on src/app/api/admin/page-content/route.ts, hash-bound to the archive member",
      "that DELETE handler's own body clears public content through the canonical revalidatePublicPageContent helper, which the census independently resolves to revalidatePublicSite full-route plus tagged-data invalidation",
      "the endpoint still addresses a page by request-body id, which is the shape the cms-lifecycle runtime producer exercises",
      "structural evidence only; the runtime half of MC-03D is produced by cms-lifecycle against the running image and neither producer can pass this check alone"
    ],
    "evidence_paths": ["$SOURCE_EVIDENCE"]
  },
  {
    "check_id": "MC-04D",
    "outcome": "PASS",
    "assertions": [
      "all 39 source-discovered supported public writers are byte-identical to members of the supplied source archive, match the reviewed census, and resolve to the one canonical full-route plus tagged-data invalidation contract (or the exact direct root-layout form)",
      "focused unit, route, and real-server test sources are hash-bound as structural evidence; cms-lifecycle, public-layout-writers, and adult-hosting are honestly labelled representative runtime evidence rather than 39 exhaustive runtime mutations"
    ],
    "evidence_paths": ["$SOURCE_EVIDENCE"]
  }
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
