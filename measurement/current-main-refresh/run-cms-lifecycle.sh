#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_BASE_URL:?CORRECTNESS_BASE_URL is required}"
: "${CORRECTNESS_AUTH_STATE:?CORRECTNESS_AUTH_STATE is required}"
: "${CORRECTNESS_APP_CONTAINER:?CORRECTNESS_APP_CONTAINER is required}"
: "${CORRECTNESS_POSTGRES_CONTAINER:?CORRECTNESS_POSTGRES_CONTAINER is required}"
: "${CORRECTNESS_IMAGE_REFERENCE:?CORRECTNESS_IMAGE_REFERENCE is required}"
: "${CORRECTNESS_IMAGE_ID:?CORRECTNESS_IMAGE_ID is required}"
producer_begin cms-lifecycle

SLUG="measure-cms-lifecycle-$CORRECTNESS_RUN_ID"
PATHNAME="/$SLUG"
TITLE="Correctness CMS lifecycle $CORRECTNESS_RUN_ID"
V1="cms-lifecycle-v1-$CORRECTNESS_RUN_ID"
V2="cms-lifecycle-v2-$CORRECTNESS_RUN_ID"
COOKIE=""
PAGE_ID=""
PAGE_ARMED=false
PAGE_RECOVERY_ALLOWED=false
# Set only once the supported DELETE endpoint has removed the row AND that
# removal has been verified in the database. Cleanup then skips its own
# unpublish-and-raw-delete path, because the product's supported lifecycle step
# already performed it; it still proves the row is gone.
PAGE_DELETED_VIA_API=false
AUDIT_BEFORE=""
CLEANUP_INVOKED=false

psql_scalar() {
  docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 -tAc "$1" | tr -d '[:space:]'
}
api() {
  local method="$1" path="$2" output="$3" payload="${4:-}" status
  local -a args=(-sS -o "$output" -w '%{http_code}' -X "$method" -H "Cookie: $COOKIE" -H 'Content-Type: application/json')
  [[ -n "$payload" ]] && args+=(--data-binary "@$payload")
  status="$(curl "${args[@]}" "$CORRECTNESS_BASE_URL$path")"
  printf '%s\n' "$status" > "$output.status"
  [[ "$status" =~ ^2[0-9][0-9]$ ]]
}
capture() {
  local label="$1" cookie="${2:-}" status
  local -a args=(-sS -D "$PRODUCER_RAW/$label.headers" -o "$PRODUCER_RAW/$label.body.html" -w '%{http_code}')
  [[ -n "$cookie" ]] && args+=(-H "Cookie: $cookie")
  status="$(curl "${args[@]}" "$CORRECTNESS_BASE_URL$PATHNAME")"
  printf '%s\n' "$status" > "$PRODUCER_RAW/$label.status"
}
# A public route that is NOT the disposable page, used by MC-03D to tell the two
# reasons a deleted address could 404 apart: the row simply being gone, versus
# the canonical site-wide public-content invalidation actually firing. Same
# convention `public-layout-writers` uses for its own warm-/about sequences.
capture_about() {
  local label="$1" status
  status="$(curl -sS -D "$PRODUCER_RAW/$label.headers" -o "$PRODUCER_RAW/$label.body.html" -w '%{http_code}' "$CORRECTNESS_BASE_URL/about")"
  [[ "$status" == 200 ]]
  assert_private_no_store "$PRODUCER_RAW/$label.headers"
}
recover_page_id() {
  local count
  count="$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\"='$SLUG' AND \"path\"='$PATHNAME' AND \"caption\"='$TITLE' AND \"title\"='$TITLE' AND \"sortOrder\"=9342;")"
  [[ "$count" == 1 ]] || return 1
  psql_scalar "SELECT \"id\" FROM \"PageContent\" WHERE \"slug\"='$SLUG' AND \"path\"='$PATHNAME' AND \"caption\"='$TITLE' AND \"title\"='$TITLE' AND \"sortOrder\"=9342;"
}

