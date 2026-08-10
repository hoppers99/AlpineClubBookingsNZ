#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source measurement/current-main-refresh/lib/producer.sh

: "${CORRECTNESS_BASE_URL:?CORRECTNESS_BASE_URL is required}"
: "${CORRECTNESS_AUTH_STATE:?CORRECTNESS_AUTH_STATE is required}"
: "${CORRECTNESS_APP_CONTAINER:?CORRECTNESS_APP_CONTAINER is required}"
: "${CORRECTNESS_POSTGRES_CONTAINER:?CORRECTNESS_POSTGRES_CONTAINER is required}"
: "${CORRECTNESS_MAILPIT_URL:?CORRECTNESS_MAILPIT_URL is required}"
: "${CORRECTNESS_APP_SOURCE_ARCHIVE:?CORRECTNESS_APP_SOURCE_ARCHIVE is required}"
: "${CORRECTNESS_APP_SOURCE_COMMIT:?CORRECTNESS_APP_SOURCE_COMMIT is required}"
: "${CORRECTNESS_RUNTIME_PROVENANCE:?CORRECTNESS_RUNTIME_PROVENANCE is required}"
node measurement/current-main-refresh/bin/runtime-provenance.mjs --root "$PWD" --verify "$CORRECTNESS_RUNTIME_PROVENANCE"
producer_begin browser-suite

APPLICANT_EMAIL="issue2352.$CORRECTNESS_RUN_ID@applicant.invalid"
CLEANUP_INVOKED=false
psql_scalar() { docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 -tAc "$1" | tr -d '[:space:]'; }
mail_count() {
  curl -fsS "$CORRECTNESS_MAILPIT_URL/api/v1/messages" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const b=JSON.parse(s);if(!Array.isArray(b.messages))throw new Error("invalid Mailpit list");process.stdout.write(String(b.messages.length));});'
}
cleanup() {
  local original_status=$? failed=false app_count token_count app_count_after mail_count_after
  trap - EXIT; set +e
  app_count="$(psql_scalar "SELECT count(*) FROM \"MemberApplication\" WHERE \"applicantEmail\"='$APPLICANT_EMAIL';" 2>/dev/null)"
  token_count="$(psql_scalar "SELECT count(*) FROM \"NominationToken\" WHERE \"applicationId\" IN (SELECT \"id\" FROM \"MemberApplication\" WHERE \"applicantEmail\"='$APPLICANT_EMAIL');" 2>/dev/null)"
  if [[ "$app_count" =~ ^[0-9]+$ && "$app_count" -gt 0 ]]; then
    [[ "$app_count" == 1 && "$token_count" == 2 ]] || failed=true
    docker exec "$CORRECTNESS_POSTGRES_CONTAINER" psql -X -U tac -d tacbookings -v ON_ERROR_STOP=1 \
      -c "DELETE FROM \"MemberApplication\" WHERE \"applicantEmail\"='$APPLICANT_EMAIL';" \
      > "$PRODUCER_RAW/cleanup-application-delete.txt" 2>&1 || failed=true
  elif [[ "$app_count" != 0 || "$CLEANUP_INVOKED" == true ]]; then failed=true; fi
  curl -fsS -X DELETE "$CORRECTNESS_MAILPIT_URL/api/v1/messages" > "$PRODUCER_RAW/cleanup-mailpit-delete.txt" || failed=true
  mail_count_after="$(mail_count 2>/dev/null)"
  app_count_after="$(psql_scalar "SELECT count(*) FROM \"MemberApplication\" WHERE \"applicantEmail\"='$APPLICANT_EMAIL';" 2>/dev/null)"
  [[ "$mail_count_after" == 0 && "$app_count_after" == 0 ]] || failed=true
  printf '{"status":"%s","application_rows_before":%s,"nomination_tokens_before":%s,"application_rows_after":%s,"mailpit_messages_after":%s,"audit_residue":"intentional"}\n' \
    "$([[ "$failed" == false ]] && echo passed || echo failed)" "${app_count:-null}" "${token_count:-null}" "${app_count_after:-null}" "${mail_count_after:-null}" > "$PRODUCER_RAW/browser-cleanup.json"
  local final=1; [[ "$original_status" -eq 0 && "$failed" == false ]] && final=0
  if [[ "$CLEANUP_INVOKED" == true ]]; then return "$final"; fi
  exit "$final"
}
trap cleanup EXIT

