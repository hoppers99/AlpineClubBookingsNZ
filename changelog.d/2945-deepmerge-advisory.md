- **A security advisory in a Prisma dependency stopped the test suite from
  running, and is now closed (#2945).** A high-severity advisory published on
  17 August affected a package Prisma depends on. The dependency audit runs
  early in CI and skips everything after it when it fails, so for a period the
  unit tests and the build were not running on any branch even though other
  checks reported green. The affected package is pinned to a fixed version,
  which required no change to Prisma itself, and a check now reports when the
  pin can be removed again.
