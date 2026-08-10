#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_BASE_URL:?CORRECTNESS_BASE_URL is required}"
: "${CORRECTNESS_APP_CONTAINER:?CORRECTNESS_APP_CONTAINER is required}"
: "${CORRECTNESS_POSTGRES_CONTAINER:?CORRECTNESS_POSTGRES_CONTAINER is required}"
: "${CORRECTNESS_IMAGE_REFERENCE:?CORRECTNESS_IMAGE_REFERENCE is required}"
producer_begin warm-db

ORIGINAL_EFFECTIVE="" ORIGINAL_SOURCE="" ORIGINAL_SOURCEFILE="" ORIGINAL_AUTO="__not_captured__"
LOGGING_ARMED=false CLEANUP_INVOKED=false
psql_scalar() { docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 -A -F $'\t' -t -c "$1" | tr -d '\r'; }

cleanup() {
  local original_status=$? failed=false effective source sourcefile
  trap - EXIT; set +e
  if [[ "$LOGGING_ARMED" == true ]]; then
    if [[ "$ORIGINAL_AUTO" == "__absent__" ]]; then
      docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
        -c 'ALTER SYSTEM RESET log_statement; SELECT pg_reload_conf();' > "$PRODUCER_RAW/cleanup-restore-logging.txt" 2>&1 || failed=true
    elif [[ "$ORIGINAL_AUTO" =~ ^(none|ddl|mod|all)$ ]]; then
      docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
        -c "ALTER SYSTEM SET log_statement='$ORIGINAL_AUTO'; SELECT pg_reload_conf();" > "$PRODUCER_RAW/cleanup-restore-logging.txt" 2>&1 || failed=true
    else failed=true; fi
    sleep 1
  fi
  effective="$(psql_scalar "SELECT current_setting('log_statement');" 2>/dev/null | tr -d '[:space:]')"
  source="$(psql_scalar "SELECT source FROM pg_settings WHERE name='log_statement';" 2>/dev/null | tr -d '[:space:]')"
  sourcefile="$(psql_scalar "SELECT coalesce(sourcefile,'') FROM pg_settings WHERE name='log_statement';" 2>/dev/null | tr -d '[:space:]')"
  [[ "$effective" == "$ORIGINAL_EFFECTIVE" && "$source" == "$ORIGINAL_SOURCE" && "$sourcefile" == "$ORIGINAL_SOURCEFILE" ]] || failed=true
  APP_IMAGE="$CORRECTNESS_IMAGE_REFERENCE" bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app \
    > "$PRODUCER_RAW/cleanup-recreate-app.txt" 2>&1 || failed=true
  producer_refresh_app_container || failed=true
  curl -fsS "$CORRECTNESS_BASE_URL/api/health" > "$PRODUCER_RAW/cleanup-health.json" || failed=true
  node - "$PRODUCER_RAW/logging-cleanup.json" "$([[ "$failed" == false ]] && echo passed || echo failed)" \
    "$ORIGINAL_EFFECTIVE" "$effective" "$ORIGINAL_SOURCE" "$source" "$ORIGINAL_SOURCEFILE" "$sourcefile" <<'NODE'
const fs=require("node:fs");fs.writeFileSync(process.argv[2],JSON.stringify({status:process.argv[3],before:{effective:process.argv[4],source:process.argv[6],sourcefile:process.argv[8]},after:{effective:process.argv[5],source:process.argv[7],sourcefile:process.argv[9]},app_recreated:process.argv[3]==="passed"},null,2)+"\n");
NODE
  local final=1; [[ "$original_status" -eq 0 && "$failed" == false ]] && final=0
  if [[ "$CLEANUP_INVOKED" == true ]]; then return "$final"; fi
  exit "$final"
}
trap cleanup EXIT

IFS=$'\t' read -r ORIGINAL_EFFECTIVE ORIGINAL_SOURCE ORIGINAL_SOURCEFILE < <(
  psql_scalar "SELECT setting,source,coalesce(sourcefile,'') FROM pg_settings WHERE name='log_statement';"
)
ORIGINAL_EFFECTIVE="${ORIGINAL_EFFECTIVE//[[:space:]]/}"
ORIGINAL_SOURCE="${ORIGINAL_SOURCE//[[:space:]]/}"
ORIGINAL_SOURCEFILE="${ORIGINAL_SOURCEFILE//[[:space:]]/}"
[[ "$ORIGINAL_EFFECTIVE" =~ ^(none|ddl|mod|all)$ && -n "$ORIGINAL_SOURCE" ]]
ORIGINAL_AUTO="$(psql_scalar "SELECT coalesce((SELECT setting FROM pg_file_settings WHERE name='log_statement' AND sourcefile LIKE '%postgresql.auto.conf' AND applied ORDER BY sourceline DESC LIMIT 1),'__absent__');" | tr -d "[:space:]'")"
[[ "$ORIGINAL_AUTO" == __absent__ || "$ORIGINAL_AUTO" =~ ^(none|ddl|mod|all)$ ]]
node - "$PRODUCER_RAW/logging-before.json" "$ORIGINAL_EFFECTIVE" "$ORIGINAL_SOURCE" "$ORIGINAL_SOURCEFILE" "$ORIGINAL_AUTO" <<'NODE'
const fs=require("node:fs");fs.writeFileSync(process.argv[2],JSON.stringify({effective:process.argv[3],source:process.argv[4],sourcefile:process.argv[5],auto_conf:process.argv[6]},null,2)+"\n");
NODE