cleanup() {
  local original_status=$? failed=false count audit_after
  trap - EXIT
  set +e
  # Decided against the database, not against the flag alone. If the supported
  # DELETE returned 2xx but a later MC-03D assertion failed, the row is already
  # gone while PAGE_DELETED_VIA_API is still false; the removal path below would
  # then PATCH an id that no longer exists, take the 404 as a cleanup failure,
  # and report a cleanup problem on top of the real one.
  if [[ "$PAGE_ARMED" == true && "$PAGE_DELETED_VIA_API" != true ]] \
    && [[ "$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\"='$SLUG' OR \"path\"='$PATHNAME';" 2>/dev/null)" == 0 ]]; then
    PAGE_DELETED_VIA_API=true
  fi
  if [[ "$PAGE_ARMED" == true && "$PAGE_DELETED_VIA_API" == true ]]; then
    # The supported endpoint already removed the row through the product's own
    # path, so there is nothing to unpublish and nothing to delete out from
    # under the app. The container is still recreated, because every other
    # producer that follows expects a cold, unmutated app.
    docker restart "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/cleanup-restart.txt" 2>&1 || failed=true
    healthy=false
    for _ in $(seq 1 60); do
      if curl -fsS "$CORRECTNESS_BASE_URL/api/health" > "$PRODUCER_RAW/cleanup-health.json"; then healthy=true; break; fi
      sleep 1
    done
    [[ "$healthy" == true ]] || failed=true
  elif [[ "$PAGE_ARMED" == true ]]; then
    if [[ -z "$PAGE_ID" && "$PAGE_RECOVERY_ALLOWED" == true ]]; then
      PAGE_ID="$(recover_page_id 2>/dev/null)" || failed=true
    fi
    if [[ -n "$PAGE_ID" && "$PAGE_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
      printf '{"id":"%s","published":false}' "$PAGE_ID" > "$PRODUCER_RAW/cleanup-unpublish.request.json"
      api PATCH /api/admin/page-content "$PRODUCER_RAW/cleanup-unpublish.json" "$PRODUCER_RAW/cleanup-unpublish.request.json" || failed=true
      docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
        -c "DELETE FROM \"PageContent\" WHERE \"id\"='$PAGE_ID' AND \"slug\"='$SLUG' AND \"path\"='$PATHNAME' AND \"caption\"='$TITLE' AND \"title\"='$TITLE' AND \"sortOrder\"=9342 AND \"published\"=false;" \
        > "$PRODUCER_RAW/cleanup-delete.txt" 2>&1 || failed=true
      docker restart "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/cleanup-restart.txt" 2>&1 || failed=true
      healthy=false
      for _ in $(seq 1 60); do
        if curl -fsS "$CORRECTNESS_BASE_URL/api/health" > "$PRODUCER_RAW/cleanup-health.json"; then healthy=true; break; fi
        sleep 1
      done
      [[ "$healthy" == true ]] || failed=true
    else
      failed=true
    fi
  fi
  count="$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\"='$SLUG' OR \"path\"='$PATHNAME';" 2>/dev/null)"
  audit_after="$(psql_scalar 'SELECT count(*) FROM "AuditLog";' 2>/dev/null)"
  printf '{"status":"%s","page_rows_after":%s,"audit_rows_before":%s,"audit_rows_after":%s,"audit_residue":"intentional"}\n' \
    "$([[ "$failed" == false && "$count" == 0 ]] && echo passed || echo failed)" \
    "${count:-null}" "${AUDIT_BEFORE:-null}" "${audit_after:-null}" > "$PRODUCER_RAW/mutation-cleanup.json"
  [[ "$count" == 0 ]] || failed=true
  local final_status=1
  [[ "$original_status" -eq 0 && "$failed" == false ]] && final_status=0
  if [[ "$CLEANUP_INVOKED" == true ]]; then
    return "$final_status"
  fi
  exit "$final_status"
}
trap cleanup EXIT

# The typed phase-2 route binding needs a genuine empty-store first request.
# Recreate only the isolated app from the same immutable image, then capture the
# exact four-route census before any lifecycle mutation can warm it.
BINDING_CONTAINER_BEFORE="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}')"
APP_IMAGE="$CORRECTNESS_IMAGE_REFERENCE" bash measurement/stack/measure-stack.sh compose up -d --wait --force-recreate app \
  > "$PRODUCER_RAW/binding-recreate-app.txt"
producer_refresh_app_container
BINDING_CONTAINER_AFTER="$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Id}}')"
[[ "$BINDING_CONTAINER_AFTER" != "$BINDING_CONTAINER_BEFORE" ]]
[[ "$(docker inspect "$CORRECTNESS_APP_CONTAINER" --format '{{.Image}}')" == "$CORRECTNESS_IMAGE_ID" ]]
binding_capture() {
  local label="$1" route="$2" status
  status="$(curl -sS -D "$PRODUCER_RAW/$label.headers" -o "$PRODUCER_RAW/$label.body.html" -w '%{http_code}' "$CORRECTNESS_BASE_URL$route")"
  [[ "$status" == 200 ]] || { echo "$route binding capture returned HTTP $status" >&2; return 1; }
}
binding_capture binding-about-1 /about
binding_capture binding-about-2 /about
binding_capture binding-root /
binding_capture binding-join /join
binding_capture binding-contact /contact
node measurement/current-main-refresh/bin/build-route-response-evidence.mjs \
  --run-root "$CORRECTNESS_RUN_ROOT" --raw "$PRODUCER_RAW" --side "$CORRECTNESS_SIDE" \
  --image-id "$CORRECTNESS_IMAGE_ID" --out "$PRODUCER_RAW/route-response-evidence.json"

[[ -f "$CORRECTNESS_AUTH_STATE" ]] || { echo "auth storage state is missing" >&2; exit 1; }
COOKIE="$(node - "$CORRECTNESS_AUTH_STATE" <<'NODE'
const state = require(process.argv[2]);
const cookie = state.cookies.find((candidate) => candidate.name === "authjs.session-token");
if (!cookie?.value) throw new Error("admin session cookie missing");
process.stdout.write(`${cookie.name}=${cookie.value}`);
NODE
)"
AUDIT_BEFORE="$(psql_scalar 'SELECT count(*) FROM "AuditLog";')"
[[ "$AUDIT_BEFORE" =~ ^[0-9]+$ ]] || { echo "invalid audit count" >&2; exit 1; }
[[ "$(psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"slug\"='$SLUG' OR \"path\"='$PATHNAME';")" == 0 ]] || {
  echo "unique page collision" >&2; exit 1;
}

node - "$SLUG" "$TITLE" "$PRODUCER_RAW/create.request.json" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[4], JSON.stringify({
  slug: process.argv[2], caption: process.argv[3], menuTitle: "", title: process.argv[3], headerText: "", sortOrder: 9342,
}));
NODE
PAGE_ARMED=true
PAGE_RECOVERY_ALLOWED=true
if api POST /api/admin/page-content "$PRODUCER_RAW/create.json" "$PRODUCER_RAW/create.request.json"; then
  PAGE_ID="$(node - "$PRODUCER_RAW/create.json" "$SLUG" "$PATHNAME" <<'NODE'
