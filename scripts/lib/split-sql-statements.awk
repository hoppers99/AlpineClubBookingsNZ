# Reconstruct whole SQL statements from a migration file, one statement per
# output line.
#
# Shared by scripts/validate-blue-green-migrations.sh (session-clock DML gate,
# #1656 / #1627) and scripts/check-data-migration-verification.sh (data-rewrite
# classification, #2418). It lives in one file so the two gates can never
# disagree about what PostgreSQL will actually run — a classifier that split
# statements differently from the validator would quietly grade a different
# program than the one being deployed.
#
# Invoke as:
#   awk -v tool="<caller name>" -f scripts/lib/split-sql-statements.awk FILE
#
# The quote characters are defined in BEGIN rather than passed with -v: a `-v
# dq="` argument survives a POSIX shell but is mangled by Windows argv quoting
# when a Node test spawns awk directly, and the program is identical either way.
#
# The splitter tracks single-, double-, and dollar-quote state, strips "--" line
# comments and "/* */" block comments (nested, multi-line), and splits only on a
# ";" seen outside every quote and comment.
#
# Dollar-quote awareness (#2038): ARBITRARY dollar-quote tags are recognised —
# $$, $cms$, $previous$, $do$, etc. A ";" inside a $tag$...$tag$ body is NOT a
# split point, so a payload such as the starter PageContent HTML (whose
# &mdash;/&ndash; entities embed literal ";") stays a single statement. Tag
# matching follows Postgres rules: a tag is empty or [A-Za-z_][A-Za-z0-9_]* and
# cannot contain "$"; once a body opens with $a$ only a matching $a$ closes it
# (an inner $b$ is literal body text). Quotes inside a dollar body are literal
# (an apostrophe in "Stripe's" no longer toggles string state).
#
# An UNTERMINATED dollar-quote (no closing tag before EOF) fails LOUDLY: awk
# exits 2 and the caller must record a hard failure rather than silently passing
# an unparsed file.
#
# Block comments (#2418): "/* ... */" is skipped, including nested and multi-line
# ones, exactly as prisma/migration-verification/split-statements.ts does. A
# statement hidden behind a block-comment header — "/* repair */ UPDATE ..." — is
# therefore still surfaced with its true leading keyword, so neither gate can be
# blinded into grading a data-rewriting statement as shape-only by a comment
# style. A "--" or "/*" inside a quoted or dollar-quoted string is literal, not a
# comment.
#
# Limitations: a literal 'CURRENT_TIMESTAMP'/'UPDATE' inside a quoted string is
# not interpreted as SQL. Dollar-quoted bodies are emitted verbatim inside their
# enclosing statement, so a statement nested in a DO-block or function body is not
# surfaced as a statement of its own — callers that care (the data-rewrite
# classifier does) inspect the DO body themselves.

BEGIN {
  sq = "\047" # single quote
  dq = "\042" # double quote
  if (tool == "") tool = "split-sql-statements"
}

# If s[i] == "$", return the full "$...$" opening delimiter when a valid
# dollar-quote tag begins here, else "" (a bare literal "$", e.g. "$5.00", or a
# "$" that runs to end-of-line without a closing "$").
function dollar_open(s, i,   n, j, c, first) {
  n = length(s)
  j = i + 1
  first = 1
  while (j <= n) {
    c = substr(s, j, 1)
    if (c == "$") return substr(s, i, j - i + 1)
    if (first) {
      if (c ~ /[A-Za-z_]/) { first = 0; j++; continue }
      return ""
    }
    if (c ~ /[A-Za-z0-9_]/) { j++; continue }
    return ""
  }
  return ""
}

function flush() {
  if (stmt ~ /[^[:space:]]/) print stmt
  stmt = ""
}

{
  line = $0
  n = length(line)
  i = 1
  while (i <= n) {
    if (in_block > 0) {
      # Inside a (possibly nested, multi-line) "/* */" comment: consume until the
      # matching close, tracking nesting the way PostgreSQL does. Comment bytes are
      # dropped, never added to the statement.
      if (substr(line, i, 2) == "*/") { in_block--; i += 2; continue }
      if (substr(line, i, 2) == "/*") { in_block++; i += 2; continue }
      i++; continue
    }
    if (in_dollar) {
      tlen = length(dollar_tag)
      if (substr(line, i, tlen) == dollar_tag) {
        stmt = stmt dollar_tag; in_dollar = 0; i += tlen; continue
      }
      stmt = stmt substr(line, i, 1); i++; continue
    }
    c = substr(line, i, 1)
    if (in_s) {
      stmt = stmt c
      if (c == sq) in_s = 0
      i++; continue
    }
    if (in_d) {
      stmt = stmt c
      if (c == dq) in_d = 0
      i++; continue
    }
    if (c == "$") {
      dt = dollar_open(line, i)
      if (dt != "") {
        stmt = stmt dt; in_dollar = 1; dollar_tag = dt; i += length(dt); continue
      }
      stmt = stmt c; i++; continue
    }
    if (c == sq) { in_s = 1; stmt = stmt c; i++; continue }
    if (c == dq) { in_d = 1; stmt = stmt c; i++; continue }
    if (c == "-" && substr(line, i + 1, 1) == "-") { break }
    if (c == "/" && substr(line, i + 1, 1) == "*") { in_block = 1; i += 2; continue }
    if (c == ";") { flush(); i++; continue }
    stmt = stmt c
    i++
  }
  stmt = stmt " "
}

END {
  if (in_dollar) {
    printf "%s: unterminated dollar-quoted string %s in %s\n", tool, dollar_tag, FILENAME > "/dev/stderr"
    exit 2
  }
  flush()
}
