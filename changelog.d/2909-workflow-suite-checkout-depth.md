- **Continuous integration now refuses a workflow that runs the test suite
  without the git history that suite needs (#2909).** Some of this project's
  tests read the repository's own commit history. A workflow that clones only
  the latest commit gives them nothing to read, and they fail with a raw git
  error that names nothing useful — so the failure looks like a bug in whatever
  change triggered it.

  That is not hypothetical: the nightly clock-rollover check ran the suite on a
  shallow clone while the main build did not, so a breakage passed every
  required check, merged, and turned the main branch red (#2907). Nothing then
  stopped the two settings drifting apart again, and nothing anybody could run —
  a pull-request check or a local test run — would have shown it.

  A new gate in the main build reads every workflow file, works out which jobs
  run the whole suite (including when the command is wrapped in something else,
  as the nightly check's is), and fails when such a job does not ask for full
  history. Jobs that run only a named handful of tests are left alone unless one
  of those tests actually reads the history.

  Nothing changes for anyone running the tests normally. Contributors editing a
  workflow can run the same check locally with `npm run ci:workflowcheck`.
