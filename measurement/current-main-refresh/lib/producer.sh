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

producer_refresh_app_container() {
  : "${CORRECTNESS_IMAGE_ID:?CORRECTNESS_IMAGE_ID is required}"
  CORRECTNESS_APP_CONTAINER="$(node measurement/current-main-refresh/bin/resolve-measure-container.mjs app --image-id "$CORRECTNESS_IMAGE_ID")"
  export CORRECTNESS_APP_CONTAINER
}

producer_complete_cleanup() {
  local cleanup_function="$1" cleanup_evidence="$2" cleanup_status
  CLEANUP_INVOKED=true
  set +e
  "$cleanup_function"
  cleanup_status=$?
  set -e
  trap - EXIT
  if [[ "$cleanup_status" -ne 0 ]]; then
    echo "producer cleanup failed with status $cleanup_status" >&2
    return "$cleanup_status"
  fi
  [[ -f "$cleanup_evidence" && ! -L "$cleanup_evidence" ]] || {
    echo "producer cleanup evidence is missing or unsafe: $cleanup_evidence" >&2
    return 1
  }
  node - "$cleanup_evidence" <<'NODE'
const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if(value?.status!=="passed")throw new Error("producer scenario cleanup evidence is not passed");
NODE
}

producer_source_guard_verify() {
  : "${PRODUCER_SOURCE_GUARD_TOOL:?PRODUCER_SOURCE_GUARD_TOOL is required}"
  : "${PRODUCER_SOURCE_GUARD_MANIFEST:?PRODUCER_SOURCE_GUARD_MANIFEST is required}"
  : "${PRODUCER_SOURCE_GUARD_ARCHIVE:?PRODUCER_SOURCE_GUARD_ARCHIVE is required}"
  : "${PRODUCER_SOURCE_GUARD_COMMIT:?PRODUCER_SOURCE_GUARD_COMMIT is required}"
  : "${PRODUCER_SOURCE_GUARD_LIVE_ROOT:?PRODUCER_SOURCE_GUARD_LIVE_ROOT is required}"
  local node_executable="${PRODUCER_SOURCE_GUARD_NODE:-node}"
  [[ -f "$PRODUCER_SOURCE_GUARD_MANIFEST" && ! -L "$PRODUCER_SOURCE_GUARD_MANIFEST" ]] || {
    echo "frozen producer source manifest is missing or unsafe" >&2
    return 1
  }
  (cd "$PRODUCER_SOURCE_GUARD_LIVE_ROOT" && sha256sum --check --strict --status "$PRODUCER_SOURCE_GUARD_MANIFEST") || {
    echo "live producer source bytes differ from the frozen manifest" >&2
    return 1
  }
  "$node_executable" "$PRODUCER_SOURCE_GUARD_TOOL" \
    --producer-source-archive "$PRODUCER_SOURCE_GUARD_ARCHIVE" \
    --producer-source-commit "$PRODUCER_SOURCE_GUARD_COMMIT" \
    --verify-live-root "$PRODUCER_SOURCE_GUARD_LIVE_ROOT" >/dev/null
}

producer_source_guard_invalidate_handoff() {
  : "${PRODUCER_SOURCE_GUARD_RUN_ROOT:?PRODUCER_SOURCE_GUARD_RUN_ROOT is required}"
  local root="$PRODUCER_SOURCE_GUARD_RUN_ROOT"
  [[ ( "$root" = /* || "$root" =~ ^[A-Za-z]:[/\\] ) && "$root" != / && ! "$root" =~ ^[A-Za-z]:[/\\]?$ && -d "$root" && ! -L "$root" ]] || {
    echo "refusing to invalidate handoff evidence under unsafe run root: $root" >&2
    return 1
  }
  rm -f -- "$root/postconditions.json" "$root/COMPLETED.json"
  rm -rf -- "$root/postcondition-evidence" "$root/raw/orchestrator"
}

producer_source_guard_final_check() {
  if producer_source_guard_verify; then return 0; fi
  producer_source_guard_invalidate_handoff || true
  echo "producer source changed; postcondition handoff evidence invalidated" >&2
  return 1
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
  shift || true
  local -a relative_paths=("$(producer_relative "$PRODUCER_RAW/cleanup.json")")
  local supporting
  for supporting in "$@"; do
    [[ "$supporting" != */* && -f "$PRODUCER_RAW/$supporting" && ! -L "$PRODUCER_RAW/$supporting" ]] || {
      echo "cleanup supporting evidence is invalid: $supporting" >&2
      return 1
    }
    relative_paths+=("$(producer_relative "$PRODUCER_RAW/$supporting")")
  done
  node - "$PRODUCER_RAW/cleanup.json" "$detail" "${relative_paths[@]:1}" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({
  schema_version: 1, status: "passed", detail: process.argv[3], supporting_evidence_paths: process.argv.slice(4),
}, null, 2) + "\n", { flag: "wx" });
NODE
  PRODUCER_CLEANUP_EVIDENCE="$(IFS=,; printf '%s' "${relative_paths[*]}")"
}

producer_finish() {
  local observations_file="$1"
  local cleanup_evidence="${2:-${PRODUCER_CLEANUP_EVIDENCE:-$(producer_relative "$PRODUCER_RAW/cleanup.json")}}"
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
    --cleanup-evidence "$cleanup_evidence" \
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
  local file="$1" label="${2:-$1}" cache
  cache="$(header_value "$file" cache-control)"
  [[ "$cache" == *private* && "$cache" == *no-store* && "$cache" != *s-maxage* && "$cache" != *stale-while-revalidate* ]] || {
    echo "$label has unsafe Cache-Control: $cache" >&2
    return 1
  }
}
