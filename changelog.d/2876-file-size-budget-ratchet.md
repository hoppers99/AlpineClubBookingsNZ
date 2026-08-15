- **The file-size budgets are now enforced, as a ratchet rather than a cliff
  (#2687).** The repository has documented size budgets for route handlers,
  page shells and domain modules, but nothing checked them — the report that
  was supposed to flag oversized files compared against a hand-maintained list
  of nine. At the initial baseline after `main` commit `aafbd08f3`, 281 of the
  1,903 production files were over budget and carried 131,709 lines of size
  debt. Three of the nine recorded line counts were wrong by two orders of
  magnitude, so the one artefact that looked like enforcement was the least
  accurate thing in the repository.

  Every over-budget file and its current line count is now recorded in
  `scripts/quality/file-size-baseline.txt`, and a check in the blocking CI job
  compares the tree against it. Existing debt is allowed to stay; what fails is
  a file that newly goes over budget, a file that grows past the line count
  recorded for it, or a baseline that is missing, out of date or hand-edited.
  Shrinking is always accepted, but the check reports the old ceiling as stale
  until the baseline is regenerated; that regeneration records the lower
  ceiling so the removed debt cannot quietly return.

  Nothing about the code itself changed, and no production file had to be
  altered to make the tree pass. For a contributor the practical effect is one
  command — `npm run quality:budget:update` — when a change legitimately moves
  a large file's size. That command is an intentional, review-visible escape,
  not a verification pass: a rename appears as removed and added ledger
  records, every pre-update regression is listed separately, and the net debt
  change is reported only as context. A larger shrink elsewhere therefore
  cannot hide the warning for a file that grew, and the pull request must
  explain every accepted increase. Update mode refuses a missing, malformed or
  untracked starting ledger, so it cannot rewrite away the comparison needed to
  produce those warnings. A contract also pins the public package command to
  the blocking `verify` job. The gate's TypeScript tests under
  `scripts/__tests__/` are now covered by `npm run typecheck` (#2875); existing
  JavaScript/MJS Vitest files are loaded by the test project but remain outside
  static `checkJs` analysis until #2693 converts that boundary.
