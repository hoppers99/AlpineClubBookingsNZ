#!/usr/bin/env bash
# Orchestrates the ISOLATED tacbookings-measure stack for the #2352 slice-1
# staging evaluation. Run from the wt-measure worktree root.
#
#   measurement/stack/measure-stack.sh prepare          # postgres + schema + seeds + app + caddy
#   measurement/stack/measure-stack.sh create-canonical-dump <absolute-path>
#   measurement/stack/measure-stack.sh restore-canonical-dump <absolute-path> <sha256>
#   measurement/stack/measure-stack.sh database-fingerprint
#   measurement/stack/measure-stack.sh app-image <tag>  # swap the app image (e.g. tacbookings-measure-app:baseline)
#   measurement/stack/measure-stack.sh restart-app      # restart the app container (clears the in-memory ISR store)
#   measurement/stack/measure-stack.sh up               # start postgres+mailpit+app+caddy (existing data)
#   measurement/stack/measure-stack.sh stop             # stop containers, keep them + volumes
#   measurement/stack/measure-stack.sh down             # remove containers + network, KEEP volumes (seeded DB survives)
#   measurement/stack/measure-stack.sh destroy          # remove containers + volumes (full reset)
#
# Safety: only ever touches the tacbookings-measure compose project
# (ports 3003/5435/8027/8127, all loopback-bound). Never the staging
# (tacbookings-staging, 3001/5433/8025) or any production stack.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

ENV_FILE="$ROOT/measurement/stack/.env.measure"
PROJECT=tacbookings-measure

# Host-side view of the measure database, for migrate + seeds.
DB_PASSWORD="$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2)"
export HOST_DATABASE_URL="postgresql://tac:${DB_PASSWORD}@localhost:5435/tacbookings"

compose() {
  docker compose --env-file "$ENV_FILE" -p "$PROJECT" --project-directory "$ROOT" \
    -f docker-compose.yml -f measurement/stack/docker-compose.measure.yml "$@"
}

prepare() {
  echo "==> Starting measure postgres (host port 5435)"
  compose up -d --wait postgres

  echo "==> Resetting database schema"
  compose exec -T postgres psql -U tac -d tacbookings -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

  echo "==> Generating Prisma client"
  DATABASE_URL="$HOST_DATABASE_URL" npx prisma generate

  echo "==> Applying the full migration history"
  DATABASE_URL="$HOST_DATABASE_URL" npx prisma migrate deploy

  echo "==> Seeding demo data (the sanctioned representative dataset)"
  ALLOW_DEMO_SEED=1 DATABASE_URL="$HOST_DATABASE_URL" npx tsx prisma/demo-seed.ts

  echo "==> Seeding base data (SEED_THEME_COMPLETE=1 so the public site is open)"
  SEED_THEME_COMPLETE=1 \
  SEED_ADMIN_EMAIL="$(grep '^SEED_ADMIN_EMAIL=' "$ENV_FILE" | cut -d= -f2)" \
  SEED_ADMIN_PASSWORD="$(grep '^SEED_ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2)" \
  SEED_LODGE_PASSWORD="$(grep '^SEED_LODGE_PASSWORD=' "$ENV_FILE" | cut -d= -f2)" \
  DATABASE_URL="$HOST_DATABASE_URL" npx tsx prisma/seed.ts

  echo "==> Starting app + caddy (http://localhost:8027 via Caddy; app direct on :3003)"
  compose up -d --wait app caddy
  echo "==> Measure stack ready"
}

require_absolute_file_path() {
  case "${1:-}" in
    /*|[A-Za-z]:/*) ;;
    *) echo "expected an absolute archive path, got: ${1:-<missing>}" >&2; exit 1 ;;
  esac
}

database_fingerprint() {
  # A canonical, complete logical fingerprint. The archive is restored before
  # each side; this detects any timing-side database mutation afterwards.
  compose exec -T postgres pg_dump -U tac -d tacbookings \
    --schema=public --no-owner --no-privileges --inserts --column-inserts \
    | sed -E '/^-- Dumped (from|by) database version /d; /^-- Started on /d; /^-- Completed on /d' \
    | sha256sum | awk '{print $1}'
}

create_canonical_dump() (
  local archive="$1"
  local temp_archive
  require_absolute_file_path "$archive"
  [ ! -e "$archive" ] || { echo "refusing to overwrite canonical archive: $archive" >&2; exit 1; }
  mkdir -p "$(dirname "$archive")"
  temp_archive="$(mktemp "${archive}.tmp.XXXXXXXX")"
  cleanup_canonical_temp() { rm -f -- "$temp_archive"; }
  trap cleanup_canonical_temp EXIT
  compose exec -T postgres pg_dump -U tac -d tacbookings \
    --format=custom --no-owner --no-privileges --schema=public > "$temp_archive"
  [ -s "$temp_archive" ] || { echo "canonical archive is empty: $temp_archive" >&2; exit 1; }
  compose exec -T postgres pg_restore --list < "$temp_archive" > /dev/null
  # Same-directory hard-link publication is atomic and refuses a destination
  # created by a racing writer; unlinking the temporary name leaves one inode.
  node -e 'const fs=require("node:fs");fs.linkSync(process.argv[1],process.argv[2]);fs.unlinkSync(process.argv[1])' "$temp_archive" "$archive"
  sha256sum "$archive"
)

restore_canonical_dump() {
  local archive="$1"
  local expected_sha="$2"
  require_absolute_file_path "$archive"
  [ -f "$archive" ] || { echo "canonical archive is missing: $archive" >&2; exit 1; }
  [ "$(sha256sum "$archive" | awk '{print $1}')" = "$expected_sha" ] || {
    echo "canonical archive checksum mismatch" >&2; exit 1;
  }
  compose stop app >/dev/null 2>&1 || true
  compose up -d --wait postgres >/dev/null
  compose exec -T postgres psql -U tac -d tacbookings -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" >/dev/null
  compose exec -T postgres pg_restore -U tac -d tacbookings \
    --exit-on-error --no-owner --no-privileges < "$archive"
  database_fingerprint
}

case "${1:-}" in
  prepare) prepare ;;
  create-canonical-dump)
    shift
    [ -n "${1:-}" ] || { echo "usage: $0 create-canonical-dump <absolute-path>" >&2; exit 1; }
    create_canonical_dump "$1"
    ;;
  restore-canonical-dump)
    shift
    [ -n "${1:-}" ] && [ -n "${2:-}" ] || {
      echo "usage: $0 restore-canonical-dump <absolute-path> <sha256>" >&2; exit 1;
    }
    restore_canonical_dump "$1" "$2"
    ;;
  database-fingerprint) database_fingerprint ;;
  app-image)
    shift
    [ -n "${1:-}" ] || { echo "usage: $0 app-image <image:tag>" >&2; exit 1; }
    APP_IMAGE="$1" compose up -d --wait app
    ;;
  restart-app)
    compose restart app
    compose up -d --wait app
    ;;
  up) compose up -d --wait postgres mailpit app caddy ;;
  stop) compose stop ;;
  down) compose down ;;
  destroy) compose down -v ;;
  compose)
    shift
    compose "$@"
    ;;
  *)
    echo "Usage: $0 {prepare|create-canonical-dump <path>|restore-canonical-dump <path> <sha256>|database-fingerprint|app-image <tag>|restart-app|up|stop|down|destroy|compose ...}" >&2
    exit 1
    ;;
esac