const body = require(process.argv[2]);
const page = body?.page;
if (typeof page?.id !== "string" || page.slug !== process.argv[3] || page.path !== process.argv[4] || page.published !== true) {
  throw new Error("create response did not bind the unique page");
}
process.stdout.write(page.id);
NODE
)"
  [[ "$PAGE_ID" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "invalid page id" >&2; exit 1; }
  PAGE_RECOVERY_ALLOWED=false
else
  status="$(tr -d '[:space:]' < "$PRODUCER_RAW/create.json.status")"
  [[ "$status" != 409 ]] || { PAGE_ARMED=false; PAGE_RECOVERY_ALLOWED=false; }
  echo "page create failed" >&2
  exit 1
fi

save_content() {
  local marker="$1" label="$2"
  node - "$PAGE_ID" "$SLUG" "$TITLE" "$marker" "$PRODUCER_RAW/$label.request.json" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[6], JSON.stringify({
  id: process.argv[2], slug: process.argv[3], caption: process.argv[4], menuTitle: "", title: process.argv[4],
  headerText: "", sortOrder: 9342, contentHtml: `<p>${process.argv[5]}</p>`,
}));
NODE
  api PUT /api/admin/page-content "$PRODUCER_RAW/$label.json" "$PRODUCER_RAW/$label.request.json"
}
set_published() {
  local value="$1" label="$2"
  printf '{"id":"%s","published":%s}' "$PAGE_ID" "$value" > "$PRODUCER_RAW/$label.request.json"
  api PATCH /api/admin/page-content "$PRODUCER_RAW/$label.json" "$PRODUCER_RAW/$label.request.json"
}