[[ "$(mail_count)" == 0 ]] || { echo "Mailpit must be empty before the browser suite" >&2; exit 1; }
[[ "$(psql_scalar "SELECT count(*) FROM \"MemberApplication\" WHERE \"applicantEmail\"='$APPLICANT_EMAIL';")" == 0 ]]
PUBLIC_ORIGIN="$(docker exec "$CORRECTNESS_APP_CONTAINER" printenv NEXTAUTH_URL | tr -d '\r\n')"
[[ "$PUBLIC_ORIGIN" =~ ^https?://[^/]+$ ]] || { echo "invalid measured NEXTAUTH_URL" >&2; exit 1; }
node measurement/current-main-refresh/bin/build-canonical-contract.mjs \
  --app-source-archive "$CORRECTNESS_APP_SOURCE_ARCHIVE" --app-source-commit "$CORRECTNESS_APP_SOURCE_COMMIT" \
  --out "$PRODUCER_RAW/canonical-contract.json"
node measurement/current-main-refresh/bin/run-browser-suite.mjs \
  --base-url "$CORRECTNESS_BASE_URL" --public-origin "$PUBLIC_ORIGIN" --auth-state "$CORRECTNESS_AUTH_STATE" \
  --run-id "$CORRECTNESS_RUN_ID" --canonical-contract "$PRODUCER_RAW/canonical-contract.json" \
  --out-dir "$PRODUCER_RAW" --out "$PRODUCER_RAW/browser-result.json"
node measurement/current-main-refresh/bin/runtime-provenance.mjs --root "$PWD" --verify "$CORRECTNESS_RUNTIME_PROVENANCE"
docker logs --since "$PRODUCER_STARTED_AT" "$CORRECTNESS_APP_CONTAINER" > "$PRODUCER_RAW/app-scenario.log" 2>&1

producer_complete_cleanup cleanup "$PRODUCER_RAW/browser-cleanup.json"
producer_write_cleanup_passed "unique application cascade-deleted and initially empty Mailpit returned to empty" \
  "browser-cleanup.json" "cleanup-application-delete.txt" "cleanup-mailpit-delete.txt"
node - "$PRODUCER_RAW/browser-result.json" "$PRODUCER_RAW/observations.json" "$CORRECTNESS_RUN_ROOT" <<'NODE'
const fs=require("node:fs");const path=require("node:path");const result=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const rel=(name)=>path.relative(process.argv[4],path.resolve(path.dirname(process.argv[2]),name)).replaceAll("\\","/");
const evidence=[rel("browser-result.json"),rel("anonymous-trace.zip"),rel("authenticated-trace.zip")];
if(result?.canonical_contract?.satisfied!==true)throw new Error("canonical contract was not satisfied");
const observation=(check_id,outcome,assertions,paths=evidence)=>({check_id,outcome,assertions,evidence_paths:paths});
const rows=[
  observation("MC-01A","PASS",["the complete fixed/narrowed/sensitive route census produced zero watched CSP console or page errors"]),
  observation("MC-01B","PASS",["the complete browser route census produced zero hydration console or page errors"]),
  observation("MC-06","PASS",["anonymous, authenticated, and marker-only presentation differed as intended while marker-only dashboard/API access was denied"]),
  observation("MC-11A","PASS",["home, CMS, join, contact, apply, narrowed, encoded, and error routes kept their expected status, landmark, navigation, and route-precedence behavior"]),
  observation("MC-11B","PASS",["contact and membership-application forms enforced validation and completed real isolated submissions"]),
  observation("MC-11C","PASS",["axe found zero serious or critical WCAG 2 A/AA violations on all five affected public routes"]),
  observation("MC-11D","PASS",["all five affected public routes rendered nonempty title, description, Open Graph title/description, English language, and document landmarks"]),
  observation("MC-11E","PASS",["all five affected routes matched the source-derived metadata contract: canonical links are deliberately absent because neither root nor route metadata declares alternates.canonical"],[rel("browser-result.json"),rel("canonical-contract.json")]),
];
fs.writeFileSync(process.argv[3],JSON.stringify(rows,null,2)+"\n",{flag:"wx"});
NODE
producer_finish "$PRODUCER_RAW/observations.json"
