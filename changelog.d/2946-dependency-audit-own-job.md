- **A security advisory in a third-party package can no longer stop the test
  suite from running (#2946).** The automated checks that guard every change to
  this system used to run the dependency security audit first, in the same batch
  as everything else. When that audit failed, the rest of the batch — the code
  checks, the type checks, the entire test suite and the production build —
  never ran at all.

  That happened for real on 17 August 2026. A security advisory was published
  for a package this system uses indirectly, nobody here changed anything, and
  for a day the checklist on every proposed change read "one dependency thing is
  red, everything else passed". Everything else had not passed. It had not run.
  When the audit was cleared, the very first genuine run of the test suite
  immediately found a fault that had been building up behind the silence.

  The dependency audit is now its own separate check, so an advisory turns that
  one check red and every other check still runs and still reports its real
  result. The audit continues to **block** a change from being merged: a new
  advisory is a decision a person should make — upgrade, work around, or
  knowingly accept — rather than a warning nobody reads.

  This needs one action from the repository owner after it ships: the new
  `Dependency audit` check must be added to the protected-branch settings, in
  that order. Until it is, a failing audit shows as a red check but does not
  itself block a merge. `AGENTS.md` records the exact order and the command that
  reads back the live configuration.