LOGGING_ARMED=true
docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM SET log_statement='all'; SELECT pg_reload_conf();" > "$PRODUCER_RAW/enable-logging.txt"
sleep 1
[[ "$(psql_scalar "SELECT current_setting('log_statement');" | tr -d '[:space:]')" == all ]]
APP_IMAGE="$CORRECTNESS_IMAGE_REFERENCE" bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app \
  > "$PRODUCER_RAW/recreate-empty-cache.txt"
producer_refresh_app_container

LOG_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
COLD_START="ISSUE2352_${CORRECTNESS_RUN_ID}_COLD_START"
WARM_START="ISSUE2352_${CORRECTNESS_RUN_ID}_WARM_START"
WARM_END="ISSUE2352_${CORRECTNESS_RUN_ID}_WARM_END"
psql_scalar "SELECT '$COLD_START';" >/dev/null
status="$(curl -sS -D "$PRODUCER_RAW/cold.headers" -o "$PRODUCER_RAW/cold.body.html" -w '%{http_code}' "$CORRECTNESS_BASE_URL/about")"
[[ "$status" == 200 && "$(header_value "$PRODUCER_RAW/cold.headers" x-nextjs-cache)" == MISS ]]
psql_scalar "SELECT '$WARM_START';" >/dev/null
for attempt in 1 2 3; do
  status="$(curl -sS -D "$PRODUCER_RAW/warm-$attempt.headers" -o "$PRODUCER_RAW/warm-$attempt.body.html" -w '%{http_code}' "$CORRECTNESS_BASE_URL/about")"
  [[ "$status" == 200 && "$(header_value "$PRODUCER_RAW/warm-$attempt.headers" x-nextjs-cache)" == HIT ]]
  cmp -s "$PRODUCER_RAW/cold.body.html" "$PRODUCER_RAW/warm-$attempt.body.html"
done
psql_scalar "SELECT '$WARM_END';" >/dev/null
sleep 1
docker logs --since "$LOG_STARTED_AT" "$CORRECTNESS_POSTGRES_CONTAINER" > "$PRODUCER_RAW/postgres.log" 2>&1
awk -v start="$COLD_START" -v end="$WARM_START" 'index($0,start){on=1;next} index($0,end){on=0} on' "$PRODUCER_RAW/postgres.log" > "$PRODUCER_RAW/cold-window.log"
awk -v start="$WARM_START" -v end="$WARM_END" 'index($0,start){on=1;next} index($0,end){on=0} on' "$PRODUCER_RAW/postgres.log" > "$PRODUCER_RAW/warm-window.log"
COLD_COUNT="$(grep -Ec 'LOG:  (execute|statement)( |:)' "$PRODUCER_RAW/cold-window.log" || true)"
WARM_COUNT="$(grep -Ec 'LOG:  (execute|statement)( |:)' "$PRODUCER_RAW/warm-window.log" || true)"
printf 'cold_statement_count=%s\nwarm_statement_count=%s\n' "$COLD_COUNT" "$WARM_COUNT" > "$PRODUCER_RAW/counts.txt"
(( COLD_COUNT > 0 )) || { echo "cold request executed no visible DB statements" >&2; exit 1; }
(( WARM_COUNT == 0 )) || { echo "warm stored requests executed DB statements" >&2; exit 1; }

docker logs --since "$PRODUCER_STARTED_AT" "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/app-scenario.log" 2>&1
producer_complete_cleanup cleanup "$PRODUCER_RAW/logging-cleanup.json"
producer_write_cleanup_passed "Postgres log_statement source/value restored exactly and app recreated" \
  "logging-cleanup.json" "cleanup-restore-logging.txt" "cleanup-health.json"
COUNTS="$(producer_relative "$PRODUCER_RAW/counts.txt")"
WARM_LOG="$(producer_relative "$PRODUCER_RAW/warm-window.log")"
CLEANUP="$(producer_relative "$PRODUCER_RAW/logging-cleanup.json")"
cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"BND-08","outcome":"PASS","assertions":["cold /about was MISS and executed database statements; three byte-identical warm HIT requests executed zero database statements"],"evidence_paths":["$COUNTS","$WARM_LOG","$CLEANUP"]}
]
JSON
producer_finish "$PRODUCER_RAW/observations.json"