save_content "$V1" save-v1
capture v1-miss
capture v1-hit
[[ "$(<"$PRODUCER_RAW/v1-miss.status")" == 200 && "$(<"$PRODUCER_RAW/v1-hit.status")" == 200 ]]
grep -Fq "$V1" "$PRODUCER_RAW/v1-miss.body.html"
cmp -s "$PRODUCER_RAW/v1-miss.body.html" "$PRODUCER_RAW/v1-hit.body.html"
assert_private_no_store "$PRODUCER_RAW/v1-miss.headers"
assert_private_no_store "$PRODUCER_RAW/v1-hit.headers"

if [[ "$CORRECTNESS_SIDE" == current ]]; then
  [[ "$(header_value "$PRODUCER_RAW/v1-miss.headers" x-nextjs-cache)" == MISS ]]
  [[ "$(header_value "$PRODUCER_RAW/v1-hit.headers" x-nextjs-cache)" == HIT ]]
else
  [[ -z "$(header_value "$PRODUCER_RAW/v1-miss.headers" x-nextjs-cache)" ]]
  [[ -z "$(header_value "$PRODUCER_RAW/v1-hit.headers" x-nextjs-cache)" ]]
fi

if [[ "$CORRECTNESS_SIDE" == current ]]; then
  save_content "$V2" save-v2
  capture v2-authenticated "$COOKIE"
  capture v2-anonymous
  [[ "$(<"$PRODUCER_RAW/v2-authenticated.status")" == 200 && "$(<"$PRODUCER_RAW/v2-anonymous.status")" == 200 ]]
  grep -Fq "$V2" "$PRODUCER_RAW/v2-authenticated.body.html"
  ! grep -Fq "$V1" "$PRODUCER_RAW/v2-authenticated.body.html"
  cmp -s "$PRODUCER_RAW/v2-authenticated.body.html" "$PRODUCER_RAW/v2-anonymous.body.html"
  ! grep -Fqi 'session-token' "$PRODUCER_RAW/v2-anonymous.body.html"
  ! grep -Fq -- "${COOKIE#*=}" "$PRODUCER_RAW/v2-anonymous.body.html"
  [[ "$(header_value "$PRODUCER_RAW/v2-authenticated.headers" x-nextjs-cache)" == MISS ]]
  [[ "$(header_value "$PRODUCER_RAW/v2-anonymous.headers" x-nextjs-cache)" == HIT ]]

  set_published false unpublish
  capture after-unpublish
  [[ "$(<"$PRODUCER_RAW/after-unpublish.status")" == 404 ]]
  set_published true republish
  capture after-republish
  [[ "$(<"$PRODUCER_RAW/after-republish.status")" == 200 ]]
  grep -Fq "$V2" "$PRODUCER_RAW/after-republish.body.html"

  # ---- MC-03D: deletion through the supported admin API (#2637, #2663) -------
  # MC-03D used to report OWNER_DISPOSITION_NEEDED because the product had no
  # supported way to delete a CMS page, so deletion invalidation could not be
  # observed at all. `DELETE /api/admin/page-content` is now that supported way,
  # so the check is measured here the same way MC-03A-C are, against the
  # product's own endpoint rather than a mechanism invented by the harness.
  #
  # Two things have to be true, and they are deliberately separated because only
  # one of them is about caching. First the address must stop answering with the
  # body that is sitting in the store — a 404 alone would also be produced by a
  # store that was never cleared but happened to be re-rendered. Second, the
  # canonical site-wide invalidation must actually have fired, which is what a
  # warm SIBLING route dropping to MISS proves and what the deleted page's own
  # 404 cannot.
  capture pre-delete-hit
  [[ "$(<"$PRODUCER_RAW/pre-delete-hit.status")" == 200 ]]
  [[ "$(header_value "$PRODUCER_RAW/pre-delete-hit.headers" x-nextjs-cache)" == HIT ]]
  grep -Fq "$V2" "$PRODUCER_RAW/pre-delete-hit.body.html"
  capture_about pre-delete-about-miss
  capture_about pre-delete-about-hit
  [[ "$(header_value "$PRODUCER_RAW/pre-delete-about-hit.headers" x-nextjs-cache)" == HIT ]]

  printf '{"id":"%s"}' "$PAGE_ID" > "$PRODUCER_RAW/delete.request.json"
  api DELETE /api/admin/page-content "$PRODUCER_RAW/delete.json" "$PRODUCER_RAW/delete.request.json"
  node - "$PRODUCER_RAW/delete.json" "$PAGE_ID" "$SLUG" "$PATHNAME" <<'NODE'
