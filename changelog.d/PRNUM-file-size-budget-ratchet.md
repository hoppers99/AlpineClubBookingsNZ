- **The file-size budgets are now enforced, as a ratchet rather than a cliff
  (#2687).** The repository has documented size budgets for route handlers,
  page shells and domain modules, but nothing checked them — the report that
  was supposed to flag oversized files compared against a hand-maintained list
  of nine, while 281 of the 1,901 production files were actually over budget.
  Three of the nine recorded line counts were wrong by two orders of magnitude,
  so the one artefact that looked like enforcement was the least accurate thing
  in the repository.

  Every over-budget file and its current line count is now recorded in
  `scripts/quality/file-size-baseline.txt`, and a check in the blocking CI job
  compares the tree against it. Existing debt is allowed to stay; what fails is
  a file that newly goes over budget, a file that grows past the line count
  recorded for it, or a baseline that is missing, out of date or hand-edited.
  Shrinking a file always passes and lowers its ceiling, so the position can
  only improve.

  Nothing about the code itself changed, and no production file had to be
  altered to make the tree pass. For a contributor the practical effect is one
  command — `npm run quality:budget:update` — when a change legitimately moves
  a large file's size, and a line in the pull request explaining any increase.
