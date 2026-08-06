#!/usr/bin/env bash
set -euo pipefail

producer_require_environment() {
  : "${CORRECTNESS_RUN_ROOT:?CORRECTNESS_RUN_ROOT is required}"
  : "${CORRECTNESS_RUN_ID:?CORRECTNESS_RUN_ID is required}"
  : "${CORRECTNESS_SIDE:?CORRECTNESS_SIDE is required}"
  : "${CORRECTNESS_CENSUS:?CORRECTNESS_CENSUS is required}"
  [[ "$CORRECTNESS_RUN_ROOT" = /* ]] || {
    echo "CORRECTNESS_RUN_ROOT must be absolute" >&2
    return 1
  }
  [[ "$CORRECTNESS_SIDE" == current || "$CORRECTNESS_SIDE" == baseline ]] || {
    echo "CORRECTNESS_SIDE must be current or baseline" >&2
    return 1
  }
  [[ -f "$CORRECTNESS_CENSUS" ]] || {
    echo "CORRECTNESS_CENSUS does not exist" >&2
    return 1
  }
}
producer_begin() {
  producer_require_environment
  PRODUCER_ID="$1"
  PRODUCER_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  PRODUCER_RAW="$CORRECTNESS_RUN_ROOT/raw/$PRODUCER_ID"
  PRODUCER_RESULT="$CORRECTNESS_RUN_ROOT/producer-results/$PRODUCER_ID.json"
  [[ ! -e "$PRODUCER_RAW" ]] || {
    echo "$PRODUCER_RAW already exists; producer output is create-only" >&2
    return 1
  }
  [[ ! -e "$PRODUCER_RESULT" ]] || {
    echo "$PRODUCER_RESULT already exists; producer result is create-only" >&2
    return 1
  }
  mkdir "$PRODUCER_RAW"
}

producer_relative() {
  local absolute="$1"
  [[ "$absolute" == "$CORRECTNESS_RUN_ROOT/"* ]] || {
    echo "evidence path escapes run root: $absolute" >&2
    return 1
  }
  printf '%s\n' "${absolute#"$CORRECTNESS_RUN_ROOT/"}"
}

producer_write_cleanup_passed() {
  local detail="${1:-no mutable state was changed}"
  printf '{"schema_version":1,"status":"passed","detail":%s}\n' \
    "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$detail")" \
    > "$PRODUCER_RAW/cleanup.json"
}

producer_finish() {
  local observations_file="$1"
  local cleanup_file="${2:-$PRODUCER_RAW/cleanup.json}"
  local exit_code="${3:-0}"
  local ended_at
  ended_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  node measurement/current-main-refresh/lib/write-producer-result.mjs \
    --run-root "$CORRECTNESS_RUN_ROOT" \
    --run-id "$CORRECTNESS_RUN_ID" \
    --producer-id "$PRODUCER_ID" \
    --side "$CORRECTNESS_SIDE" \
    --started-at "$PRODUCER_STARTED_AT" \
    --ended-at "$ended_at" \
    --exit-code "$exit_code" \
    --observations "$observations_file" \
    --cleanup-evidence "$(producer_relative "$cleanup_file")" \
    --census "$CORRECTNESS_CENSUS" \
    --out "$PRODUCER_RESULT"
}

header_value() {
  local file="$1" name="$2"
  awk -v wanted="${name,,}:" '
    tolower($1) == wanted {
      sub(/^[^:]+:[[:space:]]*/, "")
      sub(/\r$/, "")
      value=$0
    }
    END { print value }
  ' "$file"
}

assert_private_no_store() {
  local file="$1" label="$2" cache
  cache="$(header_value "$file" cache-control)"
  [[ "$cache" == *private* && "$cache" == *no-store* && "$cache" != *s-maxage* && "$cache" != *stale-while-revalidate* ]] || {
    echo "$label has unsafe Cache-Control: $cache" >&2
    return 1
  }
}