const body = require(process.argv[2]);
if (body?.ok !== true) throw new Error("the supported delete did not report success");
if (body?.page?.id !== process.argv[3] || body.page.slug !== process.argv[4] || body.page.path !== process.argv[5]) {
  throw new Error("the delete response did not bind the unique disposable page");
}
// The route answers 200 with this false when the row went but the cache flush
// threw, which is honest of it and is exactly the case MC-03D must not accept.
if (body?.publicCacheCleared !== true) throw new Error("the route reported that it could not clear the public site cache");
NODE

  # The row is gone through the product's own path, so cleanup must not try to
  # remove it again.
  psql_scalar "SELECT count(*) FROM \"PageContent\" WHERE \"id\"='$PAGE_ID' OR \"slug\"='$SLUG' OR \"path\"='$PATHNAME';" > "$PRODUCER_RAW/delete-row-count.txt"
  [[ "$(<"$PRODUCER_RAW/delete-row-count.txt")" == 0 ]]
  PAGE_DELETED_VIA_API=true
  psql_scalar "SELECT count(*) FROM \"AuditLog\" WHERE \"action\"='PAGE_CONTENT_DELETED' AND \"entityType\"='PageContent' AND \"entityId\"='$PAGE_ID';" > "$PRODUCER_RAW/delete-audit-count.txt"
  [[ "$(<"$PRODUCER_RAW/delete-audit-count.txt")" == 1 ]]

  # Not served stale: the address that was a HIT one request ago now 404s, and
  # the body that was in the store does not come back with it.
  capture after-delete
  [[ "$(<"$PRODUCER_RAW/after-delete.status")" == 404 ]]
  ! grep -Fq "$V2" "$PRODUCER_RAW/after-delete.body.html"

  # The invalidation was the canonical site-wide one, not the row merely
  # vanishing: the sibling route that was warm a moment ago was dropped from the
  # store by the same call, rebuilds on the next request, and carries no link to
  # the address that has just been deleted.
  capture_about after-delete-about-miss
  [[ "$(header_value "$PRODUCER_RAW/after-delete-about-miss.headers" x-nextjs-cache)" == MISS ]]
  capture_about after-delete-about-hit
  [[ "$(header_value "$PRODUCER_RAW/after-delete-about-hit.headers" x-nextjs-cache)" == HIT ]]
  ! grep -Fq "\"$PATHNAME\"" "$PRODUCER_RAW/after-delete-about-hit.body.html"
else
  set_published false final-unpublish
  capture final-404
  [[ "$(<"$PRODUCER_RAW/final-404.status")" == 404 ]]
fi

# Cleanup is deliberately invoked before the result is written. A failed cleanup
# therefore cannot leave a producer result that the finalizer could accept.
docker logs --since "$PRODUCER_STARTED_AT" "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/app-scenario.log" 2>&1
producer_complete_cleanup cleanup "$PRODUCER_RAW/mutation-cleanup.json"
if [[ "$PAGE_DELETED_VIA_API" == true ]]; then
  producer_write_cleanup_passed "unique CMS page removed exactly once through the supported DELETE endpoint under test; app restarted; immutable audit entries retained" \
    "mutation-cleanup.json" "delete-row-count.txt" "cleanup-health.json"
else
  producer_write_cleanup_passed "unique CMS page deleted exactly; app restarted; immutable audit entries retained" \
    "mutation-cleanup.json" "cleanup-delete.txt" "cleanup-health.json"
fi

