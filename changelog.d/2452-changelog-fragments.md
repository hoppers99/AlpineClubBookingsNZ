- **Changelog entries are now written as one small file per pull request, so
  parallel work stops colliding on `CHANGELOG.md` (#2452).** Every branch used to
  add its entry to the top of the same `## Unreleased` list, which meant any two
  branches open at once conflicted on that file — a conflict that had to be
  hand-resolved on almost every merge, day after day, and that occasionally cost
  an entry when the resolve went the wrong way.

  A pull request now drops its entry into a new file under `changelog.d/`,
  named after the pull request. New files never conflict with each other, so the
  merge is clean no matter how many branches are open. The entry itself is
  unchanged in form — the same plain-English bullet, in the same house style,
  which `changelog.d/README.md` documents with a worked example.

  At release time `node scripts/release/compile-changelog.mjs <version>` gathers
  every fragment into a real `## <version> - <date>` section at the top of
  `CHANGELOG.md`, deletes the fragments it used, and prints what it did. It also
  folds in any entry still written directly under `## Unreleased`, so nothing
  written the old way is lost. A `--dry-run` flag shows the plan without
  touching a file, and historical sections are never rewritten.

  Continuous integration now asks a pull request that changes application source
  for its entry: a fragment, or an explicit "no entry needed" marker in the pull
  request body for changes that genuinely have nothing to tell a reader.
  Documentation-only, test-only and workflow-only pull requests are not asked at
  all, exactly as before. While the change beds in, a pull request that still
  edits `CHANGELOG.md` directly is also accepted, so work opened before this
  landed is not failed by a rule it was never written against.
