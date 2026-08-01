#!/usr/bin/env bash
#
# PR-time coverage gate for data-migration verification (issue #2418).
#
# WHY THIS EXISTS
#
# A migration that only changes the SHAPE of the database is proven by CI's
# `Migration drift check`: it applies every migration to a real PostgreSQL and
# diffs the result against schema.prisma. That job runs against EMPTY tables, so
# a migration that also REWRITES DATA — a backfill, a repair, a value transform —
# has its UPDATE trivially match nothing. The statement is proven to parse and
# proven to do nothing.
#
# Every defect the three review rounds found in #2269's data migration was a
# semantic one that empty tables cannot surface (a bracket family that also
# matched club-authored prose, an unterminated character class swallowing whole
# lines, an audit row written for a row that was never changed). Tests that
# string-match the SQL, or re-run its regexes in JavaScript, prove the patterns
# are what the author intended; they cannot prove PostgreSQL executes them the
# same way.
#
# So a data-rewriting migration must ship a VERIFICATION FIXTURE: a documented
# pre-state, the real migration.sql executed against it on a real PostgreSQL, and
# assertions on the resulting rows. This script is the gate that makes shipping
# one non-optional — it fails, naming the migration, when a data-rewriting
# migration lands without a fixture.
#
# It is intentionally read-only and needs no database: it runs as a fail-fast
# step in both the `migration-drift` job (which is a required check, so the rule
# bites immediately) and the `data-migration-verification` job that executes the
# fixtures.
#
# WHAT COUNTS AS DATA-REWRITING
#
# Statements are reconstructed with the same dollar-quote-aware splitter the
# blue/green deploy gate uses (scripts/lib/split-sql-statements.awk), so the two
# gates grade the same program. A migration is data-rewriting when any top-level
# statement:
#
#   * begins with UPDATE, DELETE, TRUNCATE or MERGE — these can only reach rows
#     that already exist;
#   * begins with INSERT and derives values from existing rows (a `SELECT`
#     anywhere in the statement) or resolves a conflict with `DO UPDATE`;
#   * begins with WITH and contains an UPDATE/DELETE/INSERT/MERGE — a
#     data-modifying CTE;
#   * is an `ALTER TABLE ... ALTER COLUMN ... TYPE ...` — the cast recasts every
#     stored value in place, with or without a USING clause (an implicit
#     assignment cast still rounds a numeric or truncates a timestamp; #2418, R5);
#   * is a `DO` block whose body contains any of the above keywords. A PL/pgSQL
#     body is opaque to a line-oriented gate, so it is classified conservatively;
#   * is a bare `CALL`, or a top-level `SELECT`/`PERFORM` that invokes a routine
#     THIS migration defines with a write in its body — the "helper function plus
#     one invocation" backfill shape, which runs the write at migration time
#     (#2418, R6).
#
# A plain `INSERT ... VALUES` is deliberately NOT data-rewriting: it adds rows
# and cannot alter anything a club has typed. Neither is a `CREATE FUNCTION`
# body containing an UPDATE that is only ATTACHED with CREATE TRIGGER and never
# invoked here — that defines future runtime behaviour, not a migration-time
# rewrite, and it is covered by the trigger suites instead. Both exclusions are
# documented in docs/BLUE_GREEN_MIGRATION_POLICY.md.
#
# Overridable via environment (used by the contract tests):
#   MIGRATIONS_DIR                    directory of migration folders
#   DATA_MIGRATION_VERIFICATION_DIR   directory of fixture modules
#   DATA_MIGRATION_GRANDFATHER_FILE   newline-separated allowlist override
set -Eeuo pipefail

# Deterministic, locale-independent string comparison for timestamp ordering.
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-${REPO_ROOT}/prisma/migrations}"
DATA_MIGRATION_VERIFICATION_DIR="${DATA_MIGRATION_VERIFICATION_DIR:-${REPO_ROOT}/prisma/migration-verification}"
SQL_STATEMENT_SPLITTER="${SQL_STATEMENT_SPLITTER:-${REPO_ROOT}/scripts/lib/split-sql-statements.awk}"