V1_HEADERS="$(producer_relative "$PRODUCER_RAW/v1-miss.headers")"
V1_BODY="$(producer_relative "$PRODUCER_RAW/v1-miss.body.html")"
CLEANUP="$(producer_relative "$PRODUCER_RAW/mutation-cleanup.json")"
ROUTE_BINDING="$(producer_relative "$PRODUCER_RAW/route-response-evidence.json")"
if [[ "$CORRECTNESS_SIDE" == baseline ]]; then
  cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"BND-02","outcome":"PASS","assertions":["the baseline returned correct stable bytes on two requests and emitted no ISR cache-class header; exact four-route timing bindings were typed from raw responses"],"evidence_paths":["$V1_HEADERS","$V1_BODY","$ROUTE_BINDING","$CLEANUP"]}
]
JSON
else
  V2_AUTH="$(producer_relative "$PRODUCER_RAW/v2-authenticated.body.html")"
  V2_ANON="$(producer_relative "$PRODUCER_RAW/v2-anonymous.body.html")"
  UNPUBLISHED="$(producer_relative "$PRODUCER_RAW/after-unpublish.status")"
  REPUBLISHED="$(producer_relative "$PRODUCER_RAW/after-republish.body.html")"
  PRE_DELETE_HIT="$(producer_relative "$PRODUCER_RAW/pre-delete-hit.headers")"
  DELETE_RESPONSE="$(producer_relative "$PRODUCER_RAW/delete.json")"
  AFTER_DELETE_STATUS="$(producer_relative "$PRODUCER_RAW/after-delete.status")"
  AFTER_DELETE_BODY="$(producer_relative "$PRODUCER_RAW/after-delete.body.html")"
  ABOUT_WARM="$(producer_relative "$PRODUCER_RAW/pre-delete-about-hit.headers")"
  ABOUT_INVALIDATED="$(producer_relative "$PRODUCER_RAW/after-delete-about-miss.headers")"
  DELETE_ROWS="$(producer_relative "$PRODUCER_RAW/delete-row-count.txt")"
  DELETE_AUDIT="$(producer_relative "$PRODUCER_RAW/delete-audit-count.txt")"
  cat > "$PRODUCER_RAW/observations.json" <<JSON
[
  {"check_id":"MC-02","outcome":"PASS","assertions":["an authenticated first render and the following anonymous HIT were byte-identical and contained no session token"],"evidence_paths":["$V2_AUTH","$V2_ANON"]},
  {"check_id":"MC-03A","outcome":"PASS","assertions":["republishing restored the exact unique route on the next request"],"evidence_paths":["$REPUBLISHED"]},
  {"check_id":"MC-03B","outcome":"PASS","assertions":["saving v2 invalidated warm v1; the authenticated next request was MISS and anonymous follow-up was byte-identical HIT"],"evidence_paths":["$V2_AUTH","$V2_ANON"]},
  {"check_id":"MC-03C","outcome":"PASS","assertions":["unpublishing changed the exact unique route to 404 on the next request"],"evidence_paths":["$UNPUBLISHED"]},
  {"check_id":"MC-03D","outcome":"PASS","assertions":["the disposable page was served from the ISR store as a HIT immediately before deletion, and a sibling public route was warm as a HIT at the same moment","the supported DELETE /api/admin/page-content endpoint removed the page by body id, reported ok with publicCacheCleared true, and left exactly zero PageContent rows for the slug or path","the deleted address answered 404 on the next request and did not return the stored body, so it was never served stale","the canonical site-wide public-content invalidation actually fired: the warm sibling route dropped to MISS on the same call and rebuilt to a HIT carrying no link to the deleted address","exactly one PAGE_CONTENT_DELETED audit entry was written for the page, and the product's own supported path performed the cleanup the harness would otherwise have done itself"],"evidence_paths":["$PRE_DELETE_HIT","$ABOUT_WARM","$DELETE_RESPONSE","$AFTER_DELETE_STATUS","$AFTER_DELETE_BODY","$ABOUT_INVALIDATED","$DELETE_ROWS","$DELETE_AUDIT"]},
  {"check_id":"BND-02","outcome":"PASS","assertions":["the first exact-body request was MISS and the byte-identical second request was HIT, both private,no-store; exact four-route timing bindings were typed from raw responses"],"evidence_paths":["$V1_HEADERS","$V1_BODY","$ROUTE_BINDING","$CLEANUP"]}
]
JSON
fi
producer_finish "$PRODUCER_RAW/observations.json"