# ---------------------------------------------------------------------------
# Grandfathered historical data-rewriting migrations.
#
# Recorded 2 Aug 2026, when this gate was introduced (#2418). Every entry is a
# migration that ALREADY SHIPPED without an executable verification fixture.
# Retro-fitting a fixture to each one would be archaeology on databases that
# have long since applied them; the point of the gate is that the NEXT one
# cannot ship unverified.
#
# This list only ever shrinks. Adding a name to it is a deliberate, reviewed
# act — it means "this data-rewriting migration ships unverified" and needs the
# same justification a security waiver would. GRANDFATHERED_COUNT below pins the
# size, so an addition cannot ride in unnoticed on a large diff.
#
# Removing a name is how a historical migration gets retro-fitted: write the
# fixture, delete the row, drop the pinned count by one. The gate FAILS if a
# grandfathered migration also has a fixture, so the two can never both be true.
# ---------------------------------------------------------------------------
GRANDFATHERED_UNVERIFIED_DATA_MIGRATIONS=()
GRANDFATHERED_COUNT=0

grandfather_file="${DATA_MIGRATION_GRANDFATHER_FILE:-${REPO_ROOT}/scripts/data-migration-verification-grandfathered.txt}"
if [ ! -f "$grandfather_file" ]; then
  echo "check-data-migration-verification: grandfather list not found at ${grandfather_file}" >&2
  exit 1
fi
while IFS= read -r grandfather_line; do
  # Strip a trailing CR so a checkout with CRLF endings cannot silently produce
  # names that match nothing (which would fail OPEN for every entry).
  grandfather_line="${grandfather_line%$'\r'}"
  case "$grandfather_line" in
    '' | '#'*) continue ;;
  esac
  GRANDFATHERED_UNVERIFIED_DATA_MIGRATIONS+=("$grandfather_line")
done <"$grandfather_file"
GRANDFATHERED_COUNT="${#GRANDFATHERED_UNVERIFIED_DATA_MIGRATIONS[@]}"

# The pinned size of the list above. Bump it in the SAME commit that edits the
# list, never afterwards: a mismatch is the gate telling you an entry moved
# without review.
EXPECTED_GRANDFATHERED_COUNT="${EXPECTED_GRANDFATHERED_COUNT:-87}"

# The day this gate was introduced (#2418). No migration authored on or after it
# may be grandfathered: the whole point is that the NEXT data-rewriting migration
# ships a fixture, so a name whose 14-digit timestamp prefix is >= this is refused
# below rather than being allowed to buy its way out (#2418, R7). Every historical
# entry predates it. Overridable so the contract tests can pin the boundary.
GATE_INTRODUCED_PREFIX="${GATE_INTRODUCED_PREFIX:-20260802150000}"

failures=0

# Every argument is one line of the message, so a failure reads as a paragraph
# in the CI log rather than one unwrapped line.
fail() {
  printf '%s\n' "$@" >&2
  failures=1
}

is_grandfathered() {
  local name="$1" allowed
  for allowed in "${GRANDFATHERED_UNVERIFIED_DATA_MIGRATIONS[@]}"; do
    [ "$name" = "$allowed" ] && return 0
  done
  return 1
}

# Emit every top-level statement in a migration that rewrites existing data.
# Exit 2 (hard failure for the caller) when the file cannot be tokenised.
data_rewriting_statements() {
  local file="$1" statements

  statements="$(awk -v sq="'" -v dq='"' \
    -v tool="check-data-migration-verification" \
    -f "$SQL_STATEMENT_SPLITTER" "$file")" || return 2

  printf '%s\n' "$statements" | awk '
    # Pass 1: record the routines THIS migration defines whose body performs a
    # write. Recording a name is not classification: a trigger function is defined
    # here but only ATTACHED with CREATE TRIGGER, never invoked at migration time,
    # so it stays shape-only. Only a same-migration SELECT/CALL that INVOKES one
    # (pass 2) is a migration-time rewrite (#2418, R6).
    {
      lines[NR] = $0
      u = toupper($0)
      sub(/^[[:space:]]+/, "", u)
      if (u ~ /^CREATE([[:space:]]+OR[[:space:]]+REPLACE)?[[:space:]]+(FUNCTION|PROCEDURE)[[:space:]]/ &&
          u ~ /[^A-Z_](UPDATE|DELETE|TRUNCATE|MERGE|INSERT)[^A-Z_]/) {
        name = u
        sub(/^CREATE([[:space:]]+OR[[:space:]]+REPLACE)?[[:space:]]+(FUNCTION|PROCEDURE)[[:space:]]+/, "", name)
        sub(/[[:space:](].*$/, "", name)   # the name ends at the first space or "("
        if (name != "") {
          writers[name] = 1
          bare = name; sub(/^.*\./, "", bare); writers[bare] = 1  # also unqualified
        }
      }
    }
    END {
      for (k = 1; k <= NR; k++) {
        stmt = lines[k]
        # Leading keyword, uppercased for matching. Quoted identifiers keep their
        # own case because only this local copy is folded.
        upper = toupper(stmt)
        sub(/^[[:space:]]+/, "", upper)

        if (upper ~ /^(UPDATE|DELETE[[:space:]]+FROM|TRUNCATE|MERGE)([[:space:]]|$)/) { print stmt; continue }
        if (upper ~ /^INSERT([[:space:]]|$)/) {
          if (upper ~ /[^A-Z_]SELECT[^A-Z_]/ || upper ~ /DO[[:space:]]+UPDATE/) print stmt
          continue
        }
        if (upper ~ /^WITH([[:space:]]|$)/) {
          if (upper ~ /[^A-Z_](UPDATE|DELETE|INSERT|MERGE)[^A-Z_]/) print stmt
          continue
        }
        # Any ALTER COLUMN ... TYPE rewrites every stored value through the cast,
        # with or without a USING clause: an implicit assignment cast still rounds
        # a numeric, truncates a timestamp, etc. USING is no longer required
        # (#2418, R5) — the false-positive cost is one fixture on a type change,
        # which is the class most worth verifying against real rows.
        if (upper ~ /^ALTER[[:space:]]+TABLE/ && upper ~ /ALTER[[:space:]]+COLUMN/ &&
            upper ~ /[^A-Z_]TYPE[^A-Z_]/) { print stmt; continue }
        if (upper ~ /^DO([[:space:]]|$)/) {
          if (upper ~ /[^A-Z_](UPDATE|DELETE|TRUNCATE|MERGE|INSERT)[^A-Z_]/) print stmt
          continue
        }
        # A stored procedure invoked at migration time runs whatever it holds;
        # treat any bare CALL as a rewrite (#2418, R6).
        if (upper ~ /^CALL([[:space:]]|$)/) { print stmt; continue }
        # A top-level SELECT/PERFORM that invokes a routine this migration defined
        # with a write body performs that write now — the "helper function plus one
        # invocation" backfill shape (#2418, R6).
        if (upper ~ /^(SELECT|PERFORM)([[:space:]]|$)/) {
          for (name in writers) {
            esc = name; gsub(/\./, "\\.", esc)
            if (upper ~ ("(^|[^A-Z0-9_.])" esc "[[:space:]]*\\(")) { print stmt; break }
          }
          continue
        }
      }
    }
  '
}

fixture_path_for() {
  printf '%s/%s.ts' "$DATA_MIGRATION_VERIFICATION_DIR" "$1"
}

# ---------------------------------------------------------------------------
# 1. Every data-rewriting migration carries a fixture (or a grandfather row).
# ---------------------------------------------------------------------------
# A shell glob, not `find` + `sort`: on a Windows developer machine those two
# names resolve to C:\Windows\System32\find.exe and sort.exe, which would list
# nothing and report a clean pass over an empty tree — a false green in the one
# place a false green is unacceptable. Pathname expansion is sorted, and LC_ALL=C
# above makes that a byte comparison, which is the order PostgreSQL applies
# migrations in.
classified=()
for migration_dir in "$MIGRATIONS_DIR"/*/; do
  [ -d "$migration_dir" ] || continue
  migration_name="$(basename "$migration_dir")"
  sql_file="${migration_dir}migration.sql"
  [ -f "$sql_file" ] || continue

  if ! matches="$(data_rewriting_statements "$sql_file")"; then
    fail "check-data-migration-verification: cannot tokenise ${sql_file} (unterminated dollar-quoted string) — refusing to classify it."
    continue
  fi
  [ -n "$matches" ] || continue

  classified+=("$migration_name")

  fixture="$(fixture_path_for "$migration_name")"
  if [ -f "$fixture" ]; then
    if is_grandfathered "$migration_name"; then
      fail "Data-migration verification FAILED: ${migration_name} has a fixture AND a grandfather row." \
        "Delete its line from ${grandfather_file} and drop EXPECTED_GRANDFATHERED_COUNT by one."
    fi
    continue
  fi

  if is_grandfathered "$migration_name"; then
    continue
  fi

  fail "Data-migration verification FAILED: ${migration_name} rewrites existing data but ships no verification fixture." \
    "It runs statements that can only touch rows a club already has:" \
    "$(printf '%s\n' "$matches" | head -n 3 | sed 's/^/    /')" \
    "Add ${DATA_MIGRATION_VERIFICATION_DIR#"${REPO_ROOT}/"}/${migration_name}.ts (see docs/BLUE_GREEN_MIGRATION_POLICY.md" \
    "-> 'Data-migration verification'), register it in that directory's index.ts, and CI will" \
    "seed the pre-state, run this migration for real, and assert the rows."
done

# ---------------------------------------------------------------------------
# 2. The grandfather list stays honest: pinned size, no stale rows.
# ---------------------------------------------------------------------------
if [ "$GRANDFATHERED_COUNT" != "$EXPECTED_GRANDFATHERED_COUNT" ]; then
  fail "Data-migration verification FAILED: the grandfathered list holds ${GRANDFATHERED_COUNT} entries, expected ${EXPECTED_GRANDFATHERED_COUNT}." \
    "Adding a name means a data-rewriting migration ships UNVERIFIED — say why in the PR and bump" \
    "EXPECTED_GRANDFATHERED_COUNT in the same commit. Removing one (by writing its fixture) drops the number."
fi

for grandfathered in "${GRANDFATHERED_UNVERIFIED_DATA_MIGRATIONS[@]}"; do
  # A new data-rewriting migration cannot be grandfathered: the list enumerates
  # historical debt, it is not an exemption a fresh migration can append itself to
  # (#2418, R7). The prefix is the 14-digit timestamp before the first '_'.
  grandfather_prefix="${grandfathered%%_*}"
  if [[ "$grandfather_prefix" > "$GATE_INTRODUCED_PREFIX" || "$grandfather_prefix" == "$GATE_INTRODUCED_PREFIX" ]]; then
    fail "Data-migration verification FAILED: ${grandfathered} was authored on or after the gate (${GATE_INTRODUCED_PREFIX}) and cannot be grandfathered." \
      "The grandfather list only enumerates migrations that shipped BEFORE this gate. A new data-rewriting migration must ship a verification fixture — write ${DATA_MIGRATION_VERIFICATION_DIR#"${REPO_ROOT}/"}/${grandfathered}.ts instead."
    continue
  fi
  if [ ! -d "${MIGRATIONS_DIR}/${grandfathered}" ]; then
    fail "Data-migration verification FAILED: grandfathered migration ${grandfathered} does not exist." \
      "Remove the stale line from ${grandfather_file}."
    continue
  fi
  found=0
  for name in "${classified[@]}"; do
    [ "$name" = "$grandfathered" ] && found=1 && break
  done
  if [ "$found" = "0" ]; then
    fail "Data-migration verification FAILED: grandfathered migration ${grandfathered} no longer classifies as data-rewriting." \
      "Either the classifier regressed or the row is stale — remove it and drop EXPECTED_GRANDFATHERED_COUNT."
  fi
done

# ---------------------------------------------------------------------------
# 3. Every fixture names a real migration and is registered for execution.
#
# A fixture the runner never imports is coverage that does not exist — the exact
# failure mode #2418 was filed about — so an unregistered fixture fails here
# rather than sitting green and unrun.
# ---------------------------------------------------------------------------
registry="${DATA_MIGRATION_VERIFICATION_DIR}/index.ts"
if [ ! -f "$registry" ]; then
  fail "Data-migration verification FAILED: fixture registry not found at ${registry}."
else
  registry_source="$(cat "$registry")"
  for fixture_file in "$DATA_MIGRATION_VERIFICATION_DIR"/*.ts; do
    [ -f "$fixture_file" ] || continue
    fixture_name="$(basename "$fixture_file" .ts)"
    # Fixtures are named after the migration they verify, so they always begin
    # with its 14-digit timestamp. Anything else in this directory (the registry,
    # the shared types, the statement splitter) is support code, not a fixture.
    # A name-shaped file that matches no migration still fails below.
    [[ "$fixture_name" =~ ^[0-9]{14}_ ]] || continue

    if [ ! -d "${MIGRATIONS_DIR}/${fixture_name}" ]; then
      fail "Data-migration verification FAILED: fixture ${fixture_file} names no migration." \
        "Fixture files are named exactly after the migration directory they verify."
    fi

    if ! grep -qF "\"./${fixture_name}\"" <<<"$registry_source"; then
      fail "Data-migration verification FAILED: fixture ${fixture_name} is not registered in ${registry}." \
        "An unimported fixture never runs. Add it to the registry."
    fi

    if ! grep -qF "migration: \"${fixture_name}\"" "$fixture_file"; then
      fail "Data-migration verification FAILED: fixture ${fixture_file} does not declare migration: \"${fixture_name}\"." \
        "The declared name is what the runner reads migration.sql from; it must match the file name."
    fi
  done
fi

if [ "$failures" = "0" ]; then
  echo "Data-migration verification coverage passed: ${#classified[@]} data-rewriting migration(s), ${GRANDFATHERED_COUNT} grandfathered." >&2
fi

exit "$failures"
